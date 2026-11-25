import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import WebSocket, { type WebSocketServer } from 'ws';
import type { ServerMessage } from '@arena/shared';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryRoomRepository } from '../src/game/rooms/repository.js';
import { RoomManager } from '../src/game/rooms/room-manager.js';
import { RunnerRegistry } from '../src/runner/registry.js';
import { attachWebSocket } from '../src/ws.js';

let dir: string;
let server: Server;
let wss: WebSocketServer;
let socket: WebSocket;
let registry: RunnerRegistry;
let wsUrl: string;
let frames: ServerMessage[];

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-runner-ws-'));
  const manager = new RoomManager({ repository: new MemoryRoomRepository() });
  manager.initializeDefaultRoom();
  registry = new RunnerRegistry(60_000);
  server = createServer(createApp(manager, loadConfig({ ARENA_DATA_DIR: dir }), { runner: registry }));
  wss = attachWebSocket(server, manager, { runner: registry });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  wsUrl = 'ws://127.0.0.1:' + (server.address() as { port: number }).port + '/ws?kind=runner';
});

afterEach(async () => {
  socket?.terminate();
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error('timed out waiting for WS frame')); return; }
      setTimeout(check, 10);
    };
    check();
  });
}

it('greets with the runner list and pushes registry changes', async () => {
  frames = [];
  await new Promise<void>((resolve, reject) => {
    socket = new WebSocket(wsUrl);
    socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as ServerMessage));
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  await waitUntil(() => frames.length >= 1);
  expect(frames[0]).toEqual({ type: 'hello', kind: 'runner', runners: [] });
  registry.register({ id: 'runner-ws', name: 'WS runner', workspace: dir, version: '0.1.0' });
  await waitUntil(() => frames.length >= 2);
  expect(frames[1]).toMatchObject({ type: 'runner', kind: 'runner', runner: { id: 'runner-ws', status: 'online' } });
  registry.event('runner-ws', { level: 'info', message: 'hello' });
  await waitUntil(() => frames.length >= 3);
  expect(frames[2]).toMatchObject({
    type: 'runner', kind: 'runner', runner: { id: 'runner-ws', events: [{ message: 'hello' }] },
  });
});
