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
import { RoomManager } from '../src/rooms/room-manager';

// Both defects here were found by letting two real models converse (see
// docs/phases/13-p4-c25-chat-fix/observation.md §3): the domain layer was right and the
// MCP layer was wrong, so every test below drives real MCP sessions — the
// unit layer alone would stay green while the wire stays broken.
//
//   A3–A5  maxMessagesPerMember never fired because memberOf() handed
//          sendMessage a snapshot clone; the live counter stayed at 0.
//   B1–B5  wait_for_messages tail-sliced the unread range to 12 and said
//          nothing, so a catching-up client silently lost the oldest half.

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

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return payloadOf(await client.callTool({ name, arguments: args }));
}

/** Error tools answer as JSON {code, message}; return the code. */
async function errorCodeOf(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, 'expected the tool call to be refused').toBe(true);
  const text = (result.content as any[])[0].text as string;
  return JSON.parse(text).code;
}

async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: '0.0.1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/chat/mcp`)),
  );
  return client;
}

async function createRoom(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/chat/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function humanPost(roomId: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${baseUrl}/api/chat/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) {
    throw new Error(`human post failed with ${res.status}`);
  }
}

/** A room with `count` human lines and one agent joined. The human posts do
 *  not burn hop or per-member budget, so seq ends at exactly `count`. */
async function backlogRoom(roomId: string, count: number): Promise<Client> {
  await createRoom({ roomId, policy: { maxHops: 100 } });
  const a1 = await connect('a1');
  await call(a1, 'join_room', { roomId, name: 'a1' });
  for (let i = 1; i <= count; i += 1) {
    await humanPost(roomId, { text: `m#${i}` });
  }
  return a1;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'arena-chat-fix-'));
  const manager = new RoomManager();
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

describe('chat limits and cursors over MCP', () => {
  it('A3: over the wire, the send past maxMessagesPerMember is refused', async () => {
    await createRoom({
      roomId: 'limit-wire',
      policy: { maxMessagesPerMember: 2, maxHops: 50 },
    });
    const a1 = await connect('a1');
    const a2 = await connect('a2');
    try {
      await call(a1, 'join_room', { roomId: 'limit-wire', name: 'a1' });
      await call(a2, 'join_room', { roomId: 'limit-wire', name: 'a2' });
      await humanPost('limit-wire', { text: '开始', to: 'a1' });

      await call(a1, 'send_message', { roomId: 'limit-wire', text: 'a1-1' });
      await call(a2, 'send_message', { roomId: 'limit-wire', text: 'a2-1' });
      await call(a1, 'send_message', { roomId: 'limit-wire', text: 'a1-2' });
      await call(a2, 'send_message', { roomId: 'limit-wire', text: 'a2-2' });

      // The third send through the MCP identity path must be refused — the
      // counter behind the check is the live record, not a snapshot clone.
      const code = await errorCodeOf(a1, 'send_message', {
        roomId: 'limit-wire',
        text: 'a1-3',
      });
      expect(code).toBe('MEMBER_LIMIT_REACHED');
    } finally {
      await a1.close();
      await a2.close();
    }
  });

  it('A4: the refusal leaves no residue — no message, no hop, turn moved on', async () => {
    await createRoom({
      roomId: 'limit-residue',
      policy: { maxMessagesPerMember: 2, maxHops: 50 },
    });
    const a1 = await connect('a1');
    const a2 = await connect('a2');
    try {
      await call(a1, 'join_room', { roomId: 'limit-residue', name: 'a1' });
      await call(a2, 'join_room', { roomId: 'limit-residue', name: 'a2' });
      await humanPost('limit-residue', { text: '开始', to: 'a1' });
      await call(a1, 'send_message', { roomId: 'limit-residue', text: 'a1-1' });
      await call(a2, 'send_message', { roomId: 'limit-residue', text: 'a2-1' });
      await call(a1, 'send_message', { roomId: 'limit-residue', text: 'a1-2' });
      await call(a2, 'send_message', { roomId: 'limit-residue', text: 'a2-2' });

      await errorCodeOf(a1, 'send_message', {
        roomId: 'limit-residue',
        text: 'a1-3',
      });

      const detail = (await (
        await fetch(`${baseUrl}/api/chat/rooms/limit-residue`)
      ).json()) as any;
      const room = detail.room;
      const a1Member = room.members.find((m: any) => m.name === 'a1');
      expect(a1Member.messages).toBe(2); // the refused send did not count
      expect(room.hop).toBe(4); // no budget burned by the refusal
      expect(room.turn.name).toBe('a2'); // the rotation moved past a1
      const texts = detail.messages.map((m: any) => m.text) as string[];
      expect(texts).not.toContain('a1-3');
      // The skip is announced, not silent.
      expect(texts.some((t) => t.includes('已到个人发言上限'))).toBe(true);
    } finally {
      await a1.close();
      await a2.close();
    }
  });

  it('A5: three sends through MCP persist with the counter at 3, not 0', async () => {
    await createRoom({ roomId: 'counter-persist' });
    const a1 = await connect('a1');
    try {
      await call(a1, 'join_room', { roomId: 'counter-persist', name: 'a1' });
      await humanPost('counter-persist', { text: '开始', to: 'a1' });
      // Sole agent: each send rotates the turn back to itself.
      for (const text of ['第一', '第二', '第三']) {
        await call(a1, 'send_message', { roomId: 'counter-persist', text });
      }
    } finally {
      await a1.close();
    }

    // Reload from the same data dir the server persisted into.
    const reloaded = new ChatManager(dataDir);
    reloaded.restoreAll();
    const member = reloaded
      .getOrThrow('counter-persist')
      .snapshot()
      .members.find((m) => m.name === 'a1');
    expect(member?.messages).toBe(3);
  });

  it('B1: a cursor 20 messages behind gets the oldest 12 plus a truthful omission', async () => {
    const a1 = await backlogRoom('backlog-20', 20);
    try {
      const result = await call(a1, 'wait_for_messages', {
        roomId: 'backlog-20',
        afterSeq: 0,
      });
      expect(result.messages).toHaveLength(12);
      // Oldest first — the tail slice used to return #9..#20 and lose the rest.
      expect(result.messages[0].seq).toBe(1);
      expect(result.messages[11].seq).toBe(12);
      expect(result.omitted).toBe(8);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe(12);
    } finally {
      await a1.close();
    }
  });

  it('B2: following nextCursor drains the backlog, then hasMore flips false', async () => {
    const a1 = await backlogRoom('backlog-drain', 20);
    try {
      const first = await call(a1, 'wait_for_messages', {
        roomId: 'backlog-drain',
        afterSeq: 0,
      });
      expect(first.hasMore).toBe(true);

      const second = await call(a1, 'wait_for_messages', {
        roomId: 'backlog-drain',
        afterSeq: first.nextCursor,
        timeoutMs: 2000, // hasWakeup must answer immediately; no parking
      });
      expect(second.timedOut).toBe(false);
      expect(second.messages).toHaveLength(8);
      expect(second.messages[0].seq).toBe(13);
      expect(second.messages[7].seq).toBe(20);
      expect(second.omitted).toBe(0);
      expect(second.hasMore).toBe(false);
      expect(second.nextCursor).toBe(20);
    } finally {
      await a1.close();
    }
  });

  it('B3: a quiet wait reports nextCursor = the passed cursor and no omission', async () => {
    const a1 = await backlogRoom('quiet-room', 1); // one line seeds the turn to a1
    const a2 = await connect('a2');
    try {
      const joined = await call(a2, 'join_room', { roomId: 'quiet-room', name: 'a2' });
      const seq = joined.room.seq;

      const result = await call(a2, 'wait_for_messages', {
        roomId: 'quiet-room',
        afterSeq: seq,
        timeoutMs: 1500,
      });
      expect(result.timedOut).toBe(true);
      expect(result.messages).toHaveLength(0);
      // Not 0 — a 0 here would make the client re-read the whole history.
      expect(result.nextCursor).toBe(seq);
      expect(result.hasMore).toBe(false);
      expect(result.omitted).toBe(0);
    } finally {
      await a1.close();
      await a2.close();
    }
  });

  it('B4: when hasMore is true the hint says how many remain and how to get them', async () => {
    const a1 = await backlogRoom('hint-room', 13);
    try {
      const result = await call(a1, 'wait_for_messages', {
        roomId: 'hint-room',
        afterSeq: 0,
      });
      expect(result.hasMore).toBe(true);
      expect(result.hint).toContain('还有 1 条');
      expect(result.hint).toContain(`afterSeq=${result.nextCursor}`);
      expect(result.hint).toContain('hasMore');
    } finally {
      await a1.close();
    }
  });

  it('B5: exactly 12 unread — the boundary keeps hasMore false and the hint normal', async () => {
    const a1 = await backlogRoom('exact-12', 12);
    try {
      const result = await call(a1, 'wait_for_messages', {
        roomId: 'exact-12',
        afterSeq: 0,
      });
      expect(result.messages).toHaveLength(12);
      expect(result.omitted).toBe(0);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBe(12);
      expect(result.hint).not.toContain('还有'); // no drain instruction
    } finally {
      await a1.close();
    }
  });
});
