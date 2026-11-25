import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp } from '../../server/src/app.js';
import { loadConfig } from '../../server/src/config.js';
import { RoomManager } from '../../server/src/game/rooms/room-manager.js';
import { WorkStore } from '../../server/src/work/store.js';
import { DshHeadlessAdapter } from '../src/adapters/dsh.js';
import { Runner } from '../src/runner.js';
import { SessionStore } from '../src/session-store.js';
import { WorkClient } from '../src/work-client.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url));
let dir: string;
let server: Server;
let url: URL;
let coordinator: Client;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-runner-e2e-'));
  writeFileSync(path.join(dir, 'brief.md'), '# Scope');
  const store = new WorkStore(dir, dir, 60_000);
  server = createServer(createApp(new RoomManager(), loadConfig({ ARENA_DATA_DIR: dir, ARENA_WORK_WORKSPACE: dir }), { work: store }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = new URL('/work/mcp', 'http://127.0.0.1:' + (server.address() as { port: number }).port);
  coordinator = new Client({ name: 'coordinator', version: '1' });
  await coordinator.connect(new StreamableHTTPClientTransport(url));
});

afterEach(async () => {
  await coordinator.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await coordinator.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  return JSON.parse(text) as Record<string, unknown>;
}

it('turns a queued task into a submitted work round through the fake DSH CLI', async () => {
  await call('join_work', { role: 'coordinator', name: 'coordinator' });
  const runnerClient = new WorkClient(url.origin, 'runner-e2e');
  await runnerClient.connect();
  try {
    await runnerClient.join();
    const task = await call('create_task', {
      requestId: 'runner-e2e',
      title: 'E2E runner',
      requirement: 'Run through the fake headless CLI.',
      branch: 'feat/probe',
      base: 'a'.repeat(40),
      acceptance: ['A structured result reaches pending review'],
      docs: [{ kind: 'brief', path: 'brief.md', summary: 'Scope' }],
    });
    const sessions = new SessionStore(path.join(dir, 'state.json'));
    const runner = new Runner(
      runnerClient,
      new DshHeadlessAdapter({
        command: process.execPath,
        argsPrefix: [fixture],
        profile: 'headless',
        sessionId: null,
        permissionMode: null,
        approvalPolicy: null,
        extraDirs: [],
        timeoutMs: 10_000,
      }),
      sessions,
      dir,
    );
    await runner.runOnce({ waitTimeoutMs: 3_000 });
    const current = await call('get_task', { taskId: task.id });
    expect(current).toMatchObject({
      status: 'pending_review',
      rounds: [{ work: { summary: expect.stringContaining('fake dsh read'), commits: ['abcdef0'] } }],
    });
    expect(sessions.get(String(task.id), 1)).toMatchObject({ status: 'submitted', sessionId: 'session-fake' });
  } finally {
    await runnerClient.close();
  }
});
