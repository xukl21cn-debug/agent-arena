import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { RunnerTaskRef } from '@arena/shared';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { RoomManager } from '../src/game/rooms/room-manager.js';
import { RunnerRegistry } from '../src/runner/registry.js';

let dir: string;
let server: Server;
let base: URL;
let registry: RunnerRegistry;

const task: RunnerTaskRef = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'HTTP task',
  status: 'working',
  round: 1,
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-runner-http-'));
  registry = new RunnerRegistry(60_000);
  server = createServer(createApp(new RoomManager(), loadConfig({ ARENA_DATA_DIR: dir, ARENA_WORK_WORKSPACE: dir }), { runner: registry }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = new URL('http://127.0.0.1:' + (server.address() as { port: number }).port);
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function json(pathname: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(new URL(pathname, base), init);
  return response.json();
}

const post = (pathname: string, body: unknown): Promise<unknown> => json(pathname, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

it('registers a runner, records events, and releases a queued command', async () => {
  expect(await json('/api/runners')).toEqual([]);
  expect(await post('/api/runners/register', {
    id: 'runner-http', name: 'HTTP runner', workspace: dir, version: '0.1.0',
  })).toMatchObject({ id: 'runner-http', status: 'online' });
  expect(await post('/api/runners/runner-http/heartbeat', { currentTask: task }))
    .toMatchObject({ currentTask: task });
  expect(await post('/api/runners/runner-http/events', { level: 'info', message: 'hello', taskId: task.id }))
    .toMatchObject({ seq: 1, message: 'hello' });
  expect(await post('/api/runners/runner-http/commands', { kind: 'cancel' }))
    .toMatchObject({ seq: 1, kind: 'cancel' });

  const commands = await json('/api/runners/runner-http/commands?afterSeq=0&timeoutMs=1000');
  expect(commands).toMatchObject({ commands: [{ seq: 1, kind: 'cancel' }], nextSeq: 1 });
  // The batch names the registry it came from. A cursor that belongs to another
  // registry starts over, so nothing queued after a restart is skipped; the
  // runner sending the right epoch back is understood as "already dealt with".
  const epoch = (commands as { epoch: string }).epoch;
  expect(epoch).toBe(registry.epoch);
  expect(await json('/api/runners/runner-http/commands?afterSeq=5&timeoutMs=1000&epoch=previous-server'))
    .toMatchObject({ commands: [{ seq: 1, kind: 'cancel' }], nextSeq: 1, epoch });
  expect(await json(`/api/runners/runner-http/commands?afterSeq=1&timeoutMs=1000&epoch=${epoch}`))
    .toEqual({ commands: [], nextSeq: 1, epoch });
  expect(await json('/api/runners/runner-http')).toMatchObject({
    id: 'runner-http',
    events: [{ seq: 1, message: 'hello' }],
  });
});

it('rejects unknown runners and non-local origins', async () => {
  expect((await fetch(new URL('/api/runners/missing/heartbeat', base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).status).toBe(404);
  expect((await fetch(new URL('/api/runners', base), {
    headers: { Origin: 'https://example.test' },
  })).status).toBe(403);
});
