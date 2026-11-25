import { realpathSync } from 'node:fs';
import type { Claim, WorkTask } from '@arena/shared';
import type { AgentAdapter } from './adapters/types.js';
import { fallbackResult, parseAgentResult, type AgentResult } from './result.js';
import type { SessionStore } from './session-store.js';
import type { WorkClient } from './work-client.js';

export interface RunnerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
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
}

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

/**
 * The deterministic supervisor: one wait, at most one task execution, then
 * submit. It never decides what the task means; that belongs inside the agent
 * CLI session.
 */
export class Runner {
  constructor(
    private readonly work: WorkApi,
    private readonly adapter: AgentAdapter,
    private readonly sessions: SessionStore,
    private readonly workspace: string,
    private readonly logger: RunnerLogger = console,
  ) {}

  /** Wait once and handle exactly one work-domain event. */
  async runOnce(options: RunnerOptions): Promise<RunOnceOutcome> {
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
        this.logger.error(`[runner] 轮询或执行失败：${error instanceof Error ? error.message : String(error)}`);
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

  private async execute(task: WorkTask, claim: Claim, signal?: AbortSignal): Promise<void> {
    const workspace = realpathSync(task.workspace);
    if (workspace !== this.workspace) {
      const result = fallbackResult(
        '',
        `runner 工作区（${this.workspace}）与任务工作区（${workspace}）不一致，未执行。`,
      );
      await this.submitWithRetry(task.id, claim.round, claim.id, result);
      this.sessions.markSubmitted(task.id, claim.round, 'workspace mismatch');
      return;
    }

    const existing = this.sessions.get(task.id, claim.round);
    if (existing?.claimId === claim.id && existing.status === 'submitted') {
      this.logger.warn(`任务 ${task.id} 第 ${claim.round} 轮已提交，跳过重复执行。`);
      return;
    }
    if (existing?.claimId === claim.id && existing.status === 'running') {
      this.logger.warn(`任务 ${task.id} 第 ${claim.round} 轮已有运行记录（session ${existing.sessionId ?? '未知'}），跳过重复执行；如进程已退出请等待 P3 的恢复流程。`);
      return;
    }

    if (!this.sessions.begin({ taskId: task.id, round: claim.round, claimId: claim.id })) {
      this.logger.warn(`任务 ${task.id} 第 ${claim.round} 轮已记录，跳过重复执行。`);
      return;
    }

    this.logger.info(`领取任务 ${task.id}「${task.title}」第 ${claim.round} 轮。`);
    const resumeSessionId = this.sessions.latestSessionForTask(task.id);
    const renewal = setInterval(() => {
      void this.work.renewClaim(task.id, claim.round, claim.id)
        .then((value) => this.logger.info(`任务 ${task.id} 租约续到 ${new Date(value.expiresAt).toISOString()}。`))
        .catch((error) => this.logger.warn(`任务 ${task.id} 租约续期失败：${error instanceof Error ? error.message : String(error)}`));
    }, Math.max(1_000, Math.floor((claim.expiresAt - Date.now()) / 2)));
    renewal.unref();
    let result: AgentResult;
    try {
      const run = await this.adapter.run(task, {
        ...(signal === undefined ? {} : { signal }),
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
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
      result = fallbackResult('', `runner 执行 DSH 失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearInterval(renewal);
    }

    try {
      await this.submitWithRetry(task.id, claim.round, claim.id, result);
      this.sessions.markSubmitted(task.id, claim.round);
      this.logger.info(`任务 ${task.id} 第 ${claim.round} 轮结果已提交。`);
    } catch (error) {
      this.sessions.markFailed(task.id, claim.round, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** A short retry covers a transient MCP/HTTP failure before P3 adds a durable outbox. */
  private async submitWithRetry(taskId: string, round: number, claimId: string, result: AgentResult): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.work.submitResult(taskId, round, claimId, result);
        return;
      } catch (error) {
        lastError = error;
        if (attempt === 3) break;
        this.logger.warn(`任务 ${taskId} 第 ${round} 轮提交失败（第 ${attempt} 次），2 秒后重试：${error instanceof Error ? error.message : String(error)}`);
        await sleep(2_000);
      }
    }
    throw lastError;
  }
}
