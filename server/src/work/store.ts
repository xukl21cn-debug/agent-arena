import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Claim, WorkParticipant, WorkRole, WorkRound, WorkTask, WorkTaskSummary } from '@arena/shared';
import { resolveArtifact, taskSchema, WorkError, type ClaimInput, type CreateInput, type MergeInput, type ResultInput, type ReviewInput } from './model.js';

type Identity = WorkParticipant & { role: WorkRole };
export const HUMAN_COORDINATOR_ID = 'w_human_0';
const HUMAN_COORDINATOR_NAME = '看板用户';
const humanActor: Identity = { id: HUMAN_COORDINATOR_ID, name: HUMAN_COORDINATOR_NAME, role: 'coordinator' };
type Operation = ClaimInput & { kind: Claim['kind'] };
type WaitReason = 'assigned' | 'in_progress' | 'review_requested' | 'reviewing' | 'finished'
  | 'pending_merge_approval' | 'merge_approved' | 'needs_attention' | 'cancelled' | 'done' | 'timeout';
type WaitResult = { reason: WaitReason; task?: WorkTask; claim?: Claim };
interface WaitOptions {
  taskId?: string;
  afterStatus?: WorkTask['status'];
  timeoutMs: number;
  signal?: AbortSignal;
  connected?: () => boolean;
}

const activeRound = (task: WorkTask): WorkRound => task.rounds[task.activeRound - 1]!;
const isTerminal = (task: WorkTask): boolean => task.status === 'done' || task.status === 'cancelled';
const ownsTask = (task: WorkTask, actor: Identity): boolean => task[actor.role].id === actor.id;
const claimKey = (kind: Claim['kind']): 'workClaim' | 'reviewClaim' => kind === 'work' ? 'workClaim' : 'reviewClaim';

export class WorkStore {
  private readonly tasks = new Map<string, WorkTask>();
  private readonly roles = new Map<WorkRole, { actor: Identity; sessions: Set<string> }>();
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<(task: WorkTask) => void>();
  private readonly directory: string;
  private wakeScheduled = false;
  readonly workspace: string;

  constructor(dataDir: string, workspace: string, private readonly ttlMs: number, private readonly now = Date.now) {
    this.workspace = realpathSync(workspace);
    this.directory = path.join(dataDir, 'work');
    mkdirSync(this.directory, { recursive: true });
    for (const file of readdirSync(this.directory)) {
      if (!file.endsWith('.json')) continue;
      try {
        const task = taskSchema.parse(JSON.parse(readFileSync(path.join(this.directory, file), 'utf8')));
        if (file !== task.id + '.json' || task.workspace !== this.workspace) throw new Error('任务文件或工作区不匹配');
        this.tasks.set(task.id, task);
      } catch {
        console.warn('[work] 跳过旧版或无效任务文件', file);
      }
    }
    for (const task of this.tasks.values()) {
      if (task.status === 'merge_approved') {
        this.attention(task, '服务重启前未登记合并结果。请核对 Git 状态后处理。');
      }
    }
  }

  subscribe(listener: (task: WorkTask) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private wakeAll(): void {
    if (this.wakeScheduled) return;
    this.wakeScheduled = true;
    queueMicrotask(() => {
      this.wakeScheduled = false;
      for (const notify of [...this.waiters]) notify();
    });
  }

  private save(task: WorkTask): WorkTask {
    const updated = { ...task, updatedAt: Math.max(task.updatedAt + 1, this.now()) };
    const file = path.join(this.directory, task.id + '.json');
    if (!this.tasks.has(task.id) && existsSync(file)) throw new Error('Task file already exists');
    const temp = file + '.tmp';
    const fd = openSync(temp, 'w');
    try {
      writeFileSync(fd, JSON.stringify(updated), 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    this.tasks.set(task.id, updated);
    this.wakeAll();
    for (const listener of this.listeners) {
      try { listener(updated); }
      catch (error) { console.error('[work] 任务订阅处理失败', error); }
    }
    return updated;
  }

  join(role: WorkRole, name: string, sessionId: string): Identity {
    const occupied = this.roles.get(role);
    if (occupied && occupied.actor.name !== name) {
      throw new WorkError('ROLE_TAKEN', '这个角色已被占用。', '使用原名字重连，或请当前持有者离开。');
    }
    const previous = this.actorFor(sessionId);
    if (previous && previous.role !== role) throw new WorkError('ROLE_TAKEN', '同一会话只能担任一个角色。');
    if (occupied) {
      occupied.sessions.add(sessionId);
      return occupied.actor;
    }
    const id = 'w_' + createHash('sha256').update(role + ':' + name).digest('hex').slice(0, 12);
    const actor = { id, name, role };
    this.roles.set(role, { actor, sessions: new Set([sessionId]) });
    return actor;
  }

  actorFor(sessionId: string): Identity | undefined {
    return [...this.roles.values()].find((entry) => entry.sessions.has(sessionId))?.actor;
  }

  leave(actor: Identity, sessionId: string, disconnected = false): void {
    const entry = this.roles.get(actor.role);
    if (!entry?.sessions.has(sessionId) || entry.actor.id !== actor.id) return;
    this.sweep();
    if (entry.sessions.size === 1) {
      const isActive = (task: WorkTask) => ownsTask(task, actor) && (
        actor.role === 'worker' ? task.status === 'working'
          : task.status === 'reviewing' || task.status === 'merge_approved'
      );
      const active = [...this.tasks.values()].find(isActive);
      if (active && !disconnected) throw new WorkError('TASK_ACTIVE', '当前仍有执行或合并在进行。', '请先完成任务或由用户接管。');
      if (active) this.attention(active, '执行期间会话已关闭。');
    }
    entry.sessions.delete(sessionId);
    if (entry.sessions.size === 0) this.roles.delete(actor.role);
    this.wakeAll();
  }

  private requireRole(actor: Identity, role: WorkRole): void {
    if (actor.role !== role) throw new WorkError(role === 'worker' ? 'NOT_WORKER' : 'NOT_COORDINATOR', '当前角色不能执行此操作。');
  }

  get(taskId: string, actor?: Identity): WorkTask {
    const task = this.tasks.get(taskId);
    if (!task || (actor && !ownsTask(task, actor))) throw new WorkError('TASK_NOT_FOUND', '找不到该任务。');
    return this.settle(task);
  }

  list(): WorkTaskSummary[] {
    this.sweep();
    return [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      activeRound: task.activeRound,
      branch: task.branch,
      coordinatorName: task.coordinator.name,
      workerName: task.worker.name,
      updatedAt: task.updatedAt,
    }));
  }

  create(actor: Identity, input: CreateInput): WorkTask {
    this.requireRole(actor, 'coordinator');
    const existing = [...this.tasks.values()].find((task) => ownsTask(task, actor) && task.requestId === input.requestId);
    // A retry must not reread documents that could have been edited after dispatch.
    if (existing) {
      const { docs, ...request } = input;
      const { requestId, title, requirement, branch, base, acceptance } = existing;
      const sameDocs = docs.length === existing.docs.length && docs.every((doc, index) => {
        const saved = existing.docs[index]!;
        return isDeepStrictEqual({ ...doc, hash: doc.hash?.toLowerCase() ?? saved.hash }, saved);
      });
      if (sameDocs && isDeepStrictEqual(request, { requestId, title, requirement, branch, base, acceptance })) return this.settle(existing);
      throw new WorkError('REQUEST_CONFLICT', '同一请求号已用于不同内容。');
    }
    const worker = this.roles.get('worker')?.actor;
    if (!worker) throw new WorkError('IDENTITY_REQUIRED', '执行者尚未加入。', '请让执行者调用 join_work。');
    if (!input.docs.some((doc) => doc.kind === 'brief')) throw new WorkError('INVALID_ARTIFACT', '任务需要已确认的 brief 引用。');
    const now = this.now();
    return this.save({
      ...input, id: randomUUID(), version: 2, workspace: this.workspace, status: 'queued',
      docs: input.docs.map((doc) => resolveArtifact(this.workspace, doc)),
      coordinator: { id: actor.id, name: actor.name }, worker: { id: worker.id, name: worker.name },
      activeRound: 1, rounds: [{ round: 1, createdAt: now }], createdAt: now, updatedAt: now,
    });
  }

  /** Dispatch from the local work page; the human operator is the coordinator. */
  createForHuman(input: CreateInput): WorkTask {
    return this.create(humanActor, input);
  }

  /**
   * Human review from the work page. It claims the review internally because
   * the browser has no MCP session to hold a claim across two REST calls.
   */
  reviewForHuman(
    taskId: string,
    input: { decision: 'approve' | 'rework'; summary: string; findings?: string },
  ): WorkTask {
    const task = this.get(taskId);
    if (task.coordinator.id !== HUMAN_COORDINATOR_ID) {
      throw new WorkError('NOT_COORDINATOR', '该任务不是看板派发的任务，不能由看板复审。');
    }
    if (task.status !== 'pending_review') {
      throw new WorkError('INVALID_STATE', '任务当前不在待复审状态。');
    }
    if (input.decision === 'rework' && !input.findings?.trim()) {
      throw new WorkError('INVALID_REQUEST', '要求返工时请填写具体意见。');
    }
    const claim: Claim = {
      id: randomUUID(),
      kind: 'review',
      round: task.activeRound,
      expiresAt: this.now() + this.ttlMs,
    };
    const claimed = this.updateRound(task, { ...activeRound(task), reviewClaim: claim }, 'reviewing');
    const doc = claimed.docs[0]!;
    return this.submitReview(humanActor, {
      taskId,
      round: claimed.activeRound,
      claimId: claim.id,
      decision: input.decision,
      summary: input.summary,
      ...(input.findings === undefined ? {} : { findings: input.findings }),
      doc: { kind: 'review', path: doc.path, summary: input.summary.slice(0, 500) },
    });
  }

  private updateRound(task: WorkTask, round: WorkRound, status = task.status): WorkTask {
    return this.save({ ...task, status, rounds: [...task.rounds.slice(0, -1), round] });
  }

  private attention(task: WorkTask, issue: string): WorkTask {
    const round = { ...activeRound(task), workClaim: undefined, reviewClaim: undefined };
    return this.save({ ...task, issue, status: 'needs_attention', rounds: [...task.rounds.slice(0, -1), round] });
  }

  private settle(task: WorkTask): WorkTask {
    const round = activeRound(task);
    const claim = round.workClaim ?? round.reviewClaim;
    if (!claim || claim.expiresAt > this.now()) return task;
    return this.attention(task, '领取租约已过期。请确认现场后处理。');
  }

  sweep(): void {
    for (const task of this.tasks.values()) this.settle(task);
  }

  private claim(task: WorkTask, kind: Claim['kind']): WaitResult {
    const claim: Claim = { id: randomUUID(), kind, round: task.activeRound, expiresAt: this.now() + this.ttlMs };
    const delivered = this.updateRound(task, { ...activeRound(task), [claimKey(kind)]: claim }, kind === 'work' ? 'working' : 'reviewing');
    return { reason: kind === 'work' ? 'assigned' : 'review_requested', task: delivered, claim };
  }

  private observe(task: WorkTask, actor: Identity, afterStatus?: WorkTask['status']): WaitResult | undefined {
    if (task.status === afterStatus) return;
    switch (task.status) {
      case 'done':
      case 'cancelled':
      case 'needs_attention':
        return { reason: task.status, task };
      case 'working':
        if (actor.role === 'worker') return { reason: 'in_progress', task, claim: activeRound(task).workClaim };
        return;
      case 'reviewing':
        if (actor.role === 'coordinator') return { reason: 'reviewing', task, claim: activeRound(task).reviewClaim };
        return;
      case 'pending_ack':
        if (actor.role === 'worker') return { reason: 'finished', task };
        return;
      case 'pending_merge_approval':
      case 'merge_approved':
        if (actor.role === 'coordinator') return { reason: task.status, task };
    }
  }

  private next(actor: Identity, options: WaitOptions): WaitResult | undefined {
    if (options.signal?.aborted) return { reason: 'timeout' };
    if (options.connected?.() === false) return { reason: 'cancelled' };
    if (options.taskId) return this.observe(this.get(options.taskId, actor), actor, options.afterStatus);
    this.sweep();
    // Hold the checkout throughout review and merge, including uncertain outcomes.
    const tasks = [...this.tasks.values()];
    const active = tasks.find((task) => !isTerminal(task) && !['queued', 'needs_attention'].includes(task.status))
      ?? tasks.find((task) => task.status === 'needs_attention');
    if (active) {
      if (!ownsTask(active, actor)) return;
      if (actor.role === 'coordinator' && active.status === 'pending_review') return this.claim(active, 'review');
      if (actor.role === 'worker' && active.status === 'rework_requested') return this.claim(active, 'work');
      return this.observe(active, actor, options.afterStatus);
    }
    if (actor.role === 'worker') {
      const next = tasks.filter((task) => ownsTask(task, actor) && task.status === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (next) return this.claim(next, 'work');
    }
  }

  async wait(actor: Identity, options: WaitOptions): Promise<WaitResult> {
    const immediate = this.next(actor, options);
    if (immediate) return immediate;
    return new Promise((resolve, reject) => {
      const clear = () => {
        clearTimeout(timer);
        this.waiters.delete(notify);
        options.signal?.removeEventListener('abort', expire);
      };
      const expire = () => { clear(); resolve({ reason: 'timeout' }); };
      const notify = () => {
        try {
          const next = this.next(actor, options);
          if (next) { clear(); resolve(next); }
        } catch (error) {
          clear();
          reject(error);
        }
      };
      const timer = setTimeout(expire, options.timeoutMs);
      this.waiters.add(notify);
      options.signal?.addEventListener('abort', expire, { once: true });
    });
  }

  private requireClaim(task: WorkTask, input: Operation): Claim {
    const round = activeRound(task);
    const claim = round[claimKey(input.kind)];
    const status = input.kind === 'work' ? 'working' : 'reviewing';
    if (task.status !== status || input.round !== task.activeRound || claim?.id !== input.claimId) {
      throw new WorkError('CLAIM_INACTIVE', '领取租约已失效。', '查看任务当前轮次和状态。');
    }
    return claim;
  }

  renew(actor: Identity, input: ClaimInput): { expiresAt: number } {
    const task = this.get(input.taskId, actor);
    const kind = actor.role === 'worker' ? 'work' : 'review';
    const claim = this.requireClaim(task, { ...input, kind });
    const updated = { ...claim, expiresAt: this.now() + this.ttlMs };
    this.updateRound(task, { ...activeRound(task), [claimKey(kind)]: updated });
    return { expiresAt: updated.expiresAt };
  }

  submitWork(actor: Identity, input: ClaimInput, result: ResultInput): WorkTask {
    this.requireRole(actor, 'worker');
    const task = this.get(input.taskId, actor);
    const previous = task.rounds[input.round - 1]?.work;
    if (previous?.claimId === input.claimId) {
      const { claimId, submittedAt, docs, ...saved } = previous;
      const { docs: submitted, ...fields } = result;
      if (isDeepStrictEqual(fields, saved) && sameArtifacts(submitted, docs)) return task;
      throw new WorkError('REQUEST_CONFLICT', '这一轮已有不同的执行回报。');
    }
    this.requireClaim(task, { ...input, kind: 'work' });
    if (!result.commits.length && !result.unresolved) throw new WorkError('INVALID_REQUEST', '没有提交时请写明阻碍。');
    const work = {
      ...result, claimId: input.claimId, submittedAt: this.now(),
      docs: result.docs.map((doc) => resolveArtifact(this.workspace, doc)),
    };
    return this.updateRound(task, { ...activeRound(task), work, workClaim: undefined }, 'pending_review');
  }

  submitReview(actor: Identity, input: ReviewInput): WorkTask {
    this.requireRole(actor, 'coordinator');
    const task = this.get(input.taskId, actor);
    const { taskId, round, claimId, doc, ...fields } = input;
    const previous = task.rounds[round - 1]?.review;
    if (previous?.claimId === claimId) {
      const { claimId: _id, reviewedAt, doc: savedDoc, ...saved } = previous;
      if (isDeepStrictEqual(fields, saved) && sameArtifacts([doc], [savedDoc])) return task;
      throw new WorkError('REQUEST_CONFLICT', '这一轮已有不同的复审结论。');
    }
    this.requireClaim(task, { ...input, kind: 'review' });
    if (doc.kind !== 'review') throw new WorkError('INVALID_ARTIFACT', '复审需要 review 类型的文档。');
    if (fields.decision === 'rework' && !fields.findings) throw new WorkError('INVALID_REQUEST', '请填写返工意见。');
    if (fields.decision === 'approve' && !activeRound(task).work?.commits.length) {
      throw new WorkError('INVALID_STATE', '这一轮没有可合并的提交。');
    }
    const review = { ...fields, claimId, doc: resolveArtifact(this.workspace, doc), reviewedAt: this.now() };
    const reviewed = { ...activeRound(task), review, reviewClaim: undefined };
    if (fields.decision === 'approve') return this.updateRound(task, reviewed, 'pending_ack');
    const next = { round: task.activeRound + 1, createdAt: this.now() };
    return this.save({
      ...task, status: 'rework_requested', activeRound: next.round,
      rounds: [...task.rounds.slice(0, -1), reviewed, next],
    });
  }

  acknowledge(actor: Identity, taskId: string, round: number): WorkTask {
    this.requireRole(actor, 'worker');
    const task = this.get(taskId, actor);
    if (round !== task.activeRound) throw new WorkError('INVALID_STATE', '确认的轮次不匹配。');
    if (task.acknowledgedAt !== undefined) return task;
    if (task.status !== 'pending_ack') throw new WorkError('INVALID_STATE', '当前状态不能确认收工。');
    return this.save({ ...task, acknowledgedAt: this.now(), status: 'pending_merge_approval' });
  }

  approveMerge(taskId: string): WorkTask {
    const task = this.get(taskId);
    if (task.approvedAt !== undefined) return task;
    if (task.status !== 'pending_merge_approval') throw new WorkError('INVALID_STATE', '需要先收到执行者的收工确认。');
    return this.save({ ...task, approvedAt: this.now(), status: 'merge_approved' });
  }

  recordMerge(actor: Identity, taskId: string, input: MergeInput): WorkTask {
    this.requireRole(actor, 'coordinator');
    const task = this.get(taskId, actor);
    if (task.merge) {
      const { approvedAt, recordedAt, ...saved } = task.merge;
      if (isDeepStrictEqual(saved, input)) return task;
      throw new WorkError('REQUEST_CONFLICT', '已有不同的合并记录。');
    }
    if (task.status !== 'merge_approved' || task.approvedAt === undefined) throw new WorkError('INVALID_STATE', '需要用户在看板放行合并。');
    if (input.outcome === 'success'
      && (!input.mergeCommit || !input.postMergeTests?.length || input.postMergeTests.some((entry) => entry.outcome !== 'passed'))) {
      throw new WorkError('INVALID_REQUEST', '成功记录需要合并提交和通过的合并后测试。');
    }
    const updated = { ...task, merge: { ...input, approvedAt: task.approvedAt, recordedAt: this.now() } };
    return input.outcome === 'success' ? this.save({ ...updated, status: 'done' })
      : this.attention(updated, input.note ?? '合并、测试或推送需要检查。');
  }

  takeover(taskId: string, reason: string): WorkTask {
    const task = this.get(taskId);
    if (isTerminal(task)) throw new WorkError('INVALID_STATE', '任务已结束。');
    return this.attention(task, reason);
  }

  cancel(actor: Identity, taskId: string, reason: string, force = false): WorkTask {
    this.requireRole(actor, 'coordinator');
    const task = this.get(taskId, actor);
    if (task.status === 'cancelled') return task;
    if (task.status === 'done') throw new WorkError('INVALID_STATE', '任务已完成。');
    if (['working', 'reviewing', 'merge_approved', 'needs_attention'].includes(task.status) && !force) {
      throw new WorkError('TASK_ACTIVE', '任务仍可能在执行。', '确认现场后强制取消，并记录原因。');
    }
    return this.updateRound({ ...task, issue: reason }, { ...activeRound(task), workClaim: undefined, reviewClaim: undefined }, 'cancelled');
  }
}

function sameArtifacts(
  input: Array<{ hash?: string }>,
  saved: Array<{ hash: string }>,
): boolean {
  return input.length === saved.length && input.every((entry, i) =>
    isDeepStrictEqual({ ...entry, hash: entry.hash?.toLowerCase() ?? saved[i]!.hash }, saved[i]));
}
