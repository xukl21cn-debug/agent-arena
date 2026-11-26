import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { RoomManager } from '../src/game/rooms/room-manager.js';
import { WorkStore } from '../src/work/store.js';
import type { RunnerRegistry } from '../src/runner/registry.js';

let dir: string;
let server: Server;
let base: URL;
let store: WorkStore;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-work-dispatch-'));
  writeFileSync(path.join(dir, 'brief.md'), '# Scope');
  store = new WorkStore(dir, dir, 60_000);
  store.join('worker', 'runner', 'worker-session');
  base = await startApp();
});

afterEach(async () => {
  await stopApp();
  rmSync(dir, { recursive: true, force: true });
});

async function startApp(extra: { runner?: RunnerRegistry } = {}): Promise<URL> {
  server = createServer(createApp(new RoomManager(), loadConfig({ ARENA_DATA_DIR: dir, ARENA_WORK_WORKSPACE: dir }), { work: store, ...extra }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return new URL('http://127.0.0.1:' + (server.address() as { port: number }).port);
}

async function stopApp(): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const dispatch = {
  title: 'Page dispatched task',
  requirement: 'Do the small thing.',
  branch: 'feat/probe',
  base: 'a'.repeat(40),
  acceptance: ['Handled through REST'],
  docs: [{ kind: 'brief', path: 'brief.md', summary: 'Scope' }],
};

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

it('cancels a running task, stops the runner on it, and continues an interrupted task', async () => {
  const task = await (await post('/api/work/tasks', dispatch)).json() as { id: string };
  // A runner holds the task.
  expect((await store.wait(store.actorFor('worker-session')!, { timeoutMs: 50 })).reason).toBe('assigned');

  // Restart the app with a registry that reports which runner executes what.
  await stopApp();
  const commands: Array<[string, string, string | undefined]> = [];
  const runners = {
    list: () => [{ id: 'runner-1', currentTask: { id: task.id } }, { id: 'runner-2', currentTask: null }],
    enqueue: (id: string, kind: string, taskId?: string) => { commands.push([id, kind, taskId]); },
  };
  base = await startApp({ runner: runners as unknown as RunnerRegistry });

  // A reason is required, and nothing is told to stop before the task is cancelled.
  expect((await post(`/api/work/tasks/${task.id}/cancel`, {})).status).toBe(400);
  expect(commands).toEqual([]);

  const cancelled = await post(`/api/work/tasks/${task.id}/cancel`, { reason: '方向变了。' });
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ status: 'cancelled', issue: '方向变了。' });
  // Only the runner executing that task is told, and the command names the task.
  expect(commands).toEqual([['runner-1', 'cancel', task.id]]);

  // An interrupted task continues through its own route, and only that one.
  const second = await (await post('/api/work/tasks', { ...dispatch, title: 'Cut short' })).json() as { id: string };
  store.takeover(second.id, '执行者失联。');
  const resumed = await post(`/api/work/tasks/${second.id}/resume`, {});
  expect(resumed.status).toBe(200);
  expect(await resumed.json()).toMatchObject({ status: 'rework_requested', issue: expect.stringContaining('继续第 1 轮') });
  expect((await post(`/api/work/tasks/${second.id}/resume`, {})).status).toBe(409);
  expect((await post(`/api/work/tasks/${task.id}/resume`, {})).status).toBe(409);
});
