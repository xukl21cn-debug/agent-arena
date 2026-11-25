import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { SessionStore } from '../src/session-store.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-runner-state-'));
  file = path.join(dir, 'state.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('persists task-round bindings and the DSH session identity', () => {
  const store = new SessionStore(file, () => 1_000);
  expect(store.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' })).toBe(true);
  store.setSessionId('task-1', 1, 'session-abc');
  store.markSubmitted('task-1', 1);

  const raw = JSON.parse(readFileSync(file, 'utf8')) as { records: Array<Record<string, unknown>> };
  expect(raw.records[0]).toMatchObject({
    taskId: 'task-1',
    round: 1,
    claimId: 'claim-1',
    sessionId: 'session-abc',
    status: 'submitted',
  });

  const reconnected = new SessionStore(file, () => 2_000);
  expect(reconnected.get('task-1', 1)).toMatchObject({ sessionId: 'session-abc', status: 'submitted' });
});

it('refuses to start the same claim twice', () => {
  const store = new SessionStore(file, () => 1_000);
  expect(store.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' })).toBe(true);
  expect(store.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' })).toBe(false);
});

it('allows a new claim for a later round', () => {
  const store = new SessionStore(file, () => 1_000);
  expect(store.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' })).toBe(true);
  store.markSubmitted('task-1', 1);
  expect(store.begin({ taskId: 'task-1', round: 2, claimId: 'claim-2' })).toBe(true);
  expect(store.get('task-1', 2)).toMatchObject({ status: 'running', claimId: 'claim-2' });
});

it('keeps the latest session id for a task across rework rounds', () => {
  const store = new SessionStore(file, () => 1_000);
  store.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' });
  store.setSessionId('task-1', 1, 'session-round-1');
  store.markSubmitted('task-1', 1);
  expect(store.latestSessionForTask('task-1')).toBe('session-round-1');
});

it('moves a corrupt state file aside instead of overwriting it', () => {
  writeFileSync(file, 'not json', 'utf8');
  const store = new SessionStore(file, () => 1_000);
  expect(store.get('task-1', 1)).toBeUndefined();
  store.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' });
  const files = readdirSync(dir);
  expect(files.some((name) => name.startsWith('state.json.corrupt-'))).toBe(true);
  expect(files).toContain('state.json');
});
