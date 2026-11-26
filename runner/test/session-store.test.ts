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
  // A resume is for rounds another process left behind, not for one's own.
  expect(store.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' }, { resume: true })).toBe(false);
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

it('persists the runner command cursor', () => {
  const store = new SessionStore(file, () => 1_000);
  expect(store.commandCursor()).toBe(0);
  store.setCommandCursor(7);
  expect(new SessionStore(file, () => 2_000).commandCursor()).toBe(7);
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

it('lets a new process resume a round another one left running', () => {
  const first = new SessionStore(file, () => 1_000, 'process-a');
  first.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' });
  first.setSessionId('task-1', 1, 'session-before-crash');
  expect(first.orphans()).toEqual([]);

  const second = new SessionStore(file, () => 2_000, 'process-b');
  expect(second.orphans()).toEqual([expect.objectContaining({ claimId: 'claim-1', instanceId: 'process-a' })]);
  // Still the same claim in play, so a plain begin is refused...
  expect(second.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' })).toBe(false);
  // ...and a resume takes it over, keeping what the dead process recorded.
  expect(second.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' }, { resume: true })).toBe(true);
  expect(second.get('task-1', 1)).toMatchObject({
    status: 'running', instanceId: 'process-b', sessionId: 'session-before-crash', startedAt: 1_000, updatedAt: 2_000,
  });
  expect(second.orphans()).toEqual([]);
});

it('counts a running record without an instance id as another process\'s', () => {
  // What a state file written before instance ids existed looks like.
  writeFileSync(file, JSON.stringify({
    version: 1,
    records: [{ taskId: 'task-1', round: 1, claimId: 'claim-1', status: 'running', startedAt: 1, updatedAt: 2 }],
  }), 'utf8');
  expect(new SessionStore(file).orphans()).toHaveLength(1);
});

it('keeps a result on disk until the server has it', () => {
  const result = { summary: 'done', files: [], commits: ['abcdef0'], tests: [], docs: [] };
  const store = new SessionStore(file, () => 1_000);
  store.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' });
  store.setResult('task-1', 1, result);
  expect(store.get('task-1', 1)).toMatchObject({ status: 'submitting', result });

  // A later process finds it and hands it in without running anything again.
  const later = new SessionStore(file, () => 2_000, 'later-process');
  expect(later.pendingSubmissions()).toEqual([expect.objectContaining({ claimId: 'claim-1', result })]);
  later.markSubmitted('task-1', 1);
  expect(new SessionStore(file).pendingSubmissions()).toEqual([]);
});

it('carries the session over to a later claim on the same round', () => {
  const store = new SessionStore(file, () => 1_000);
  store.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' });
  store.setSessionId('task-1', 1, 'session-first-attempt');
  store.markInterrupted('task-1', 1);
  // The round continues on a new claim; if this attempt is cut short before it
  // reports a session, the one the first attempt used must still be known.
  expect(store.begin({ taskId: 'task-1', round: 1, claimId: 'claim-2' })).toBe(true);
  expect(store.get('task-1', 1)).toMatchObject({ status: 'running', claimId: 'claim-2', sessionId: 'session-first-attempt' });
  expect(store.latestSessionForTask('task-1')).toBe('session-first-attempt');
});

it('counts the server\'s rejections of one result', () => {
  const store = new SessionStore(file, () => 1_000);
  store.begin({ taskId: 'task-1', round: 1, claimId: 'claim-1' });
  expect(store.countRejection('task-1', 1)).toBe(1);
  expect(store.countRejection('task-1', 1)).toBe(2);
  expect(store.get('task-1', 1)?.rejections).toBe(2);
});

it('keeps only the latest hundred settled records and every live one', () => {
  let now = 0;
  const store = new SessionStore(file, () => (now += 1));
  for (let index = 1; index <= 130; index += 1) {
    store.begin({ taskId: `done-${index}`, round: 1, claimId: `claim-${index}` });
    store.markSubmitted(`done-${index}`, 1);
  }
  store.begin({ taskId: 'live', round: 1, claimId: 'live-claim' });

  const saved = new SessionStore(file);
  expect(saved.get('live', 1)?.status).toBe('running');
  const settled = (JSON.parse(readFileSync(file, 'utf8')) as { records: Array<{ taskId: string }> }).records
    .filter((record) => record.taskId !== 'live');
  expect(settled).toHaveLength(100);
  expect(saved.get('done-30', 1)).toBeUndefined();
  expect(saved.get('done-31', 1)).toBeDefined();
  expect(saved.get('done-130', 1)).toBeDefined();
});
