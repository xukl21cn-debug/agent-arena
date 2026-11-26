import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ArenaDatabase } from '../src/db/database.js';
import { WorkStore } from '../src/work/store.js';
import { SqliteWorkTaskStore } from '../src/work/sqlite-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-sqlite-work-'));
  writeFileSync(path.join(dir, 'brief.md'), '# Scope');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const request = {
  requestId: 'sqlite-work-1',
  title: 'SQLite work',
  requirement: 'Persist me',
  branch: 'feat/probe',
  base: 'a'.repeat(40),
  acceptance: ['Persisted'],
  docs: [{ kind: 'brief' as const, path: 'brief.md', summary: 'Scope' }],
};

it('persists work tasks and restores them across SQLite reopen', async () => {
  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  const store = new WorkStore(dir, dir, 60_000, undefined, new SqliteWorkTaskStore(database));
  const coordinator = store.join('coordinator', 'coordinator', 'coordinator-session');
  const worker = store.join('worker', 'runner', 'worker-session');
  const task = store.create(coordinator, request);
  const claimed = await store.wait(worker, { timeoutMs: 10 });
  expect(claimed.reason).toBe('assigned');
  store.submitWork(worker, { taskId: task.id, round: 1, claimId: claimed.claim!.id }, {
    summary: 'Done', files: ['brief.md'], commits: ['abcdef0'], tests: [], docs: [],
  });
  database.close();

  const reopened = new ArenaDatabase(path.join(dir, 'arena.db'));
  const restored = new WorkStore(dir, dir, 60_000, undefined, new SqliteWorkTaskStore(reopened));
  expect(restored.list()).toMatchObject([{ id: task.id, status: 'pending_review', title: 'SQLite work' }]);
  reopened.close();
});

it('imports legacy work JSON once when the SQLite table is empty', () => {
  const legacy = new WorkStore(dir, dir, 60_000);
  const coordinator = legacy.join('coordinator', 'coordinator', 'coordinator-session');
  legacy.join('worker', 'runner', 'worker-session');
  const task = legacy.create(coordinator, request);

  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  const imported = new SqliteWorkTaskStore(database, dir);
  expect(imported.loadAll().map((entry) => entry.id)).toEqual([task.id]);
  database.close();
});
