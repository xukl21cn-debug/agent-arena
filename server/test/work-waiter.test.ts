import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { RoomManager } from '../src/game/rooms/room-manager.js';
import { WorkStore } from '../src/work/store.js';

let dir: string;
let server: Server;
let url: URL;
let store: WorkStore;
let coordinator: Client;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-work-waiter-'));
  writeFileSync(path.join(dir, 'brief.md'), '# Scope');
  store = new WorkStore(dir, dir, 60_000);
  server = createServer(createApp(new RoomManager(), loadConfig({ ARENA_DATA_DIR: dir, ARENA_WORK_WORKSPACE: dir }), { work: store }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = new URL('/work/mcp', 'http://127.0.0.1:' + (server.address() as { port: number }).port);
  coordinator = new Client({ name: 'coordinator', version: '1' });
  await coordinator.connect(new StreamableHTTPClientTransport(url));
});

afterEach(async () => {
  await coordinator.close().catch(() => undefined);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as Record<string, unknown>;
}

async function connectWorker(name: string): Promise<{ client: Client; sessionId: string }> {
  const client = new Client({ name, version: '1' });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  await call(client, 'join_work', { role: 'worker', name: 'runner' });
  return { client, sessionId: transport.sessionId! };
}

async function until(what: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

it('forgets a parked wait when the client that made it goes away, so a claim is never handed to a dead session', async () => {
  await call(coordinator, 'join_work', { role: 'coordinator', name: 'coordinator' });
  const parkedWaits = (): number => (store as unknown as { waiters: Set<unknown> }).waiters.size;

  // A worker parks on a long poll over a connection of its own.
  const dead = await connectWorker('dead-worker');
  const parked = httpRequest(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
      'mcp-session-id': dead.sessionId,
    },
  });
  parked.on('error', () => undefined);
  parked.end(JSON.stringify({
    jsonrpc: '2.0', id: 99, method: 'tools/call',
    params: { name: 'wait_for_work', arguments: { timeoutMs: 20_000 } },
  }));
  await until('the parked wait', () => parkedWaits() === 1);

  // Its process is killed: the connection goes away before any response is written.
  parked.destroy();
  await until('the parked wait to be dropped', () => parkedWaits() === 0);

  // Another session of the same worker gets the next task, instead of watching
  // a claim go to the session that no longer exists.
  const live = await connectWorker('live-worker');
  try {
    const task = await call(coordinator, 'create_task', {
      requestId: 'waiter',
      title: 'Claimed by the living',
      requirement: 'Not by a session that died parked on a poll.',
      branch: 'feat/probe',
      base: 'a'.repeat(40),
      acceptance: ['The live worker is assigned'],
      docs: [{ kind: 'brief', path: 'brief.md', summary: 'Scope' }],
    });
    const assigned = await call(live.client, 'wait_for_work', { timeoutMs: 3_000 });
    expect(assigned).toMatchObject({ reason: 'assigned', task: { id: task.id, status: 'working' } });
  } finally {
    await live.client.close();
    await dead.client.close();
  }
});
