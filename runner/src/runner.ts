import { realpathSync } from 'node:fs';
import type { Claim, RunnerEventLevel, RunnerTaskRef, WorkTask } from '@arena/shared';
import type { AgentAdapter } from './adapters/types.js';
import { fallbackResult, parseAgentResult, type AgentResult } from './result.js';
import type { SessionRecord, SessionStore } from './session-store.js';
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

/**
 * The deterministic supervisor: one wait, at most one task execution, then
 * submit. It never decides what the task means; that belongs inside the agent
 * CLI session.
 */
export class Runner {
  private activeTask: RunnerTaskRef | null = null;
  private activeController: AbortController | undefined;

  constructor(
    private readonly work: WorkApi,
    private readonly adapter: AgentAdapter,
    private readonly sessions: SessionStore,
    private readonly workspace: string,
    private readonly logger: RunnerLogger = console,
    private readonly events?: RunnerEvents,
  ) {}

  /** The task shown by the runner registry while DSH is executing. */
  currentTask(): RunnerTaskRef | null {
    return this.activeTask;
  }

  /** Abort the current DSH process; returns false when nothing is running. */
  cancelCurrent(): boolean {
    if (!this.activeController) return false;
    this.activeController.abort();
    return true;
  }

  /** Wait once and handle exactly one work-domain event. */
  async runOnce(options: RunnerOptions): Promise<RunOnceOutcome> {
    await this.settlePending(options.signal);
    const wait = await this.work.waitForWork(options.waitTimeoutMs, options.signal);
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
      if (outcome === 'assigned' || outcome === 'acknowledged' || outcome === 'timeout') continue;
      if (outcome !== 'finished') {
        this.logger.info(`[runner] 工作域状态：${outcome}，继续等待。`);
        await sleep(5_000, options.signal);
      }
    }
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
    try {
      await this.work.submitResult(taskId, round, claimId, record.result);
      this.sessions.markSubmitted(taskId, round);
      this.logger.info(`任务 ${taskId} 第 ${round} 轮结果已提交。`);
    } catch (error) {
      await this.onHandInError(record, error);
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
    // A lost worker identity is not a verdict on the result; it is retried
    // like a connection failure. Any other answer from the server counts.
    if (error instanceof WorkClientError && error.code !== 'IDENTITY_REQUIRED') {
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
   * A round another process left `running`. The server decides: with the claim
   * still standing the round continues in its own session; otherwise it is
   * recorded as interrupted and reported for a person to continue or cancel.
   */
  private async recover(record: SessionRecord, signal?: AbortSignal): Promise<void> {
    const what = `任务 ${record.taskId} 第 ${record.round} 轮`;
    const session = record.sessionId ?? '未知';
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

  private async execute(task: WorkTask, claim: Claim, signal?: AbortSignal): Promise<void> {
    const workspace = realpathSync(task.workspace);
    const handIn = { taskId: task.id, round: claim.round, claimId: claim.id };
    if (workspace !== this.workspace) {
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
      if (existing.status === 'running' && existing.instanceId === this.sessions.instanceId) {
        this.logger.warn(`任务 ${task.id} 第 ${claim.round} 轮已在执行，跳过重复执行。`);
        return;
      }
    }
    // A round another process left running under this very claim continues
    // here, in the session that process recorded.
    const resume = existing?.claimId === claim.id && existing.status === 'running';
    const resumeSessionId = resume && existing.sessionId !== undefined
      ? existing.sessionId
      : this.sessions.latestSessionForTask(task.id);
    if (!this.sessions.begin(handIn, { resume })) {
      this.logger.warn(`任务 ${task.id} 第 ${claim.round} 轮已记录，跳过重复执行。`);
      return;
    }

    this.logger.info(`任务 ${task.id}「${task.title}」第 ${claim.round} 轮${resume ? '续跑' : ''}。`);
    this.activeTask = { id: task.id, title: task.title, status: 'working', round: claim.round, startedAt: Date.now() };
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
    try {
      const run = await this.adapter.run(task, {
        signal: controller.signal,
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        ...(resume ? { preamble: RESUME_PREAMBLE } : {}),
        onSessionId: (sessionId) => {
          this.sessions.setSessionId(task.id, claim.round, sessionId);
          this.logger.info(`任务 ${task.id} 的 DSH 会话：${sessionId}`);
        },
      });
      const parsed = parseAgentResult(run.text);
      result = parsed.ok ? parsed.value : fallbackResult(run.text, parsed.reason);
      const failure: string[] = [];
      if (run.exitCode !== 0) failure.push(`DSH 退出码 ${run.exitCode}`);
      if (run.reasonKind !== 'completed') failure.push(`DSH 最终状态 ${run.reasonKind ?? '未知'}`);
      const stderrTail = run.stderr.trim().slice(-1_000);
      if (stderrTail) failure.push(`DSH stderr：${stderrTail}`);
      if (failure.length > 0) {
        result = {
          ...result,
          unresolved: [result.unresolved, ...failure].filter((item): item is string => Boolean(item)).join('；').slice(0, 2000),
        };
      }
    } catch (error) {
      result = fallbackResult('', `runner 执行 DSH 失败：${reasonOf(error)}`);
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      this.activeController = undefined;
      this.activeTask = null;
      clearInterval(renewal);
    }

    await this.handIn(handIn, result);
  }

  /** Keep the result on disk first, then hand it in; it stays until the server has it. */
  private async handIn(input: Pick<SessionRecord, 'taskId' | 'round' | 'claimId'>, result: AgentResult): Promise<void> {
    // False only when the record already exists, which is fine here.
    this.sessions.begin(input);
    const record = this.sessions.setResult(input.taskId, input.round, result);
    if (record !== undefined) await this.flush(record);
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
