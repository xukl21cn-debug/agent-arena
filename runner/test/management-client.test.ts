import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { RunnerTaskRef } from '@arena/shared';
import { createApp } from '../../server/src/app.js';
import { loadConfig } from '../../server/src/config.js';
import { RoomManager } from '../../server/src/game/rooms/room-manager.js';
import { RunnerRegistry } from '../../server/src/runner/registry.js';
import { RunnerManagementClient } from '../src/management-client.js';

let dir: string;
let server: Server;
let base: string;
let registry: RunnerRegistry;

const task: RunnerTaskRef = {
  id: '00000000-0000-4000-8000-000000000002',
  title: 'Client task',
  status: 'working',
  round: 1,
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-runner-management-'));
  registry = new RunnerRegistry(60_000);
  server = createServer(createApp(new RoomManager(), loadConfig({ ARENA_DATA_DIR: dir, ARENA_WORK_WORKSPACE: dir }), { runner: registry }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

it('registers, heartbeats, reports an event, and consumes a command', async () => {
  const client = new RunnerManagementClient(base, 'runner-client', 'Client runner', dir);
  expect(await client.register()).toMatchObject({ id: 'runner-client', status: 'online' });
  await client.heartbeat(task);
  await client.event('info', 'started');
  await client.command('cancel');
  const batch = await client.pollCommands(0, 1_000);
  expect(batch.commands).toMatchObject([{ kind: 'cancel' }]);
  expect(registry.get('runner-client')).toMatchObject({
    currentTask: task,
    events: [{ message: 'started' }],
  });
});
