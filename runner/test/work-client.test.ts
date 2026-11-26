import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../../server/src/app.js';
import { loadConfig } from '../../server/src/config.js';
import { RoomManager } from '../../server/src/game/rooms/room-manager.js';
import { WorkStore } from '../../server/src/work/store.js';
import { WorkClient, WorkClientError } from '../src/work-client.js';

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
  // A client whose server restarted in the test cannot close its dead session.
  await coordinator.close().catch(() => undefined);
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

it('opens a new session and rejoins after the server restarts, keeping the claim', async () => {
  await call('join_work', { role: 'coordinator', name: 'coordinator' });
  const port = (server.address() as { port: number }).port;
  const reconnects: string[] = [];
  const runner = new WorkClient(url.origin, 'runner-wire', () => reconnects.push('reconnected'));
  await runner.connect();
  try {
    const joined = await runner.join();
    const task = await call('create_task', request);
    const wait = await runner.waitForWork(3_000);
    expect(wait.reason).toBe('assigned');
    const claimId = wait.claim!.id;

    // The server goes away and comes back on the same port with the same data.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const restarted = new WorkStore(dir, dir, 60_000);
    server = createServer(createApp(new RoomManager(), loadConfig({ ARENA_DATA_DIR: dir, ARENA_WORK_WORKSPACE: dir }), { work: restarted }));
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    // Calls that hit the dead session together share one reconnect. The first
    // request on a socket the old server opened may simply be reset, so like
    // the runner, the test tries again until the server answers.
    const answered = await vi.waitFor(async () => {
      const settled = await Promise.allSettled([
        runner.getTask(String(task.id)),
        runner.renewClaim(String(task.id), 1, claimId),
      ]);
      expect(settled.map((entry) => entry.status)).toEqual(['fulfilled', 'fulfilled']);
      return settled.map((entry) => (entry as PromiseFulfilledResult<unknown>).value);
    }, { timeout: 5_000, interval: 250 });
    expect(answered[0]).toMatchObject({ id: task.id, status: 'working' });
    expect((answered[1] as { expiresAt: number }).expiresAt).toBeGreaterThan(Date.now());
    // The rejoin gave back the identity the claim was taken under.
    expect(await runner.join()).toMatchObject({ participantId: joined.participantId });
    expect(reconnects).toEqual(['reconnected']);

    // The round taken before the restart can still be handed in under its claim.
    const submitted = await runner.submitResult(String(task.id), 1, claimId, {
      summary: 'survived the restart',
      files: [],
      commits: ['abcdef0'],
      tests: [],
      docs: [],
    });
    expect(submitted).toMatchObject({ id: task.id, status: 'pending_review' });
  } finally {
    await runner.close();
  }
});

it('joins again when it finds itself unjoined, and survives a rejoin that was refused', async () => {
  await call('join_work', { role: 'coordinator', name: 'coordinator' });
  const port = (server.address() as { port: number }).port;
  const runner = new WorkClient(url.origin, 'runner-wire');
  await runner.connect();
  const attempts: WorkClient[] = [];
  let intruder: WorkClient | undefined;
  try {
    const joined = await runner.join();
    const task = await call('create_task', request);

    // The server restarts, and before this runner is back another worker has
    // taken the role, so the rejoin that follows the dead session is refused.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const restarted = new WorkStore(dir, dir, 60_000);
    server = createServer(createApp(new RoomManager(), loadConfig({ ARENA_DATA_DIR: dir, ARENA_WORK_WORKSPACE: dir }), { work: restarted }));
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    // The first connection after the restart can be reset, as above.
    await vi.waitFor(async () => {
      intruder = new WorkClient(url.origin, 'someone-else');
      attempts.push(intruder);
      await intruder.connect();
      await intruder.join();
    }, { timeout: 5_000, interval: 250 });
    await vi.waitFor(async () => {
      const error = await runner.getTask(String(task.id)).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(WorkClientError);
      expect((error as WorkClientError).code).toBe('ROLE_TAKEN');
    }, { timeout: 5_000, interval: 250 });

    // The refusal is what the caller sees each time, and it is all it takes for
    // the next call, once the role is free, to join again and go through.
    await intruder!.leave();
    await vi.waitFor(async () => {
      expect(await runner.getTask(String(task.id))).toMatchObject({ id: task.id });
    }, { timeout: 5_000, interval: 250 });
    expect(await runner.join()).toMatchObject({ participantId: joined.participantId });
  } finally {
    for (const client of attempts) await client.close().catch(() => undefined);
    await runner.close().catch(() => undefined);
  }
});
