import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Claim, WorkTask } from '@arena/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DshHeadlessAdapter } from '../src/adapters/dsh.js';
import type { AgentAdapter, AgentRunResult } from '../src/adapters/types.js';
import { cancelCurrentTask, RESUME_PREAMBLE, Runner, type RunnerEvents } from '../src/runner.js';
import { SessionStore } from '../src/session-store.js';
import { WorkClientError, type WorkClient, type WorkWaitResult } from '../src/work-client.js';
import type { AgentResult } from '../src/result.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url));

let dir: string;
let store: SessionStore;
const originalMode = process.env.FAKE_DSH_MODE;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-runner-loop-'));
  store = new SessionStore(path.join(dir, 'state.json'));
  delete process.env.FAKE_DSH_MODE;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalMode === undefined) delete process.env.FAKE_DSH_MODE;
  else process.env.FAKE_DSH_MODE = originalMode;
});

function task(): WorkTask {
  return {
    version: 2,
    id: 'task-1',
    requestId: 'req-1',
    workspace: dir,
    title: 'Runner fake',
    requirement: 'Do the thing.',
    branch: 'feat/probe',
    base: 'a'.repeat(40),
    acceptance: ['Result reaches the work board'],
    docs: [],
    status: 'working',
    coordinator: { id: 'c', name: 'coordinator' },
    worker: { id: 'w', name: 'runner' },
    rounds: [{ round: 1, createdAt: 1 }],
    activeRound: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function claim(): Claim {
  return { id: 'claim-1', kind: 'work', round: 1, expiresAt: Date.now() + 60_000 };
}

const resultText = 'done\n```arena-result\n' + JSON.stringify({
  summary: '完成',
  files: ['a.txt'],
  commits: ['abcdef0'],
  tests: [],
  docs: [],
}) + '\n```';

class FakeWork {
  submits: Array<{ taskId: string; round: number; claimId: string; result: unknown }> = [];
  acked: Array<{ taskId: string; round: number }> = [];
  submitAttempts = 0;
  getTaskCalls = 0;
  waitCalls = 0;
  /** Successive answers to `getTask`; one is consumed per call. */
  taskViews: WorkTask[] = [];
  taskError: Error | undefined;
  /** When set, every hand-in attempt throws what it returns. */
  submitError: ((attempt: number) => Error) | undefined;

  constructor(public next: WorkWaitResult) {}

  async waitForWork(): Promise<WorkWaitResult> {
    this.waitCalls += 1;
    return this.next;
  }

  async submitResult(taskId: string, round: number, claimId: string, result: unknown): Promise<WorkTask> {
    this.submitAttempts += 1;
    const error = this.submitError?.(this.submitAttempts);
    if (error) throw error;
    this.submits.push({ taskId, round, claimId, result });
    return task();
  }

  async renewClaim(): Promise<{ expiresAt: number }> {
    return { expiresAt: Date.now() + 60_000 };
  }

  async acknowledge(taskId: string, round: number): Promise<WorkTask> {
    this.acked.push({ taskId, round });
    return task();
  }

  async getTask(taskId: string): Promise<WorkTask> {
    this.getTaskCalls += 1;
    if (this.taskError) throw this.taskError;
    const view = this.taskViews.shift();
    if (!view) throw new Error(`unexpected getTask(${taskId})`);
    return view;
  }
}

const adapter = (impl: (task: WorkTask, options?: { resumeSessionId?: string; preamble?: string }) => Promise<AgentRunResult>): AgentAdapter => ({ run: impl });

const stateFile = (): string => path.join(dir, 'state.json');

/** Leave the state file as a killed runner process would: a round still `running` under its claim. */
function leftRunningByAnotherProcess(claimId: string, sessionId: string): void {
  const dead = new SessionStore(stateFile(), Date.now, 'dead-process');
  dead.begin({ taskId: 'task-1', round: 1, claimId });
  dead.setSessionId('task-1', 1, sessionId);
  store = new SessionStore(stateFile(), Date.now, 'live-process');
}

/** The task as the server shows it while a worker holds its claim. */
const working = (claim: Claim): WorkTask => ({ ...task(), rounds: [{ round: 1, createdAt: 1, workClaim: claim }] });

const quiet = { info(): void {}, warn(): void {}, error(): void {} };
const okRun = async (): Promise<AgentRunResult> => ({ text: resultText, reasonKind: 'completed', exitCode: 0, stderr: '' });
type Emitted = [level: string, message: string, taskId: string | undefined];
function recorder(): { events: Emitted[]; events2: RunnerEvents } {
  const events: Emitted[] = [];
  return { events, events2: { emit: async (level, message, taskId) => { events.push([level, message, taskId]); } } };
}

/** A round whose result is ready but was never taken by the server. */
function leftWaitingForServer(): AgentResult {
  const result: AgentResult = { summary: 'done', files: [], commits: [], tests: [], docs: [], unresolved: '受阻' };
  store.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' });
  store.setResult('task-1', 1, result);
  return result;
}

it('submits parsed evidence exactly once for an assigned task', async () => {
  const work = new FakeWork({ reason: 'assigned', task: task(), claim: claim() });
  let runs = 0;
  const runner = new Runner(
    work as unknown as WorkClient,
    adapter(async () => { runs += 1; return { text: resultText, reasonKind: 'completed', exitCode: 0, stderr: '' }; }),
    store,
    dir,
  );
  await runner.runOnce({ waitTimeoutMs: 10 });
  expect(runs).toBe(1);
  expect(work.submits).toHaveLength(1);
  expect(work.submits[0]?.result).toMatchObject({ commits: ['abcdef0'], files: ['a.txt'] });
  expect(store.get('task-1', 1)).toMatchObject({ status: 'submitted', claimId: 'claim-1' });
});

it('does not launch the adapter again after a round was submitted', async () => {
  store.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' });
  store.markSubmitted('task-1', 1);
  const work = new FakeWork({ reason: 'assigned', task: task(), claim: claim() });
  let runs = 0;
  const runner = new Runner(
    work as unknown as WorkClient,
    adapter(async () => { runs += 1; return { text: resultText, reasonKind: 'completed', exitCode: 0, stderr: '' }; }),
    store,
    dir,
  );
  await runner.runOnce({ waitTimeoutMs: 10 });
  expect(runs).toBe(0);
  expect(work.submits).toHaveLength(0);
});

it('submits an unresolved result when the final answer cannot be parsed', async () => {
  const work = new FakeWork({ reason: 'assigned', task: task(), claim: claim() });
  const runner = new Runner(
    work as unknown as WorkClient,
    adapter(async () => ({ text: 'plain answer', reasonKind: 'completed', exitCode: 0, stderr: '' })),
    store,
    dir,
  );
  await runner.runOnce({ waitTimeoutMs: 10 });
  expect(work.submits[0]?.result).toMatchObject({
    summary: 'plain answer',
    commits: [],
    unresolved: expect.stringContaining('arena-result'),
  });
});

it('acknowledges a finished task', async () => {
  const work = new FakeWork({ reason: 'finished', task: { ...task(), status: 'pending_ack' } });
  const runner = new Runner(
    work as unknown as WorkClient,
    adapter(async () => { throw new Error('must not run'); }),
    store,
    dir,
  );
  expect(await runner.runOnce({ waitTimeoutMs: 10 })).toBe('acknowledged');
  expect(work.acked).toEqual([{ taskId: 'task-1', round: 1 }]);
});

it('continues a rework round in the task\'s previous DSH session', async () => {
  store.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' });
  store.setSessionId('task-1', 1, 'session-round-1');
  store.markSubmitted('task-1', 1);
  const rework = {
    ...task(),
    activeRound: 2,
    rounds: [{ round: 1, createdAt: 1 }, { round: 2, createdAt: 2 }],
  };
  const work = new FakeWork({
    reason: 'assigned',
    task: rework,
    claim: { id: 'claim-2', kind: 'work', round: 2, expiresAt: Date.now() + 60_000 },
  });
  let resumed: string | undefined;
  const runner = new Runner(
    work as unknown as WorkClient,
    adapter(async (_task, options) => {
      resumed = options?.resumeSessionId;
      return { text: resultText, reasonKind: 'completed', exitCode: 0, stderr: '' };
    }),
    store,
    dir,
  );
  await runner.runOnce({ waitTimeoutMs: 10 });
  expect(resumed).toBe('session-round-1');
});

it('kills a hung DSH process on cancel and submits an unresolved result', async () => {
  process.env.FAKE_DSH_MODE = 'hang';
  const work = new FakeWork({ reason: 'assigned', task: task(), claim: claim() });
  const runner = new Runner(
    work as unknown as WorkClient,
    new DshHeadlessAdapter({
      command: process.execPath,
      argsPrefix: [fixture],
      profile: 'headless',
      permissionMode: null,
      approvalPolicy: null,
      extraDirs: [],
      timeoutMs: 60_000,
    }),
    store,
    dir,
  );
  const running = runner.runOnce({ waitTimeoutMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(runner.currentTask()).toMatchObject({ id: 'task-1', round: 1 });
  expect(runner.cancelCurrent()).toBe(true);
  await running;
  expect(runner.currentTask()).toBeNull();
  expect(work.submits).toHaveLength(1);
  expect(work.submits[0]?.result).toMatchObject({
    unresolved: expect.stringContaining('退出码'),
  });
  expect(store.get('task-1', 1)).toMatchObject({ status: 'submitted' });
});

it('does not start a round that is already running in this process', async () => {
  store.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' });
  const work = new FakeWork({ reason: 'assigned', task: working(claim()), claim: claim() });
  let runs = 0;
  const runner = new Runner(work as unknown as WorkClient, adapter(async () => { runs += 1; return okRun(); }), store, dir, { logger: quiet });
  await runner.runOnce({ waitTimeoutMs: 10 });
  expect(runs).toBe(0);
  expect(store.get('task-1', 1)?.status).toBe('running');
});

it('resumes a round another process left running while its claim still stands', async () => {
  leftRunningByAnotherProcess('claim-1', 'session-before-crash');
  const work = new FakeWork({ reason: 'timeout' });
  work.taskViews.push(working(claim()));
  const { events, events2 } = recorder();
  let seen: { resumeSessionId?: string; preamble?: string } = {};
  const runner = new Runner(
    work as unknown as WorkClient,
    adapter(async (_task, options) => {
      seen = { resumeSessionId: options?.resumeSessionId, preamble: options?.preamble };
      return okRun();
    }),
    store,
    dir,
    { logger: quiet, events: events2 },
  );
  await runner.runOnce({ waitTimeoutMs: 10 });
  // Same claim, same session, and the agent is told its last run was cut short.
  expect(seen).toEqual({ resumeSessionId: 'session-before-crash', preamble: RESUME_PREAMBLE });
  expect(work.submitAttempts).toBe(1);
  expect(work.submits[0]).toMatchObject({ taskId: 'task-1', round: 1, claimId: 'claim-1' });
  expect(store.get('task-1', 1)).toMatchObject({ status: 'submitted', sessionId: 'session-before-crash' });
  expect(store.orphans()).toEqual([]);
  // The resume was reported by the recovery; no second "claimed" for it.
  expect(events).toEqual([
    ['warn', expect.stringContaining('续跑'), 'task-1'],
    ['info', '任务 task-1 第 1 轮执行完成。', 'task-1'],
  ]);
});

it('marks an interrupted round and reports it once its claim is gone', async () => {
  leftRunningByAnotherProcess('claim-1', 'session-before-crash');
  const work = new FakeWork({ reason: 'needs_attention' });
  work.taskViews.push({ ...task(), status: 'needs_attention', issue: '领取租约已过期。' });
  const { events, events2 } = recorder();
  let runs = 0;
  const runner = new Runner(
    work as unknown as WorkClient,
    adapter(async () => { runs += 1; return okRun(); }),
    store,
    dir,
    { logger: quiet, events: events2 },
  );
  await runner.runOnce({ waitTimeoutMs: 10 });
  expect(runs).toBe(0);
  expect(work.submitAttempts).toBe(0);
  expect(store.get('task-1', 1)).toMatchObject({ status: 'interrupted', note: '服务端状态 needs_attention' });
  expect(events).toEqual([['warn', expect.stringContaining('在执行中被中断'), 'task-1']]);

  // Settled: the next pass neither asks the server again nor repeats the event.
  await runner.runOnce({ waitTimeoutMs: 10 });
  expect(work.getTaskCalls).toBe(1);
  expect(events).toHaveLength(1);
});

it('leaves an interrupted round alone until the server can be asked', async () => {
  leftRunningByAnotherProcess('claim-1', 'session-before-crash');
  const work = new FakeWork({ reason: 'timeout' });
  work.taskError = new WorkClientError('NETWORK_ERROR', '连不上');
  const { events, events2 } = recorder();
  let runs = 0;
  const runner = new Runner(
    work as unknown as WorkClient,
    adapter(async () => { runs += 1; return okRun(); }),
    store,
    dir,
    { logger: quiet, events: events2 },
  );
  await runner.runOnce({ waitTimeoutMs: 10 });
  expect(runs).toBe(0);
  expect(store.get('task-1', 1)).toMatchObject({ status: 'running', claimId: 'claim-1' });
  expect(store.orphans()).toHaveLength(1);
  expect(events).toEqual([]);
});

it('keeps a result the server could not take and hands it in on the next pass', async () => {
  const work = new FakeWork({ reason: 'assigned', task: working(claim()), claim: claim() });
  let runs = 0;
  work.submitError = () => new Error('fetch failed');
  await new Runner(work as unknown as WorkClient, adapter(async () => { runs += 1; return okRun(); }), store, dir, { logger: quiet, retryDelayMs: 1 })
    .runOnce({ waitTimeoutMs: 10 });
  // Three quick tries, then the result waits for the next pass.
  expect(runs).toBe(1);
  expect(work.submitAttempts).toBe(3);
  expect(store.get('task-1', 1)).toMatchObject({ status: 'submitting', claimId: 'claim-1' });

  // A restart in between neither loses the result nor runs the round again.
  const restarted = new SessionStore(stateFile(), Date.now, 'next-process');
  work.submitError = undefined;
  work.next = { reason: 'timeout' };
  await new Runner(work as unknown as WorkClient, adapter(async () => { runs += 1; return okRun(); }), restarted, dir, { logger: quiet, retryDelayMs: 1 })
    .runOnce({ waitTimeoutMs: 10 });
  expect(runs).toBe(1);
  expect(work.submitAttempts).toBe(4);
  expect(work.submits).toHaveLength(1);
  expect(restarted.get('task-1', 1)).toMatchObject({ status: 'submitted' });
});

it('retries a hand-in the server could not be reached for within the same pass', async () => {
  const work = new FakeWork({ reason: 'assigned', task: working(claim()), claim: claim() });
  // Unreachable once, as right after a server restart; reachable immediately after.
  work.submitError = (attempt) => (attempt === 1 ? new Error('fetch failed') : undefined);
  await new Runner(work as unknown as WorkClient, adapter(okRun), store, dir, { logger: quiet, retryDelayMs: 1 })
    .runOnce({ waitTimeoutMs: 10 });
  expect(work.submitAttempts).toBe(2);
  expect(work.submits).toHaveLength(1);
  expect(store.get('task-1', 1)).toMatchObject({ status: 'submitted' });
});

it('abandons a result the claim no longer accepts', async () => {
  const work = new FakeWork({ reason: 'assigned', task: working(claim()), claim: claim() });
  work.submitError = () => new WorkClientError('CLAIM_INACTIVE', '领取租约已失效。');
  const { events, events2 } = recorder();
  const runner = new Runner(work as unknown as WorkClient, adapter(okRun), store, dir, { logger: quiet, events: events2 });
  await runner.runOnce({ waitTimeoutMs: 10 });
  expect(store.get('task-1', 1)).toMatchObject({ status: 'abandoned', note: '领取租约已失效。' });
  expect(events).toEqual([
    ['info', '领取任务「Runner fake」第 1 轮。', 'task-1'],
    ['info', '任务 task-1 第 1 轮执行完成。', 'task-1'],
    ['info', expect.stringContaining('不再提交'), 'task-1'],
  ]);

  work.next = { reason: 'timeout' };
  await runner.runOnce({ waitTimeoutMs: 10 });
  expect(work.submitAttempts).toBe(1);
});

it('stops retrying a result the server keeps rejecting', async () => {
  leftWaitingForServer();
  const work = new FakeWork({ reason: 'timeout' });
  work.submitError = () => new WorkClientError('INVALID_REQUEST', '参数无效。');
  const { events, events2 } = recorder();
  const runner = new Runner(work as unknown as WorkClient, adapter(okRun), store, dir, { logger: quiet, events: events2 });
  for (let pass = 0; pass < 8; pass += 1) await runner.runOnce({ waitTimeoutMs: 10 });
  expect(work.submitAttempts).toBe(5);
  expect(store.get('task-1', 1)).toMatchObject({ status: 'failed', note: '参数无效。' });
  expect(events).toEqual([['error', expect.stringContaining('停止重试'), 'task-1']]);
});

it('does not take a lost worker identity as a verdict on the result', async () => {
  leftWaitingForServer();
  const work = new FakeWork({ reason: 'timeout' });
  work.submitError = () => new WorkClientError('IDENTITY_REQUIRED', '请先调用 join_work。');
  const { events, events2 } = recorder();
  const runner = new Runner(work as unknown as WorkClient, adapter(okRun), store, dir, { logger: quiet, events: events2 });
  for (let pass = 0; pass < 8; pass += 1) await runner.runOnce({ waitTimeoutMs: 10 });
  expect(work.submitAttempts).toBe(8);
  expect(store.get('task-1', 1)?.status).toBe('submitting');
  expect(events).toEqual([]);
});

it('ends the agent a killed runner left behind before the round is resumed', async () => {
  const dead = new SessionStore(stateFile(), Date.now, 'dead-process');
  dead.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' });
  dead.setSessionId('task-1', 1, 'session-before-crash');
  dead.setAgentPid('task-1', 1, 4242);
  store = new SessionStore(stateFile(), Date.now, 'live-process');
  const work = new FakeWork({ reason: 'timeout' });
  work.taskViews.push(working(claim()));
  const order: string[] = [];
  const { events, events2 } = recorder();
  const runner = new Runner(
    work as unknown as WorkClient,
    adapter(async () => { order.push('run'); return okRun(); }),
    store,
    dir,
    {
      logger: quiet,
      events: events2,
      reap: async (pid) => { order.push(`reap ${pid}`); return 'killed'; },
    },
  );
  await runner.runOnce({ waitTimeoutMs: 10 });
  // The leftover agent is ended first; only then does the round continue.
  expect(order).toEqual(['reap 4242', 'run']);
  expect(events[0]).toEqual(['warn', expect.stringContaining('留下的 DSH 进程（pid 4242）'), 'task-1']);
  expect(events).toHaveLength(3);
  expect(events[1]?.[1]).toContain('续跑');
  expect(events[2]?.[1]).toContain('执行完成');
  expect(store.get('task-1', 1)).toMatchObject({ status: 'submitted' });
});

it('still handles the round when the leftover agent cannot be checked', async () => {
  leftRunningByAnotherProcess('claim-1', 'session-before-crash');
  store.setAgentPid('task-1', 1, 4242);
  const work = new FakeWork({ reason: 'timeout' });
  work.taskViews.push(working(claim()));
  const { events, events2 } = recorder();
  let runs = 0;
  const runner = new Runner(
    work as unknown as WorkClient,
    adapter(async () => { runs += 1; return okRun(); }),
    store,
    dir,
    { logger: quiet, events: events2, reap: async () => { throw new Error('powershell missing'); } },
  );
  await runner.runOnce({ waitTimeoutMs: 10 });
  expect(runs).toBe(1);
  expect(events.some(([, message]) => message.includes('留下的 DSH 进程'))).toBe(false);
  expect(store.get('task-1', 1)?.status).toBe('submitted');
});

it('announces the task it starts and the moment it stops', async () => {
  const work = new FakeWork({ reason: 'assigned', task: working(claim()), claim: claim() });
  const seen: Array<string | null> = [];
  const runner = new Runner(work as unknown as WorkClient, adapter(okRun), store, dir, {
    logger: quiet,
    onTaskChange: (task) => { seen.push(task?.id ?? null); },
  });
  await runner.runOnce({ waitTimeoutMs: 10 });
  expect(seen).toEqual(['task-1', null]);
});

it('does not take a held role as a verdict on the result', async () => {
  leftWaitingForServer();
  const work = new FakeWork({ reason: 'timeout' });
  work.submitError = () => new WorkClientError('ROLE_TAKEN', '这个角色已被占用。');
  const { events, events2 } = recorder();
  const runner = new Runner(work as unknown as WorkClient, adapter(okRun), store, dir, { logger: quiet, events: events2, retryDelayMs: 1 });
  for (let pass = 0; pass < 8; pass += 1) await runner.runOnce({ waitTimeoutMs: 10 });
  expect(work.submitAttempts).toBe(8);
  expect(store.get('task-1', 1)?.status).toBe('submitting');
  expect(events).toEqual([]);
});

it('applies a cancel command only to the task it names', async () => {
  process.env.FAKE_DSH_MODE = 'hang';
  const work = new FakeWork({ reason: 'assigned', task: task(), claim: claim() });
  const runner = new Runner(
    work as unknown as WorkClient,
    new DshHeadlessAdapter({
      command: process.execPath,
      argsPrefix: [fixture],
      profile: 'headless',
      permissionMode: null,
      approvalPolicy: null,
      extraDirs: [],
      timeoutMs: 60_000,
    }),
    store,
    dir,
    { logger: quiet },
  );
  const running = runner.runOnce({ waitTimeoutMs: 10 });
  await vi.waitFor(() => expect(runner.currentTask()).toMatchObject({ id: 'task-1' }));

  // A command queued for another task, as after a runner was offline, is ignored.
  expect(cancelCurrentTask(runner, 'task-other')).toBe('other-task');
  expect(runner.currentTask()).toMatchObject({ id: 'task-1' });
  // One for this task stops it.
  expect(cancelCurrentTask(runner, 'task-1')).toBe('cancelled');
  await running;
  expect(runner.currentTask()).toBeNull();
  expect(cancelCurrentTask(runner, 'task-1')).toBe('idle');
  expect(cancelCurrentTask(runner)).toBe('idle');
  expect(work.submits).toHaveLength(1);
});

// However the earlier attempt ended, a round that is picked up again is told about it.
it.each(['interrupted', 'abandoned', 'failed'] as const)('tells the agent its earlier attempt was cut short when a round continues under a new claim (earlier record: %s)', async (earlier) => {
  leftRunningByAnotherProcess('claim-old', 'session-first-try');
  if (earlier === 'interrupted') store.markInterrupted('task-1', 1, '服务端状态 needs_attention');
  else if (earlier === 'abandoned') store.markAbandoned('task-1', 1, '领取租约已失效。');
  else store.markFailed('task-1', 1, '参数无效。');
  const fresh = { ...claim(), id: 'claim-new' };
  const work = new FakeWork({ reason: 'assigned', task: working(fresh), claim: fresh });
  let seen: { resumeSessionId?: string; preamble?: string } = {};
  const runner = new Runner(
    work as unknown as WorkClient,
    adapter(async (_task, options) => {
      seen = { resumeSessionId: options?.resumeSessionId, preamble: options?.preamble };
      return okRun();
    }),
    store,
    dir,
    { logger: quiet },
  );
  await runner.runOnce({ waitTimeoutMs: 10 });
  expect(seen).toEqual({ resumeSessionId: 'session-first-try', preamble: RESUME_PREAMBLE });
  expect(work.submits[0]).toMatchObject({ round: 1, claimId: 'claim-new' });
  expect(store.get('task-1', 1)).toMatchObject({ status: 'submitted', claimId: 'claim-new', sessionId: 'session-first-try' });
});

it('does not resume a round the server has already handed to another claim', async () => {
  leftRunningByAnotherProcess('claim-old', 'session-first-try');
  const work = new FakeWork({ reason: 'timeout' });
  // Same round and still `working`, but under a claim this runner never held:
  // the round was picked up elsewhere while this runner was down.
  const elsewhere = { ...claim(), id: 'claim-someone-else' };
  work.taskViews.push(working(elsewhere));
  const { events, events2 } = recorder();
  let runs = 0;
  const runner = new Runner(
    work as unknown as WorkClient,
    adapter(async () => { runs += 1; return okRun(); }),
    store,
    dir,
    { logger: quiet, events: events2 },
  );
  await runner.runOnce({ waitTimeoutMs: 10 });
  // Two agents on one round is exactly what must not happen.
  expect(runs).toBe(0);
  expect(work.submitAttempts).toBe(0);
  expect(store.get('task-1', 1)).toMatchObject({ status: 'interrupted', note: '服务端状态 working' });
  expect(events).toEqual([['warn', expect.stringContaining('在执行中被中断'), 'task-1']]);
});

/** A task and claim of their own, so no record of an earlier leg is in the way. */
function roundFixture(id: string): { view: WorkTask; claim: Claim } {
  const claim: Claim = { id: `claim-${id}`, kind: 'work', round: 1, expiresAt: Date.now() + 60_000 };
  return { claim, view: { ...task(), id, rounds: [{ round: 1, createdAt: 1, workClaim: claim }] } };
}

it('reports how each round ended', async () => {
  const { events, events2 } = recorder();
  let impl: () => Promise<AgentRunResult> = async () => okRun();
  const work = new FakeWork({ reason: 'timeout' });
  const runner = new Runner(work as unknown as WorkClient, adapter(() => impl()), store, dir, { logger: quiet, events: events2 });
  const run = async (id: string, outcome: () => Promise<AgentRunResult>) => {
    const { view, claim } = roundFixture(id);
    impl = outcome;
    work.next = { reason: 'assigned', task: view, claim };
    events.length = 0;
    await runner.runOnce({ waitTimeoutMs: 10 });
    return events.map(([level, message]) => [level, message]);
  };

  expect(await run('done', async () => okRun())).toEqual([
    ['info', '领取任务「Runner fake」第 1 轮。'],
    ['info', '任务 done 第 1 轮执行完成。'],
  ]);
  expect(await run('timed-out', async () => ({ text: '', reasonKind: 'timeout', exitCode: null, stderr: '' }))).toEqual([
    ['info', '领取任务「Runner fake」第 1 轮。'],
    ['warn', '任务 timed-out 第 1 轮超时，已终止；未完成的部分写在了回报里。'],
  ]);
  expect(await run('crashed', async () => ({ text: resultText, reasonKind: 'completed', exitCode: 3, stderr: 'boom' }))).toEqual([
    ['info', '领取任务「Runner fake」第 1 轮。'],
    ['error', '任务 crashed 第 1 轮执行失败：DSH 退出码 3；DSH stderr：boom'],
  ]);
  expect(await run('unstartable', async () => { throw new Error('spawn failed'); })).toEqual([
    ['info', '领取任务「Runner fake」第 1 轮。'],
    ['error', '任务 unstartable 第 1 轮执行失败：runner 执行 DSH 失败：spawn failed'],
  ]);
  // The reason also reached the work board, as part of the result.
  expect(work.submits.at(-1)?.result).toMatchObject({ unresolved: 'runner 执行 DSH 失败：spawn failed' });
});

it('reports a cancelled round as cancelled, not as a failure', async () => {
  process.env.FAKE_DSH_MODE = 'hang';
  const { events, events2 } = recorder();
  const work = new FakeWork({ reason: 'assigned', task: task(), claim: claim() });
  const runner = new Runner(
    work as unknown as WorkClient,
    new DshHeadlessAdapter({
      command: process.execPath,
      argsPrefix: [fixture],
      profile: 'headless',
      permissionMode: null,
      approvalPolicy: null,
      extraDirs: [],
      timeoutMs: 60_000,
    }),
    store,
    dir,
    { logger: quiet, events: events2 },
  );
  const running = runner.runOnce({ waitTimeoutMs: 10 });
  await vi.waitFor(() => expect(runner.currentTask()).toMatchObject({ id: 'task-1' }));
  runner.cancelCurrent();
  await running;
  expect(events.at(-1)).toEqual(['warn', '任务 task-1 第 1 轮被取消，已终止执行。', 'task-1']);
  expect(events.some(([, message]) => message.includes('执行失败'))).toBe(false);
});

it('says once that the board is waiting on a person', async () => {
  const work = new FakeWork({ reason: 'needs_attention', task: { ...task(), status: 'needs_attention' } });
  const { events, events2 } = recorder();
  const controller = new AbortController();
  const runner = new Runner(work as unknown as WorkClient, adapter(okRun), store, dir, { logger: quiet, events: events2, retryDelayMs: 1, pauseMs: 1 });
  const loop = runner.runLoop({ waitTimeoutMs: 10, signal: controller.signal });
  // Several polls go by while the task stays as it is.
  await vi.waitFor(() => expect(work.waitCalls).toBeGreaterThanOrEqual(4));
  controller.abort();
  await loop;
  expect(events).toEqual([['warn', '任务 task-1 待接管，暂停领取新任务。', 'task-1']]);
});
