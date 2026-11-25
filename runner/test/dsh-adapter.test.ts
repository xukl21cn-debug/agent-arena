import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkTask } from '@arena/shared';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DshHeadlessAdapter } from '../src/adapters/dsh.js';
import type { DshConfig } from '../src/config.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url));
let dir: string;
const originalMode = process.env.FAKE_DSH_MODE;

function task(): WorkTask {
  return {
    version: 2,
    id: 'task-1',
    requestId: 'req-1',
    workspace: dir,
    title: 'Fake task',
    requirement: 'Read stdin and report a result.',
    branch: 'feat/probe',
    base: 'a'.repeat(40),
    acceptance: ['The fake CLI returns a structured result'],
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

function config(overrides: Partial<DshConfig> = {}): DshConfig {
  return {
    command: process.execPath,
    argsPrefix: [fixture],
    profile: 'headless',
    sessionId: null,
    permissionMode: null,
    approvalPolicy: null,
    extraDirs: [],
    timeoutMs: 10_000,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-runner-dsh-'));
  delete process.env.FAKE_DSH_MODE;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalMode === undefined) delete process.env.FAKE_DSH_MODE;
  else process.env.FAKE_DSH_MODE = originalMode;
});

it('captures the session event and final answer from the NDJSON stream', async () => {
  const seen: string[] = [];
  const result = await new DshHeadlessAdapter(config()).run(task(), {
    onSessionId: (sessionId) => seen.push(sessionId),
  });
  expect(result).toMatchObject({
    sessionId: 'session-fake',
    reasonKind: 'completed',
    exitCode: 0,
  });
  expect(result.text).toContain('```arena-result');
  expect(seen).toEqual(['session-fake']);
});

it('keeps the final answer and reports a nonzero exit', async () => {
  process.env.FAKE_DSH_MODE = 'spawn-fail';
  const result = await new DshHeadlessAdapter(config()).run(task());
  expect(result.exitCode).toBe(1);
  expect(result.reasonKind).toBeNull();
  expect(result.stderr).toContain('fake dsh failed');
});

it('reports a startup error event', async () => {
  process.env.FAKE_DSH_MODE = 'error-event';
  const result = await new DshHeadlessAdapter(config()).run(task());
  expect(result.exitCode).toBe(1);
  expect(result.reasonKind).toBe('error');
});

it('rejects when the configured command cannot be started', async () => {
  await expect(new DshHeadlessAdapter(config({ command: 'definitely-not-a-command-arena' })).run(task()))
    .rejects.toThrow(/无法启动 DSH/);
});
