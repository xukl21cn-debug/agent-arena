import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const deliveryResultSchema = z.object({
  sessionId: z.string().min(1).max(200),
  text: z.string().min(1).max(32_000),
});
export const workRequestSchema = z.object({
  requestId: z.string().min(1).max(200),
  prompt: z.string().min(1).max(12_000),
  branch: z.string().min(1).max(240),
  base: z.string().regex(/^(?:[\da-f]{40}|[\da-f]{64})$/i),
});

const claimSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['work', 'review']),
  expiresAt: z.number().int().nonnegative(),
});
const completionSchema = z.object({
  claimId: z.uuid(),
  result: deliveryResultSchema,
});
const taskSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  createdAt: z.number().int().nonnegative(),
  request: workRequestSchema,
  codexSession: z.string(),
  workerSession: z.string(),
  workspace: z.string(),
  status: z.enum(['queued', 'working', 'pending_review', 'reviewing', 'done', 'needs_attention', 'cancelled']),
  claim: claimSchema.optional(),
  work: completionSchema.optional(),
  review: completionSchema.optional(),
  issue: z.string().optional(),
});

type Request = z.infer<typeof workRequestSchema>;
type Task = z.infer<typeof taskSchema>;
type Claim = z.infer<typeof claimSchema>;
type DeliveryResult = z.infer<typeof deliveryResultSchema>;
export type WorkBinding = Pick<Task, 'codexSession' | 'workerSession' | 'workspace'>;

export class WorkError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class WorkStore {
  private readonly tasks = new Map<string, Task>();
  private readonly directory: string;

  constructor(
    dataDir: string,
    readonly binding: WorkBinding,
    private readonly leaseMs = 60_000,
  ) {
    this.directory = path.join(dataDir, 'work');
    mkdirSync(this.directory, { recursive: true });
    for (const file of readdirSync(this.directory)) {
      if (!file.endsWith('.json')) continue;
      const task = taskSchema.parse(JSON.parse(readFileSync(path.join(this.directory, file), 'utf8')));
      if (file !== `${task.id}.json`) throw new Error(`Invalid work task filename: ${file}`);
      this.tasks.set(task.id, task);
    }
  }

  private save(task: Task): Task {
    // A task and both of its deliveries are one record. A successful report
    // and the new review queue entry become visible together.
    const file = path.join(this.directory, `${task.id}.json`);
    const temp = `${file}.tmp`;
    const fd = openSync(temp, 'w');
    try {
      writeFileSync(fd, JSON.stringify(task), 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    this.tasks.set(task.id, task);
    return task;
  }

  private matchesBinding(task: Task): boolean {
    return task.codexSession === this.binding.codexSession
      && task.workerSession === this.binding.workerSession
      && task.workspace === this.binding.workspace;
  }

  private settle(task: Task, now: number): Task {
    if (!task.claim || task.claim.expiresAt > now || task.status === 'needs_attention') return task;
    return this.save({
      ...task,
      status: 'needs_attention',
      issue: '接力租约已到期。确认原执行状态后再取消任务。',
    });
  }

  get(id: string, now = Date.now()): Task {
    const task = this.tasks.get(id);
    if (!task || !this.matchesBinding(task)) throw new WorkError('TASK_NOT_FOUND', '找不到该任务。');
    return this.settle(task, now);
  }

  create(request: Request, now = Date.now()): Task {
    for (const task of this.tasks.values()) {
      if (task.request.requestId !== request.requestId || !this.matchesBinding(task)) continue;
      const same = task.request.prompt === request.prompt
        && task.request.branch === request.branch && task.request.base === request.base;
      if (!same) throw new WorkError('REQUEST_CONFLICT', '同一请求编号已用于不同的任务。');
      return this.settle(task, now);
    }
    return this.save({
      ...this.binding,
      version: 1,
      id: randomUUID(),
      createdAt: now,
      request,
      status: 'queued',
    });
  }

  claimNext(requestId?: string, now = Date.now()): { task: Task | null; blockedBy: string | null } {
    const tasks = Array.from(this.tasks.values())
      .filter((task) => task.workspace === this.binding.workspace)
      .map((task) => this.settle(task, now));
    const blocked = tasks.find((task) => ['working', 'reviewing', 'needs_attention'].includes(task.status));
    if (blocked) return { task: null, blockedBy: blocked.id };
    const next = tasks.filter((task) => this.matchesBinding(task)
      && (requestId === undefined || requestId === task.request.requestId)
      && (task.status === 'queued' || task.status === 'pending_review'))
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!next) return { task: null, blockedBy: null };
    const kind = next.status === 'queued' ? 'work' : 'review';
    const task = this.save({
      ...next,
      status: kind === 'work' ? 'working' : 'reviewing',
      claim: { id: randomUUID(), kind, expiresAt: now + this.leaseMs },
    });
    return { task, blockedBy: null };
  }

  private activeClaim(task: Task, claimId: string): Claim {
    if (!task.claim || task.claim.id !== claimId || task.status === 'needs_attention') {
      throw new WorkError('CLAIM_INACTIVE', '接力租约已失效。');
    }
    return task.claim;
  }

  renew(id: string, claimId: string, now = Date.now()): { expiresAt: number } {
    const task = this.get(id, now);
    const claim = this.activeClaim(task, claimId);
    const expiresAt = now + this.leaseMs;
    this.save({ ...task, claim: { ...claim, expiresAt } });
    return { expiresAt };
  }

  complete(id: string, claimId: string, result: DeliveryResult, now = Date.now()): Task {
    const task = this.get(id, now);
    const recorded = [task.work, task.review].find((entry) => entry?.claimId === claimId);
    if (recorded) {
      if (recorded.result.sessionId === result.sessionId && recorded.result.text === result.text) return task;
      throw new WorkError('RESULT_CONFLICT', '接力结果已保存，收到的内容不一致。');
    }
    const claim = this.activeClaim(task, claimId);
    const sessionId = claim.kind === 'work' ? task.workerSession : task.codexSession;
    if (sessionId !== result.sessionId) {
      throw new WorkError('SESSION_MISMATCH', '返回结果的会话与派单记录不符。');
    }
    const completion = { claimId, result };
    return this.save(claim.kind === 'work'
      ? { ...task, work: completion, claim: undefined, status: 'pending_review' }
      : { ...task, review: completion, claim: undefined, status: 'done' });
  }

  flag(id: string, claimId: string, reason: string): Task {
    const task = this.get(id);
    this.activeClaim(task, claimId);
    return this.save({ ...task, status: 'needs_attention', issue: reason });
  }

  cancel(id: string): Task {
    const task = this.get(id);
    if (!['queued', 'pending_review', 'needs_attention', 'cancelled'].includes(task.status)) {
      throw new WorkError('TASK_ACTIVE', '当前任务仍在执行。');
    }
    return this.save({ ...task, claim: undefined, status: 'cancelled' });
  }
}
