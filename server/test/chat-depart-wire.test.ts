import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { ChatManager } from '../src/chat/manager';
import { RoomManager } from '../src/game/rooms/room-manager';

// The MCP layer's side of the auto-pass contract: a session that drops must
// hand its held turn back within the grace, an explicit DELETE must do it at
// once, and a reconnect must make the member drivable again instead of
// leaving a stale session that masks every later exit.

const GONE_GRACE_MS = 100;

let server: Server;
let baseUrl: string;
let dataDir: string;

function payloadOf(result: Awaited<ReturnType<Client['callTool']>>): any {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === 'text')?.text;
  if (!text) {
    throw new Error('tool returned no text content');
  }
  return JSON.parse(text);
}

async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: '0.0.1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/chat/mcp`)),
  );
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  return payloadOf(await client.callTool({ name, arguments: args }));
}

async function newRoom(roomId: string): Promise<void> {
  const created = await fetch(`${baseUrl}/api/chat/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, policy: { turnTimeoutMs: 300_000 } }),
  });
  expect(created.status).toBe(201);
}

async function detail(roomId: string): Promise<any> {
  return await (await fetch(`${baseUrl}/api/chat/rooms/${roomId}`)).json();
}

async function hostSays(roomId: string, text: string, to: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/chat/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, to }),
  });
  expect(response.status).toBe(201);
}

async function until(
  predicate: () => Promise<boolean>,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'arena-chat-depart-wire-'));
  const manager = new RoomManager();
  manager.initializeDefaultRoom();
  const chat = new ChatManager(dataDir);
  chat.restoreAll();
  server = createServer(
    createApp(manager, loadConfig({ ARENA_DATA_DIR: dataDir }), {
      chat,
      chatGoneGraceMs: GONE_GRACE_MS,
      // Keep stale sessions long enough for the reconnect regression below.
      chatSessionRetentionMs: 60_000,
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

describe('session drop over the wire', () => {
  it('D11: explicit DELETE hands the turn back immediately', async () => {
    await newRoom('depart-delete');
    const a = await connect('alpha');
    const b = await connect('beta');
    await call(a, 'join_room', { roomId: 'depart-delete', name: 'alpha' });
    await call(b, 'join_room', { roomId: 'depart-delete', name: 'beta' });
    await hostSays('depart-delete', '开始', 'alpha');

    await (a.transport as StreamableHTTPClientTransport).terminateSession();
    await a.close();

    expect(
      await until(async () => (await detail('depart-delete')).room.turn?.name === 'beta'),
    ).toBe(true);
    const messages = (await detail('depart-delete')).messages;
    expect(messages.at(-1)?.text).toBe('alpha 的轮次已交给 beta');
    await b.close();
  });

  it('D12: a dropped SSE stream hands the turn back after the grace', async () => {
    await newRoom('depart-sse');
    const a = await connect('alpha');
    const b = await connect('beta');
    await call(a, 'join_room', { roomId: 'depart-sse', name: 'alpha' });
    await call(b, 'join_room', { roomId: 'depart-sse', name: 'beta' });
    await hostSays('depart-sse', '开始', 'alpha');

    await a.close();
    expect(
      await until(async () => (await detail('depart-sse')).room.turn?.name === 'beta'),
    ).toBe(true);
    const messages = (await detail('depart-sse')).messages;
    expect(messages.at(-1)?.text).toBe('alpha 的轮次已交给 beta');
    await b.close();
  });

  it('D13: a reconnect followed by another drop still hands the turn back', async () => {
    await newRoom('depart-reconnect');
    const a1 = await connect('alpha');
    const b = await connect('beta');
    const firstJoin = await call(a1, 'join_room', {
      roomId: 'depart-reconnect',
      name: 'alpha',
    });
    await call(b, 'join_room', { roomId: 'depart-reconnect', name: 'beta' });
    await hostSays('depart-reconnect', '开始', 'alpha');

    await a1.close();
    expect(
      await until(async () => (await detail('depart-reconnect')).room.turn?.name === 'beta'),
    ).toBe(true);

    const a2 = await connect('alpha');
    const secondJoin = await call(a2, 'join_room', {
      roomId: 'depart-reconnect',
      name: 'alpha',
    });
    expect(secondJoin.participantId).toBe(firstJoin.participantId);

    await hostSays('depart-reconnect', '继续', 'alpha');
    expect((await detail('depart-reconnect')).room.turn?.name).toBe('alpha');
    await a2.close();
    expect(
      await until(async () => (await detail('depart-reconnect')).room.turn?.name === 'beta'),
    ).toBe(true);
    const messages = (await detail('depart-reconnect')).messages;
    expect(messages.at(-1)?.text).toBe('alpha 的轮次已交给 beta');
    await b.close();
  });

  it('D14: closing one of two live sessions for the same member keeps the turn', async () => {
    await newRoom('depart-two-live');
    const a1 = await connect('alpha');
    const a2 = await connect('alpha');
    const b = await connect('beta');
    await call(a1, 'join_room', { roomId: 'depart-two-live', name: 'alpha' });
    await call(a2, 'join_room', { roomId: 'depart-two-live', name: 'alpha' });
    await call(b, 'join_room', { roomId: 'depart-two-live', name: 'beta' });
    await hostSays('depart-two-live', '开始', 'alpha');

    await a1.close();
    await sleep(GONE_GRACE_MS * 3);
    expect((await detail('depart-two-live')).room.turn?.name).toBe('alpha');
    expect(
      (await detail('depart-two-live')).messages.some(
        (message: any) => message.text === 'alpha 的轮次已交给 beta',
      ),
    ).toBe(false);

    // The second session can still speak for alpha.
    const sent = await call(a2, 'send_message', {
      roomId: 'depart-two-live',
      text: '我还在',
    });
    expect(sent.message.id).toBeTruthy();
    await hostSays('depart-two-live', '轮到你了', 'alpha');
    await a2.close();
    expect(
      await until(async () => (await detail('depart-two-live')).room.turn?.name === 'beta'),
    ).toBe(true);
    await b.close();
  });

  it('D15: a dead session is retired after the retention window', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'arena-chat-retire-'));
    const manager = new RoomManager();
    manager.initializeDefaultRoom();
    const chat = new ChatManager(dir);
    chat.restoreAll();
    const localServer = createServer(
      createApp(manager, loadConfig({ ARENA_DATA_DIR: dir }), {
        chat,
        chatGoneGraceMs: 30,
        chatSessionRetentionMs: 80,
      }),
    );
    await new Promise<void>((resolve, reject) => {
      localServer.once('error', reject);
      localServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = localServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected a TCP address');
    }
    const localBase = `http://127.0.0.1:${address.port}`;
    try {
      const created = await fetch(`${localBase}/api/chat/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'retire' }),
      });
      expect(created.status).toBe(201);

      const client = new Client({ name: 'alpha', version: '0.0.1' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${localBase}/chat/mcp`)),
      );
      const join = await client.callTool({
        name: 'join_room',
        arguments: { roomId: 'retire', name: 'alpha' },
      });
      expect(payloadOf(join).participantId).toBeTruthy();
      const sessionId = (client.transport as StreamableHTTPClientTransport).sessionId;
      expect(sessionId).toBeTruthy();
      await client.close();

      await sleep(30 + 80 + 200);
      const response = await fetch(`${localBase}/chat/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(response.status).toBe(404);
    } finally {
      localServer.closeAllConnections();
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
