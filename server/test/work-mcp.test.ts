import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { type WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { WorkStore } from '../src/work/store.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { attachWebSocket } from '../src/ws.js';
import { RoomManager } from '../src/game/rooms/room-manager.js';

let dir: string;
let server: Server;
let wss: WebSocketServer;
let url: URL;
let store: WorkStore;
const clients: Client[] = [];
const document = { kind: 'brief', path: 'brief.md', summary: 'Confirmed test scope' };
const request = {
  requestId: 'wire', title: 'Relay', requirement: 'Implement the brief',
  branch: 'feat/probe', base: 'a'.repeat(40), acceptance: ['Verify the change'], docs: [document],
};
const result = { summary: 'Work reported', files: [], commits: ['abcdef0'], tests: [], docs: [] };
const review = { summary: 'Reviewed', doc: { ...document, kind: 'review' } };

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-work-wire-'));
  writeFileSync(path.join(dir, 'brief.md'), '# Scope');
  store = new WorkStore(dir, dir, 60_000);
  const rooms = new RoomManager();
  server = createServer(createApp(rooms, loadConfig({ ARENA_DATA_DIR: dir, ARENA_WORK_WORKSPACE: dir }), { work: store }));
  wss = attachWebSocket(server, rooms, { work: store });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = new URL('/work/mcp', 'http://127.0.0.1:' + (server.address() as { port: number }).port);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function connect(name: string) {
  const client = new Client({ name, version: '1' });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

async function raw(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  const item = (response.content as { type: string; text: string }[])[0]!;
  return { error: response.isError, value: JSON.parse(item.text) };
}

async function call(client: Client, name: string, args?: Record<string, unknown>) {
  const response = await raw(client, name, args);
  expect(response.error, JSON.stringify(response.value)).not.toBe(true);
  expect(response.value.hint).toEqual(expect.any(String));
  return response.value;
}

const approve = (taskId: string) => fetch(new URL('/api/work/tasks/' + taskId + '/approve-merge', url), {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
});

it('parks real MCP sessions, relays rework, and gates merge on acknowledgement and approval', async () => {
  const [{ client: c }, { client: w }, { client: w2 }] = await Promise.all(
    ['codex', 'dsh', 'dsh'].map(connect),
  );
  expect((await c.listTools()).tools).toHaveLength(11);
  expect((await raw(c, 'wait_for_work', { timeoutMs: 10 })).value)
    .toMatchObject({ code: 'INVALID_REQUEST', hint: expect.any(String) });
  expect((await raw(c, 'create_task', request)).value.code).toBe('IDENTITY_REQUIRED');
  await call(c, 'join_work', { role: 'coordinator' });
  await call(w, 'join_work', { role: 'worker' });
  await call(w2, 'join_work', { role: 'worker' });
  expect((await raw(w, 'create_task', request)).value.code).toBe('NOT_COORDINATOR');
  expect((await raw(c, 'create_task', { ...request, docs: [{ ...document, path: '../brief.md' }] })).value.code).toBe('INVALID_ARTIFACT');

  let settled = false;
  const parked = call(w, 'wait_for_work', { timeoutMs: 3000 }).finally(() => { settled = true; });
  const other = call(w2, 'wait_for_work', { timeoutMs: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(settled).toBe(false);
  const task = await call(c, 'create_task', request);
  const taskId = task.id;
  const both = await Promise.all([parked, other]);
  expect(both.map((entry) => entry.reason).sort()).toEqual(['assigned', 'in_progress']);
  const ready = call(c, 'wait_for_work', { timeoutMs: 3000 });
  await call(w, 'submit_work_result', { taskId, round: 1, claimId: both[0].claim.id, result });
  const firstReview = await ready;
  await call(c, 'submit_review', { taskId, round: 1, claimId: firstReview.claim.id, ...review, decision: 'rework', findings: 'Repeat' });
  const second = await call(w, 'wait_for_work');
  expect(second.task.id).toBe(taskId);
  expect(second.claim.round).toBe(2);
  await call(w, 'submit_work_result', { taskId, round: 2, claimId: second.claim.id, result });
  const secondReview = await call(c, 'wait_for_work');
  await call(c, 'submit_review', { taskId, round: 2, claimId: secondReview.claim.id, ...review, decision: 'approve' });
  expect((await call(w, 'wait_for_work', { taskId })).reason).toBe('finished');
  expect((await approve(taskId)).status).toBe(409);
  await call(w, 'ack_task_finished', { taskId, round: 2 });
  expect((await raw(c, 'record_merge', { taskId, outcome: 'failed', pushed: false })).value.code).toBe('INVALID_STATE');
  const approvalWait = call(c, 'wait_for_work', { taskId, afterStatus: 'pending_merge_approval', timeoutMs: 3000 });
  const approval = await (await approve(taskId)).json() as { approvedAt: number };
  expect((await approvalWait).reason).toBe('merge_approved');
  expect(await (await approve(taskId)).json()).toMatchObject(approval);
  expect((await call(c, 'record_merge', {
    taskId, outcome: 'success', mergeCommit: 'b'.repeat(40), postMergeTests: [{ command: 'pnpm test', outcome: 'passed' }], pushed: false,
  })).status).toBe('done');
});

it('publishes checkout status over its own WS and exposes only recorded artifacts to the local board', async () => {
  const address = new URL('/ws?kind=work', url);
  address.protocol = 'ws:';
  const socket = new WebSocket(address);
  const first = new Promise((resolve) => socket.once('message', (message) => resolve(JSON.parse(message.toString()))));
  expect(await first).toEqual({ type: 'hello', kind: 'work', tasks: [] });
  const [c, w] = await Promise.all(['codex', 'dsh'].map(async (name) => (await connect(name)).client));
  await call(c, 'join_work', { role: 'coordinator' });
  await call(w, 'join_work', { role: 'worker' });
  const changed = new Promise((resolve) => socket.once('message', (message) => resolve(JSON.parse(message.toString()))));
  const task = await call(c, 'create_task', request);
  expect(await changed).toMatchObject({ type: 'task', kind: 'work', task: { id: task.id, status: 'queued' } });
  const link = new URL('/api/work/tasks/' + task.id + '/artifact', url);
  link.search = new URLSearchParams({ path: task.docs[0].path, hash: task.docs[0].hash }).toString();
  expect(await (await fetch(link)).text()).toBe('# Scope');
  link.searchParams.set('path', 'other.md');
  expect((await fetch(link)).status).toBe(400);
  expect((await fetch(new URL('/api/work/tasks', url), { headers: { Origin: 'https://example.test' } })).status).toBe(403);
  socket.close();
});

it('releases a deleted session and invalidates an interrupted claim', async () => {
  const [{ client: c }, { client: w, transport }] = await Promise.all(['codex', 'dsh'].map(connect));
  await call(c, 'join_work', { role: 'coordinator' });
  await call(w, 'join_work', { role: 'worker' });
  const task = await call(c, 'create_task', request);
  await call(w, 'wait_for_work');
  await transport.terminateSession();
  expect((await call(c, 'get_task', { taskId: task.id })).status).toBe('needs_attention');
  const { client: successor } = await connect('other');
  await call(successor, 'join_work', { role: 'worker' });
  expect((await raw(successor, 'get_task', { taskId: task.id })).value.code).toBe('TASK_NOT_FOUND');
});

it('accepts a result whose valid multibyte file list exceeds the normal REST body limit', async () => {
  const [{ client: c }, { client: w }] = await Promise.all(['codex', 'dsh'].map(connect));
  await call(c, 'join_work', { role: 'coordinator' });
  await call(w, 'join_work', { role: 'worker' });
  const task = await call(c, 'create_task', request);
  const { claim } = await call(w, 'wait_for_work');
  const folder = ('项目'.repeat(20) + '/').repeat(24);
  const files = Array.from({ length: 200 }, (_, index) => folder + index + '.ts');
  expect(Buffer.byteLength(JSON.stringify(files))).toBeGreaterThan(512 * 1024);
  const submitted = await raw(w, 'submit_work_result', { taskId: task.id, round: 1, claimId: claim.id,
    result: { ...result, files },
  });
  expect(submitted.error).not.toBe(true);
  expect(submitted.value.status).toBe('pending_review');
  expect(submitted.value.rounds[0].work.files).toHaveLength(files.length);
});
