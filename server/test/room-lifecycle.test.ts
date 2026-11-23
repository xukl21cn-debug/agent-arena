import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { ChatManager } from '../src/chat/manager';
import { ChatRoom } from '../src/chat/chat-room';
import { ChatError, DEFAULT_CHAT_POLICY } from '../src/chat/model';
import { FileRoomRepository } from '../src/game/rooms/repository';
import { RoomManager } from '../src/game/rooms/room-manager';

/**
 * Room creation and lifecycle.
 *
 * The lobby's 新建 button depends on `POST /api/rooms` handing out its own id,
 * and the 删除 button depends on a delete that refuses to strand a live game.
 * Both are contracts, so they are tested through the HTTP surface rather than
 * the managers — the managers could be right while the routes stay wrong.
 */

let server: Server;
let baseUrl: string;
let dataDir: string;

async function post(
  pathname: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  return {
    status: response.status,
    json: await response.json().catch(() => null),
  };
}

async function del(pathname: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${pathname}`, { method: 'DELETE' });
  return {
    status: response.status,
    json: await response.json().catch(() => null),
  };
}

async function get(pathname: string): Promise<any> {
  return (await fetch(`${baseUrl}${pathname}`)).json();
}

function roomFile(roomId: string): string {
  return path.join(dataDir, 'rooms', `${roomId}.json`);
}

function chatFile(roomId: string): string {
  return path.join(dataDir, 'chat', `${roomId}.json`);
}

function payloadOf(result: Awaited<ReturnType<Client['callTool']>>): any {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === 'text')?.text;
  if (!text) {
    throw new Error('tool returned no text content');
  }
  return JSON.parse(text);
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  return payloadOf(await client.callTool({ name, arguments: args }));
}

async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: '0.0.1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/chat/mcp`)),
  );
  return client;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'arena-lifecycle-'));
  const manager = new RoomManager({ repository: new FileRoomRepository(dataDir) });
  manager.initializeDefaultRoom();
  const chat = new ChatManager(dataDir);
  chat.restoreAll();

  server = createServer(
    createApp(manager, loadConfig({ ARENA_DATA_DIR: dataDir }), { chat }),
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

describe('creating a room', () => {
  it('C1: hands out its own id when the caller names nothing', async () => {
    const first = await post('/api/rooms', {});
    expect(first.status).toBe(201);
    const firstId = first.json.state.roomId as string;
    // Not `default` (which always exists and would answer 409) and shaped like
    // the chat domain's generated ids.
    expect(firstId).toMatch(/^game-[0-9a-f]{6}$/);
    expect(firstId).not.toBe('default');

    const second = await post('/api/rooms', {});
    expect(second.status).toBe(201);
    expect(second.json.state.roomId).not.toBe(firstId);

    const listed = (await get('/api/rooms')) as Array<{ roomId: string }>;
    expect(listed.map((room) => room.roomId)).toEqual(
      expect.arrayContaining([firstId, second.json.state.roomId]),
    );
  });

  it('C2: keeps an explicit id', async () => {
    const created = await post('/api/rooms', { roomId: 'named-room' });
    expect(created.status).toBe(201);
    expect(created.json.state.roomId).toBe('named-room');
  });

  it('C3: still rejects a duplicate explicit id', async () => {
    const duplicate = await post('/api/rooms', { roomId: 'default' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.json.error.code).toBe('ROOM_EXISTS');
  });
});

describe('deleting a game room', () => {
  it('D1: deletes an idle room and keeps its archived game', async () => {
    const created = await post('/api/rooms', { roomId: 'archive-keeper' });
    expect(created.status).toBe(201);

    // One move, resign, then start the next game: that is when the finished
    // game is archived.
    await post('/api/rooms/archive-keeper/games', {});
    await post('/api/rooms/archive-keeper/moves', { row: 7, col: 7 });
    await post('/api/rooms/archive-keeper/resign', { actor: 'human' });
    // Starting the next game is what archives the finished one; resigning that
    // one too brings the room back to `finished` so it can be deleted.
    await post('/api/rooms/archive-keeper/games', {});
    await post('/api/rooms/archive-keeper/resign', { actor: 'human' });

    const archives = (await get('/api/archive')) as Array<{ roomId: string }>;
    expect(archives.some((item) => item.roomId === 'archive-keeper')).toBe(true);
    expect(existsSync(roomFile('archive-keeper'))).toBe(true);

    const removed = await del('/api/rooms/archive-keeper');
    expect(removed.status).toBe(204);

    const missing = await fetch(`${baseUrl}/api/rooms/archive-keeper`);
    expect(missing.status).toBe(404);
    expect(existsSync(roomFile('archive-keeper'))).toBe(false);

    // The replay is the room's lasting value: deleting the room must not
    // delete the record of the games it hosted.
    const after = (await get('/api/archive')) as Array<{ roomId: string }>;
    expect(after.some((item) => item.roomId === 'archive-keeper')).toBe(true);
  });

  it('D2: refuses while a game is in progress', async () => {
    await post('/api/rooms', { roomId: 'busy-room' });
    await post('/api/rooms/busy-room/games', {});

    const removed = await del('/api/rooms/busy-room');
    expect(removed.status).toBe(409);
    expect(removed.json.error.code).toBe('ROOM_BUSY');

    const still = await fetch(`${baseUrl}/api/rooms/busy-room`);
    expect(still.status).toBe(200);
  });

  it('D3: refuses while a side is ready and waiting', async () => {
    await post('/api/rooms', { roomId: 'ready-room' });
    await post('/api/rooms/ready-room/ready', {});

    const removed = await del('/api/rooms/ready-room');
    expect(removed.status).toBe(409);
    expect(removed.json.error.code).toBe('ROOM_BUSY');
  });

  it('D4: answers 404 for a room that is not there', async () => {
    const removed = await del('/api/rooms/never-existed');
    expect(removed.status).toBe(404);
    expect(removed.json.error.code).toBe('ROOM_NOT_FOUND');
  });

  it('D5: a deleted room cannot be resurrected by a stale reference', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'arena-ghost-'));
    try {
      const manager = new RoomManager({
        repository: new FileRoomRepository(dir),
      });
      const room = manager.create('ghost');
      const file = path.join(dir, 'rooms', 'ghost.json');
      expect(existsSync(file)).toBe(true);

      manager.remove('ghost');
      expect(existsSync(file)).toBe(false);

      // The lobby deleted the room; this object is what a parked request still
      // holds. Its next save must not recreate the file.
      room.newGame({});
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('deleting a chat room', () => {
  it('D6: deletes an empty room', async () => {
    const created = await post('/api/chat/rooms', {});
    expect(created.status).toBe(201);
    const roomId = created.json.room.id as string;
    expect(existsSync(chatFile(roomId))).toBe(true);

    const removed = await del(`/api/chat/rooms/${roomId}`);
    expect(removed.status).toBe(204);
    expect(existsSync(chatFile(roomId))).toBe(false);

    const missing = await fetch(`${baseUrl}/api/chat/rooms/${roomId}`);
    expect(missing.status).toBe(404);
  });

  it('D7: refuses while the transcript is open, then allows it after close', async () => {
    await post('/api/chat/rooms', { roomId: 'chat-busy' });
    await post('/api/chat/rooms/chat-busy/messages', { text: '留个记录' });

    const refused = await del('/api/chat/rooms/chat-busy');
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('ROOM_BUSY');
    expect(existsSync(chatFile('chat-busy'))).toBe(true);

    await post('/api/chat/rooms/chat-busy/close', {});
    const removed = await del('/api/chat/rooms/chat-busy');
    expect(removed.status).toBe(204);
    expect(existsSync(chatFile('chat-busy'))).toBe(false);
  });

  it('D8: a deleted chat room cannot be resurrected by a stale reference', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'arena-ghost-chat-'));
    try {
      const manager = new ChatManager(dir);
      const room = manager.create('ghost-chat');
      const file = path.join(dir, 'chat', 'ghost-chat.json');
      expect(existsSync(file)).toBe(true);

      manager.remove('ghost-chat');
      expect(existsSync(file)).toBe(false);

      room.sendMessage(room.humanMember(), '还在吗', {}, Date.now());
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('chat MCP joins', () => {
  it('J1: join_room creates the room and reports it', async () => {
    const client = await connect('lifecycle-joiner');
    try {
      const first = await call(client, 'join_room', {
        roomId: 'mcp-made',
        name: 'joiner',
      });
      expect(first.created).toBe(true);
      expect(first.room.id).toBe('mcp-made');

      // Rejoining the same room is a reconnect, not a second creation.
      const again = await call(client, 'join_room', {
        roomId: 'mcp-made',
        name: 'joiner',
      });
      expect(again.created).toBe(false);
      expect(again.participantId).toBe(first.participantId);

      const listed = (await get('/api/chat/rooms')) as Array<{ id: string }>;
      expect(listed.some((room) => room.id === 'mcp-made')).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

describe('chat policy tuning', () => {
  it('P1: raising the budget lifts the pause it caused', async () => {
    // maxHops 1 so a single agent line spends the whole budget.
    const created = await post('/api/chat/rooms', {
      roomId: 'budget-room',
      policy: { maxHops: 1 },
    });
    expect(created.status).toBe(201);

    const client = await connect('budget-spender');
    try {
      await call(client, 'join_room', { roomId: 'budget-room', name: 'spender' });
      await call(client, 'send_message', {
        roomId: 'budget-room',
        text: '预算就这么点',
      });

      const paused = (await get('/api/chat/rooms/budget-room')).room;
      expect(paused.phase).toBe('paused');
      expect(paused.hop).toBe(1);

      const raised = await post('/api/chat/rooms/budget-room/policy', {
        policy: { maxHops: 6 },
      });
      expect(raised.status).toBe(200);
      expect(raised.json.room.phase).toBe('open');
      expect(raised.json.room.hop).toBe(1);
      expect(raised.json.room.policy.maxHops).toBe(6);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('P2: refuses to cut a cap under what was already consumed', () => {
    const room = new ChatRoom('caps', 'caps', {
      ...DEFAULT_CHAT_POLICY,
      maxHops: 5,
    });
    const agent = room.join('a', undefined, 1_000);
    room.sendMessage(agent, '第一条', {}, 2_000);
    room.sendMessage(agent, '第二条', {}, 3_000);

    expect(room.hop).toBe(2);
    // Lower than the spent hop: the room would stop again on the next line.
    expect(() => room.setPolicy({ maxHops: 1 }, 4_000)).toThrow(ChatError);
    expect(room.policy.maxHops).toBe(5);

    // Same rule for the per-member cap, measured against the busiest member.
    expect(() => room.setPolicy({ maxMessagesPerMember: 1 }, 4_000)).toThrow(
      ChatError,
    );
    expect(room.policy.maxMessagesPerMember).toBe(
      DEFAULT_CHAT_POLICY.maxMessagesPerMember,
    );
  });

  it('P3: rejects an empty, unknown or out-of-range policy', async () => {
    await post('/api/chat/rooms', { roomId: 'policy-room' });

    const empty = await post('/api/chat/rooms/policy-room/policy', {
      policy: {},
    });
    expect(empty.status).toBe(400);

    const unknown = await post('/api/chat/rooms/policy-room/policy', {
      policy: { hopBudget: 10 },
    });
    expect(unknown.status).toBe(400);

    const outOfRange = await post('/api/chat/rooms/policy-room/policy', {
      policy: { maxHops: 0 },
    });
    expect(outOfRange.status).toBe(400);

    await post('/api/chat/rooms/policy-room/close', {});
    const closed = await post('/api/chat/rooms/policy-room/policy', {
      policy: { maxHops: 20 },
    });
    expect(closed.status).toBe(409);
    expect(closed.json.error.code).toBe('ROOM_CLOSED');
  });
});
