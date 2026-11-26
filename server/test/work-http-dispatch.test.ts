import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { RoomManager } from '../src/game/rooms/room-manager.js';
import { WorkStore } from '../src/work/store.js';

let dir: string;
let server: Server;
let base: URL;
let store: WorkStore;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-work-dispatch-'));
  writeFileSync(path.join(dir, 'brief.md'), '# Scope');
  store = new WorkStore(dir, dir, 60_000);
  store.join('worker', 'runner', 'worker-session');
  server = createServer(createApp(new RoomManager(), loadConfig({ ARENA_DATA_DIR: dir, ARENA_WORK_WORKSPACE: dir }), { work: store }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = new URL('http://127.0.0.1:' + (server.address() as { port: number }).port);
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function post(pathname: string, body: unknown): Promise<Response> {
  return fetch(new URL(pathname, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

it('dispatches a task from the work page and reviews it through REST', async () => {
  expect(await (await fetch(new URL('/api/work/context', base))).json()).toMatchObject({
    workspace: dir,
    humanCoordinatorId: 'w_human_0',
  });
  const created = await post('/api/work/tasks', {
    title: 'Page dispatched task',
    requirement: 'Do the small thing.',
    branch: 'feat/probe',
    base: 'a'.repeat(40),
    acceptance: ['The task is visible'],
    docs: [{ kind: 'brief', path: 'brief.md', summary: 'Scope' }],
  });
  expect(created.status).toBe(201);
  const task = await created.json() as { id: string; status: string; coordinator: { id: string } };
  expect(task).toMatchObject({ status: 'queued', coordinator: { id: 'w_human_0' } });

  const worker = store.actorFor('worker-session')!;
  const claimed = await store.wait(worker, { timeoutMs: 50 });
  store.submitWork(worker, { taskId: task.id, round: 1, claimId: claimed.claim!.id }, {
    summary: 'Done', files: [], commits: ['abcdef0'], tests: [], docs: [],
  });
  const reviewed = await post(`/api/work/tasks/${task.id}/review`, {
    decision: 'approve',
    summary: '看板复审通过',
  });
  expect(reviewed.status).toBe(200);
  expect(await reviewed.json()).toMatchObject({ status: 'pending_ack', rounds: [{ review: { decision: 'approve' } }] });
});
