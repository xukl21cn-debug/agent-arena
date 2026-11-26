import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp } from '../../server/src/app.js';
import { loadConfig } from '../../server/src/config.js';
import { RoomManager } from '../../server/src/game/rooms/room-manager.js';
import { WorkStore } from '../../server/src/work/store.js';
import { WorkClient } from '../src/work-client.js';

let dir: string;
let server: Server;
let url: URL;
let coordinator: Client;

const brief = { kind: 'brief', path: 'brief.md', summary: 'Confirmed test scope' };
const request = {
  requestId: 'runner-wire',
  title: 'Runner wire',
  requirement: 'Carry a synthetic result through the work domain.',
  branch: 'feat/probe',
  base: 'a'.repeat(40),
  acceptance: ['Result is visible as pending review'],
  docs: [brief],
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-runner-wire-'));
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

it('joins as worker, receives a claim, and submits the result back', async () => {
  await call('join_work', { role: 'coordinator', name: 'coordinator' });
  const runner = new WorkClient(url.origin, 'runner-wire');
  await runner.connect();
  try {
    await runner.join();
    const task = await call('create_task', request);
    const wait = await runner.waitForWork(3_000);
    expect(wait.reason).toBe('assigned');
    expect(wait.task).toMatchObject({ id: task.id, status: 'working' });
    expect(wait.claim).toMatchObject({ kind: 'work', round: 1 });

    const submitted = await runner.submitResult(String(task.id), 1, wait.claim!.id, {
      summary: 'wire complete',
      files: [],
      commits: ['abcdef0'],
      tests: [],
      docs: [],
    });
    expect(submitted).toMatchObject({ id: task.id, status: 'pending_review' });
    const current = await call('get_task', { taskId: task.id });
    expect(current).toMatchObject({ status: 'pending_review', rounds: [{ work: { summary: 'wire complete' } }] });
  } finally {
    await runner.close();
  }
});
