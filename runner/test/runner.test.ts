import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Claim, WorkTask } from '@arena/shared';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AgentAdapter, AgentRunResult } from '../src/adapters/types.js';
import { Runner } from '../src/runner.js';
import { SessionStore } from '../src/session-store.js';
import type { WorkClient, WorkWaitResult } from '../src/work-client.js';

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-runner-loop-'));
  store = new SessionStore(path.join(dir, 'state.json'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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

  constructor(private readonly next: WorkWaitResult) {}

  async waitForWork(): Promise<WorkWaitResult> {
    return this.next;
  }

  async submitResult(taskId: string, round: number, claimId: string, result: unknown): Promise<WorkTask> {
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
}

const adapter = (impl: (task: WorkTask, options?: { resumeSessionId?: string }) => Promise<AgentRunResult>): AgentAdapter => ({ run: impl });

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
