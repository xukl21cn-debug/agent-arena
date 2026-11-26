import { realpathSync } from 'node:fs';
import type { Claim, RunnerEventLevel, RunnerTaskRef, WorkTask } from '@arena/shared';
import type { AgentAdapter } from './adapters/types.js';
import { fallbackResult, parseAgentResult, type AgentResult } from './result.js';
import type { SessionRecord, SessionStore } from './session-store.js';
import type { ReapOutcome } from './orphan.js';
import { WorkClientError } from './work-client.js';

export interface RunnerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Where the runner reports what happens to a round: the registry's event log. */
export interface RunnerEvents {
  emit(level: RunnerEventLevel, message: string, taskId?: string): Promise<void>;
}

export interface RunnerOptions {
  waitTimeoutMs: number;
  signal?: AbortSignal;
}

export type RunOnceOutcome =
  | 'assigned'
  | 'acknowledged'
  | 'timeout'
  | 'in_progress'
  | 'finished'
  | 'done'
  | 'cancelled'
  | 'needs_attention'
  | string;

interface WorkApi {
  waitForWork(timeoutMs: number, signal?: AbortSignal): Promise<{
    reason: string;
    task?: WorkTask;
    claim?: Claim;
    hint?: string;
  }>;
  submitResult(taskId: string, round: number, claimId: string, result: AgentResult): Promise<WorkTask>;
  renewClaim(taskId: string, round: number, claimId: string): Promise<{ expiresAt: number }>;
  acknowledge(taskId: string, round: number): Promise<WorkTask>;
  getTask(taskId: string): Promise<WorkTask>;
}

/** How many times the server may reject a result before the runner stops retrying. */
const MAX_REJECTIONS = 5;

/**
 * Answers from the server that say nothing about the result itself. A lost
 * identity or a role held by someone else is retried like a connection
 * failure; counting them would mark a good result as rejected while the
 * server is unreachable for the runner in particular.
 */
const NOT_A_VERDICT: ReadonlySet<string> = new Set(['IDENTITY_REQUIRED', 'ROLE_TAKEN']);

/** Quick tries for one hand-in while the server cannot be reached at all. */
const HAND_IN_ATTEMPTS = 3;

/** Prepended when a round continues after the process running it was killed. */
export const RESUME_PREAMBLE =
  '上一次执行在途中被中断，工作区可能留有未完成的改动。先查看当前状态（例如 git status 和相关文件），确认哪些已经完成，再继续完成下面的任务。';

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) { resolve(); return; }
  const timer = setTimeout(done, ms);
  const onAbort = () => done();
  function done() {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }
  signal?.addEventListener('abort', onAbort, { once: true });
});

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export type CancelOutcome = 'cancelled' | 'idle' | 'other-task';

/**
 * Apply a cancel command from the registry to what the runner is executing
 * now. A command names the task it was meant for: one queued while the runner
 * was offline belongs to that task and must not stop a different task the
 * runner has picked up since.
 */
export function cancelCurrentTask(runner: Runner, taskId?: string): CancelOutcome {
  const current = runner.currentTask();
  if (current === null) return 'idle';
  if (taskId !== undefined && current.id !== taskId) return 'other-task';
  return runner.cancelCurrent() ? 'cancelled' : 'idle';
}

/** What the runner may report and do beyond running rounds; all of it optional. */
export interface RunnerHooks {
  logger?: RunnerLogger;
  /** Where the runner reports what happens to a round: the registry's event log. */
  events?: RunnerEvents;
  /**
   * Ends an agent process a killed runner left behind, and says what became of
   * it. Without it a surviving agent is left running.
   */
  reap?: (pid: number) => Promise<ReapOutcome>;
  /** Called with the task the runner starts or stops executing, null when it stops. */
  onTaskChange?: (task: RunnerTaskRef | null) => void;
  /** Pause between the quick tries of one hand-in. */
  retryDelayMs?: number;
  /** Pause between polls while the work domain has nothing to hand out. */
  pauseMs?: number;
}

/**
 * The deterministic supervisor: one wait, at most one task execution, then
 * submit. It never decides what the task means; that belongs inside the agent
 * CLI session.
 */
export class Runner {
  private activeTask: RunnerTaskRef | null = null;
  private activeController: AbortController | undefined;
  /** Set by `cancelCurrent`, so a round ended by a cancel is not mistaken for one that failed. */
  private cancelRequested = false;
  /** The task the last poll was about; `needs_attention` names the task the board waits on. */
  private waitedTaskId: string | null = null;
  /** The task already reported as blocking the board; one event per task, not one per poll. */
  private blockedOn: string | null | undefined;
  private readonly logger: RunnerLogger;
  private readonly events: RunnerEvents | undefined;
  private readonly reap: ((pid: number) => Promise<ReapOutcome>) | undefined;
  private readonly onTaskChange: ((task: RunnerTaskRef | null) => void) | undefined;
  private readonly retryDelayMs: number;
  private readonly pauseMs: number;

  constructor(
    private readonly work: WorkApi,
    private readonly adapter: AgentAdapter,
    private readonly sessions: SessionStore,
    private readonly workspace: string,
    hooks: RunnerHooks = {},
  ) {
    this.logger = hooks.logger ?? console;
    this.events = hooks.events;
    this.reap = hooks.reap;
    this.onTaskChange = hooks.onTaskChange;
    this.retryDelayMs = hooks.retryDelayMs ?? 2_000;
    this.pauseMs = hooks.pauseMs ?? 5_000;
  }

  /** The task shown by the runner registry while DSH is executing. */
  currentTask(): RunnerTaskRef | null {
    return this.activeTask;
  }

  private useTask(task: RunnerTaskRef | null): void {
    this.activeTask = task;
    this.onTaskChange?.(task);
  }

  /** Abort the current DSH process; returns false when nothing is running. */
  cancelCurrent(): boolean {
    if (!this.activeController) return false;
    this.cancelRequested = true;
    this.activeController.abort();
    return true;
  }

  /** Wait once and handle exactly one work-domain event. */
  async runOnce(options: RunnerOptions): Promise<RunOnceOutcome> {
    await this.settlePending(options.signal);
    const wait = await this.work.waitForWork(options.waitTimeoutMs, options.signal);
    this.waitedTaskId = wait.task?.id ?? null;
    if (wait.reason === 'assigned') {
      if (!wait.task || !wait.claim) throw new Error('工作域返回 assigned 但没有 task/claim。');
      await this.execute(wait.task, wait.claim, options.signal);
      return 'assigned';
    }
    if (wait.reason === 'finished') {
      if (!wait.task) throw new Error('工作域返回 finished 但没有 task。');
      await this.work.acknowledge(wait.task.id, wait.task.activeRound);
      this.logger.info(`任务 ${wait.task.id} 已确认收工。`);
      return 'acknowledged';
    }
    return wait.reason;
  }

  /** Keep the runner resident; a timeout is just another poll. */
  async runLoop(options: RunnerOptions): Promise<void> {
    while (!options.signal?.aborted) {
      let outcome: RunOnceOutcome;
      try {
        outcome = await this.runOnce(options);
      } catch (error) {
        this.logger.error(`[runner] 轮询或执行失败：${reasonOf(error)}`);
        await sleep(5_000, options.signal);
        continue;
      }
      if (outcome === 'assigned' || outcome === 'acknowledged' || outcome === 'timeout') {
        this.blockedOn = undefined;
        continue;
      }
      if (outcome !== 'finished') {
        if (outcome === 'needs_attention') await this.reportBlocked();
        else this.blockedOn = undefined;
        this.logger.info(`[runner] 工作域状态：${outcome}，继续等待。`);
        await sleep(this.pauseMs, options.signal);
      }
    }
  }

  /** Say once per task that the board is waiting on a person; every poll would repeat it. */
  private async reportBlocked(): Promise<void> {
    const taskId = this.waitedTaskId;
    if (this.blockedOn === taskId) return;
    this.blockedOn = taskId;
    await this.report(
      'warn',
      taskId === null ? '有任务待接管，暂停领取新任务。' : `任务 ${taskId} 待接管，暂停领取新任务。`,
      taskId ?? undefined,
    );
  }

  /**
   * Finish what an earlier pass, or an earlier process, left open before
   * taking on anything new: hand in every waiting result, then decide each
   * round that another process left running.
   */
  private async settlePending(signal?: AbortSignal): Promise<void> {
    for (const record of this.sessions.pendingSubmissions()) {
      await this.flush(record);
      if (signal?.aborted) return;
    }
    for (const record of this.sessions.orphans()) {
      await this.recover(record, signal);
      if (signal?.aborted) return;
    }
  }

  /** Hand one waiting result to the server; a failure leaves it waiting. */
  private async flush(record: SessionRecord): Promise<void> {
    const { taskId, round, claimId } = record;
    if (record.result === undefined) {
      // `setResult` never produces this; a hand-edited state file could.
      this.sessions.markInterrupted(taskId, round, '本地记录缺少执行结果。');
      return;
    }
    // An unreachable server gets a few quick tries before the result waits for
    // the next pass: a server that has just restarted resets the first request
    // on the old connection, and the very next attempt already reaches it.
    // Anything the server answered is final for this pass and handled at once.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.work.submitResult(taskId, round, claimId, record.result);
        this.sessions.markSubmitted(taskId, round);
        this.logger.info(`任务 ${taskId} 第 ${round} 轮结果已提交。`);
        return;
      } catch (error) {
        if (error instanceof WorkClientError || attempt >= HAND_IN_ATTEMPTS) {
          await this.onHandInError(record, error);
          return;
        }
        this.logger.warn(`任务 ${taskId} 第 ${round} 轮提交失败（第 ${attempt} 次），${this.retryDelayMs / 1000} 秒后重试：${reasonOf(error)}`);
        await sleep(this.retryDelayMs);
      }
    }
  }

  private async onHandInError(record: SessionRecord, error: unknown): Promise<void> {
    const what = `任务 ${record.taskId} 第 ${record.round} 轮`;
    const reason = reasonOf(error);
    if (error instanceof WorkClientError && error.code === 'CLAIM_INACTIVE') {
      this.sessions.markAbandoned(record.taskId, record.round, reason);
      this.logger.warn(`${what}的结果不再提交：${reason}`);
      await this.report('info', `${what}的结果不再提交：${reason}`, record.taskId);
      return;
    }
    // A lost identity or a held role is not a verdict on the result; it is
    // retried like a connection failure. Any other answer from the server counts.
    if (error instanceof WorkClientError && !NOT_A_VERDICT.has(error.code)) {
      const rejections = this.sessions.countRejection(record.taskId, record.round);
      if (rejections >= MAX_REJECTIONS) {
        this.sessions.markFailed(record.taskId, record.round, reason);
        this.logger.error(`${what}的回报被服务端拒绝 ${rejections} 次，不再重试：${reason}`);
        await this.report('error', `${what}的回报被服务端拒绝 ${rejections} 次，已停止重试：${reason}`, record.taskId);
        return;
      }
    }
    this.logger.warn(`${what}提交失败，稍后重试：${reason}`);
  }

  /**
   * A round another process left `running`. First the agent that process
   * started is ended if it is still running, whatever the server says: nobody
   * holds its claim any more, and resuming on top of it would put two agents
   * on one working tree. Then the server decides: with the claim still
   * standing the round continues in its own session; otherwise it is recorded
   * as interrupted and reported for a person to continue or cancel.
   */
  private async recover(record: SessionRecord, signal?: AbortSignal): Promise<void> {
    const what = `任务 ${record.taskId} 第 ${record.round} 轮`;
    const session = record.sessionId ?? '未知';
    await this.reapOrphan(record);
    let task: WorkTask;
    try {
      task = await this.work.getTask(record.taskId);
    } catch (error) {
      if (error instanceof WorkClientError && error.code === 'TASK_NOT_FOUND') {
        this.sessions.markInterrupted(record.taskId, record.round, '服务端已无此任务。');
        this.logger.warn(`${what}上次执行被中断，服务端已无此任务。`);
        return;
      }
      // Not answered yet (server down, or the worker identity is gone): ask again next pass.
      this.logger.warn(`${what}上次执行被中断，暂无法向服务端核对，稍后重试：${reasonOf(error)}`);
      return;
    }
    const claim = task.rounds[record.round - 1]?.workClaim;
    if (task.status === 'working' && task.activeRound === record.round && claim?.id === record.claimId) {
      this.logger.warn(`${what}上次执行被中断（会话 ${session}），认领仍有效，续跑。`);
      await this.report('warn', `${what}上次执行被中断，用原会话续跑。`, record.taskId);
      await this.execute(task, claim, signal);
      return;
    }
    this.sessions.markInterrupted(record.taskId, record.round, `服务端状态 ${task.status}`);
    this.logger.warn(`${what}上次执行被中断，服务端当前为「${task.status}」，等待人工继续或取消。`);
    await this.report(
      'warn',
      `${what}在执行中被中断（会话 ${session}），服务端当前为「${task.status}」，等待人工继续或取消。`,
      record.taskId,
    );
  }

  private async reapOrphan(record: SessionRecord): Promise<void> {
    const pid = record.agentPid;
    if (this.reap === undefined || pid === undefined) return;
    let outcome: ReapOutcome;
    try {
      outcome = await this.reap(pid);
    } catch (error) {
      // Not knowing is not a reason to stop: say so and carry on.
      this.logger.warn(`任务 ${record.taskId} 第 ${record.round} 轮：无法确认上一个 DSH 进程是否还在（${reasonOf(error)}），照常处理。`);
      return;
    }
    if (outcome !== 'killed') return;
    this.logger.warn(`任务 ${record.taskId} 第 ${record.round} 轮：上一个 runner 被终止时留下的 DSH 进程（pid ${pid}）还在运行，已先结束它。`);
    await this.report('warn', `任务 ${record.taskId} 第 ${record.round} 轮：上一个 runner 被终止时留下的 DSH 进程（pid ${pid}）还在运行，已先结束它。`, record.taskId);
  }

  private async execute(task: WorkTask, claim: Claim, signal?: AbortSignal): Promise<void> {
    const workspace = realpathSync(task.workspace);
    const handIn = { taskId: task.id, round: claim.round, claimId: claim.id };
    if (workspace !== this.workspace) {
      await this.report('error', `任务 ${task.id} 第 ${claim.round} 轮未执行：runner 工作区与任务工作区不一致。`, task.id);
      await this.handIn(
        handIn,
        fallbackResult('', `runner 工作区（${this.workspace}）与任务工作区（${workspace}）不一致，未执行。`),
      );
      return;
    }

    const existing = this.sessions.get(task.id, claim.round);
    if (existing?.claimId === claim.id) {
      if (existing.status === 'submitted') {
        this.logger.warn(`任务 ${task.id} 第 ${claim.round} 轮已提交，跳过重复执行。`);
        return;
      }
      if (existing.status === 'submitting') {
        this.logger.warn(`任务 ${task.id} 第 ${claim.round} 轮的结果尚待提交，跳过重复执行。`);
        return;
      }
    }
    // A round another process left running under this very claim continues
    // here, in the session that process recorded. A round this process is
    // already running is not started again: `begin` refuses to hand it over.
    const resume = existing?.claimId === claim.id && existing.status === 'running';
    // So does a fresh claim on a round whose earlier attempt was cut short or
    // never heard back: the agent is told either way.
    const continuing = !resume && existing !== undefined
      && ['interrupted', 'abandoned', 'failed'].includes(existing.status);
    const resumeSessionId = resume && existing.sessionId !== undefined
      ? existing.sessionId
      : this.sessions.latestSessionForTask(task.id);
    if (!this.sessions.begin(handIn, { resume })) {
      this.logger.warn(`任务 ${task.id} 第 ${claim.round} 轮已记录，跳过重复执行。`);
      return;
    }

    this.logger.info(`任务 ${task.id}「${task.title}」第 ${claim.round} 轮${resume ? '续跑' : ''}。`);
    // A resume was reported by the recovery that decided on it.
    if (!resume) {
      await this.report(
        'info',
        continuing
          ? `任务 ${task.id} 第 ${claim.round} 轮继续执行（上一次尝试未完成）。`
          : `领取任务「${task.title}」第 ${claim.round} 轮。`,
        task.id,
      );
    }
    this.cancelRequested = false;
    this.useTask({ id: task.id, title: task.title, status: 'working', round: claim.round, startedAt: Date.now() });
    this.activeController = new AbortController();
    const controller = this.activeController;
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const renewal = setInterval(() => {
      void this.work.renewClaim(task.id, claim.round, claim.id)
        .then((value) => this.logger.info(`任务 ${task.id} 租约续到 ${new Date(value.expiresAt).toISOString()}。`))
        .catch((error) => this.logger.warn(`任务 ${task.id} 租约续期失败：${reasonOf(error)}`));
    }, Math.max(1_000, Math.floor((claim.expiresAt - Date.now()) / 2)));
    renewal.unref();
    let result: AgentResult;
    let reasonKind: string | null = null;
    let failure: string[] = [];
    try {
      const run = await this.adapter.run(task, {
        signal: controller.signal,
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        ...(resume || continuing ? { preamble: RESUME_PREAMBLE } : {}),
        onPid: (pid) => {
          this.sessions.setAgentPid(task.id, claim.round, pid);
        },
        onSessionId: (sessionId) => {
          this.sessions.setSessionId(task.id, claim.round, sessionId);
          this.logger.info(`任务 ${task.id} 的 DSH 会话：${sessionId}`);
          void this.report('info', `任务 ${task.id} 的 DSH 会话：${sessionId}`, task.id);
        },
      });
      reasonKind = run.reasonKind;
      if (run.exitCode !== 0) failure.push(`DSH 退出码 ${run.exitCode}`);
      if (run.reasonKind !== 'completed') failure.push(`DSH 最终状态 ${run.reasonKind ?? '未知'}`);
      const stderrTail = run.stderr.trim().slice(-1_000);
      if (stderrTail) failure.push(`DSH stderr：${stderrTail}`);
      const parsed = parseAgentResult(run.text);
      result = parsed.ok ? parsed.value : fallbackResult(run.text, parsed.reason);
      if (failure.length > 0) {
        result = {
          ...result,
          unresolved: [result.unresolved, ...failure].filter((item): item is string => Boolean(item)).join('；').slice(0, 2000),
        };
      }
    } catch (error) {
      failure = [`runner 执行 DSH 失败：${reasonOf(error)}`];
      result = fallbackResult('', failure[0]!);
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      this.activeController = undefined;
      this.useTask(null);
      clearInterval(renewal);
    }

    await this.reportOutcome(task.id, claim.round, reasonKind, failure);

    await this.handIn(handIn, result);
  }

  /** Keep the result on disk first, then hand it in; it stays until the server has it. */
  private async handIn(input: Pick<SessionRecord, 'taskId' | 'round' | 'claimId'>, result: AgentResult): Promise<void> {
    // False only when the record already exists, which is fine here.
    this.sessions.begin(input);
    const record = this.sessions.setResult(input.taskId, input.round, result);
    if (record !== undefined) await this.flush(record);
  }

  /**
   * Tell the registry how a round ended. A cancel and a shutdown both end the
   * DSH process; the runner's own record of having asked is what tells them
   * apart.
   */
  private async reportOutcome(taskId: string, round: number, reasonKind: string | null, failure: string[]): Promise<void> {
    const what = `任务 ${taskId} 第 ${round} 轮`;
    if (this.cancelRequested) {
      await this.report('warn', `${what}被取消，已终止执行。`, taskId);
      return;
    }
    if (reasonKind === 'timeout') {
      await this.report('warn', `${what}超时，已终止；未完成的部分写在了回报里。`, taskId);
      return;
    }
    if (failure.length > 0) {
      await this.report('error', `${what}执行失败：${failure.join('；').slice(0, 500)}`, taskId);
      return;
    }
    await this.report('info', `${what}执行完成。`, taskId);
  }

  private async report(level: RunnerEventLevel, message: string, taskId?: string): Promise<void> {
    if (!this.events) return;
    try {
      await this.events.emit(level, message, taskId);
    } catch (error) {
      this.logger.warn(`[runner] 事件上报失败：${reasonOf(error)}`);
    }
  }
}
