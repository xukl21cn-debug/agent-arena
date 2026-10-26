import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { ServerMessage } from '@arena/shared';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { ChatManager } from '../src/chat/manager';
import { attachWebSocket } from '../src/http/ws';
import { MemoryRoomRepository } from '../src/rooms/repository';
import { RoomManager } from '../src/rooms/room-manager';

/**
 * The chat half of /ws: `?kind=chat` sockets. W1 pins the game default
 * (no kind → game frames, unchanged), W4/W4b pin the persistence
 * regression — a WS subscriber must never replace the save subscriber.
 */

interface Arena {
  server: Server;
  wss: WebSocketServer;
  chat: ChatManager;
  baseUrl: string;
  wsUrl: string;
  stop(): Promise<void>;
}

function startArena(dataDir: string): Promise<Arena> {
  return new Promise((resolve) => {
    const manager = new RoomManager({
      repository: new MemoryRoomRepository(),
    });
    manager.initializeDefaultRoom();
    const chat = new ChatManager(dataDir);
    chat.restoreAll();
    const server = createServer(
      createApp(manager, loadConfig({ ARENA_DATA_DIR: dataDir }), { chat }),
    );
    const wss = attachWebSocket(server, manager, { chat });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('expected a TCP address');
      }
      resolve({
        server,
        wss,
        chat,
        baseUrl: `http://127.0.0.1:${address.port}`,
        wsUrl: `ws://127.0.0.1:${address.port}`,
        stop: async () => {
          for (const socket of wss.clients) {
            socket.terminate();
          }
          await new Promise<void>((done) => wss.close(() => done()));
          server.closeAllConnections();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

interface SocketHandle {
  socket: WebSocket;
  frames: ServerMessage[];
  waitUntil(
    predicate: (frame: ServerMessage) => boolean,
    timeoutMs?: number,
  ): Promise<void>;
  close(): Promise<void>;
}

function openSocket(url: string): Promise<SocketHandle> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const frames: ServerMessage[] = [];
    socket.on('message', (raw) => {
      frames.push(JSON.parse(raw.toString()) as ServerMessage);
    });
    socket.once('error', reject);
    socket.once('open', () => {
      const waitUntil = async (
        predicate: (frame: ServerMessage) => boolean,
        timeoutMs = 4_000,
      ): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        while (!frames.some(predicate)) {
          if (Date.now() > deadline) {
            throw new Error(`condition was not met in time; got ${frames.length} frames`);
          }
          await new Promise((tick) => setTimeout(tick, 20));
        }
      };
      resolve({
        socket,
        frames,
        waitUntil,
        close: () =>
          new Promise<void>((done) => {
            if (socket.readyState === WebSocket.CLOSED) {
              done();
              return;
            }
            socket.close();
            socket.once('close', () => done());
          }),
      });
    });
  });
}

function chatSocket(arena: Arena, roomId: string): Promise<SocketHandle> {
  return openSocket(`${arena.wsUrl}/ws?roomId=${roomId}&kind=chat`);
}

async function post(
  arena: Arena,
  pathname: string,
  body?: unknown,
): Promise<Record<string, any>> {
  const response = await fetch(`${arena.baseUrl}${pathname}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  return (await response.json()) as Record<string, any>;
}

async function createChatRoom(arena: Arena, roomId: string): Promise<void> {
  const created = await post(arena, '/api/chat/rooms', { roomId });
  expect(created.room?.id).toBe(roomId);
}

function roomFile(dataDir: string, roomId: string): unknown {
  return JSON.parse(
    readFileSync(path.join(dataDir, 'chat', `${roomId}.json`), 'utf8'),
  );
}

let dataDir: string;
let arena: Arena;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'arena-chat-ws-'));
  arena = await startArena(dataDir);
});

afterAll(async () => {
  await arena.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('chat over /ws?kind=chat', () => {
  it('W1: no kind still means the games — hello carries a board state, not a chat room', async () => {
    const handle = await openSocket(`${arena.wsUrl}/ws?roomId=default`);
    await handle.waitUntil((frame) => frame.type === 'hello');
    const hello = handle.frames.find((frame) => frame.type === 'hello') as {
      state?: { status?: string };
      kind?: string;
      room?: unknown;
    };
    expect(hello.state?.status).toBe('idle');
    expect(hello.kind).toBeUndefined();
    expect(hello.room).toBeUndefined();
    await handle.close();
  });

  it('W2: kind=chat hello carries the room snapshot and the recent messages', async () => {
    await createChatRoom(arena, 'w2-room');
    await post(arena, '/api/chat/rooms/w2-room/messages', {
      text: '开场白',
    });

    const handle = await chatSocket(arena, 'w2-room');
    await handle.waitUntil((frame) => frame.type === 'hello');
    const hello = handle.frames.find((frame) => frame.type === 'hello') as {
      kind?: string;
      room?: any;
      messages?: any[];
    };
    expect(hello.kind).toBe('chat');
    expect(hello.room.id).toBe('w2-room');
    expect(hello.room.phase).toBe('open');
    expect(hello.room.maxHops).toBe(16);
    expect(hello.room.members.map((m: any) => m.id)).toEqual(['human']);
    expect(hello.room.messageCount).toBe(1);
    expect(hello.messages).toHaveLength(1);
    expect(hello.messages[0]).toMatchObject({ text: '开场白', from: 'human' });

    // The shared ping handler moved above the kind branch; both kinds pong.
    handle.socket.send(JSON.stringify({ type: 'ping' }));
    await handle.waitUntil((frame) => frame.type === 'pong');
    await handle.close();
  });

  it('W3: a new message is broadcast as a message frame, then the room frame follows', async () => {
    await createChatRoom(arena, 'w3-room');
    const handle = await chatSocket(arena, 'w3-room');
    await handle.waitUntil((frame) => frame.type === 'hello');

    await post(arena, '/api/chat/rooms/w3-room/messages', { text: '第一条' });

    await handle.waitUntil((frame) => frame.type === 'message');
    const messageFrame = handle.frames.find(
      (frame) => frame.type === 'message',
    ) as any;
    expect(messageFrame.message).toMatchObject({
      text: '第一条',
      from: 'human',
      seq: 1,
    });
    await handle.waitUntil((frame) => frame.type === 'room');
    const roomFrame = handle.frames.find((frame) => frame.type === 'room') as any;
    expect(roomFrame.room.seq).toBe(1);
    // The message frame came before the room frame that wraps it.
    expect(
      handle.frames.findIndex((frame) => frame.type === 'message'),
    ).toBeLessThan(handle.frames.findIndex((frame) => frame.type === 'room'));
    await handle.close();
  });

  it('W4: with a ws subscriber attached, messages still reach the disk (§2.1)', async () => {
    await createChatRoom(arena, 'w4-room');
    const handle = await chatSocket(arena, 'w4-room');
    await handle.waitUntil((frame) => frame.type === 'hello');

    await post(arena, '/api/chat/rooms/w4-room/messages', {
      text: '落盘检查',
    });
    // The broadcast ran, so persistence had its chance too.
    await handle.waitUntil((frame) => frame.type === 'message');

    const file = roomFile(dataDir, 'w4-room') as { messages: any[] };
    expect(file.messages.map((message) => message.text)).toContain('落盘检查');
    await handle.close();
  });

  it('W4b: a room restored on boot keeps persisting while ws subscribers watch (§2.1, second wiring point)', async () => {
    await createChatRoom(arena, 'w4b-room');
    await post(arena, '/api/chat/rooms/w4b-room/messages', { text: '重启前' });

    // Simulated restart: a fresh process over the same data dir.
    const rebooted = await startArena(dataDir);
    try {
      const handle = await chatSocket(rebooted, 'w4b-room');
      await handle.waitUntil((frame) => frame.type === 'hello');
      const hello = handle.frames.find((frame) => frame.type === 'hello') as any;
      expect(hello.messages.map((m: any) => m.text)).toEqual(['重启前']);

      await post(rebooted, '/api/chat/rooms/w4b-room/messages', {
        text: '重启后',
      });
      await handle.waitUntil((frame) => frame.type === 'message');

      const file = roomFile(dataDir, 'w4b-room') as { messages: any[] };
      expect(file.messages.map((message) => message.text)).toEqual([
        '重启前',
        '重启后',
      ]);
      await handle.close();
    } finally {
      await rebooted.stop();
    }
  });

  it('W5: join and leave broadcast a room frame', async () => {
    await createChatRoom(arena, 'w5-room');
    const handle = await chatSocket(arena, 'w5-room');
    await handle.waitUntil((frame) => frame.type === 'hello');

    const room = arena.chat.getOrThrow('w5-room');
    const member = room.join('alpha', 'vitest', Date.now());
    await handle.waitUntil(
      (frame) =>
        frame.type === 'room' &&
        (frame as any).room.members.some(
          (m: any) => m.name === 'alpha' && m.kind === 'agent',
        ),
    );

    room.leave(member.id);
    await handle.waitUntil(
      (frame) =>
        frame.type === 'room' &&
        !(frame as any).room.members.some((m: any) => m.name === 'alpha'),
    );
    await handle.close();
  });

  it('W6: pause, resume and close each broadcast a room frame', async () => {
    await createChatRoom(arena, 'w6-room');
    const handle = await chatSocket(arena, 'w6-room');
    await handle.waitUntil((frame) => frame.type === 'hello');

    await post(arena, '/api/chat/rooms/w6-room/pause');
    await handle.waitUntil(
      (frame) => frame.type === 'room' && (frame as any).room.phase === 'paused',
    );
    await post(arena, '/api/chat/rooms/w6-room/resume');
    await handle.waitUntil(
      (frame) => frame.type === 'room' && (frame as any).room.phase === 'open',
    );
    await post(arena, '/api/chat/rooms/w6-room/close');
    await handle.waitUntil(
      (frame) => frame.type === 'room' && (frame as any).room.phase === 'closed',
    );
    await handle.close();
  });

  it('W7: an unknown chat room answers with an error frame and closes', async () => {
    const handle = await chatSocket(arena, 'ghost-chat');
    await handle.waitUntil(
      (frame) =>
        frame.type === 'error' && (frame as any).code === 'ROOM_NOT_FOUND',
    );
    await new Promise<void>((resolve) => {
      if (handle.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      handle.socket.once('close', () => resolve());
    });
    expect(handle.socket.readyState).toBe(WebSocket.CLOSED);
  });

  it('W8: every kind=chat socket in the room sees the same message', async () => {
    await createChatRoom(arena, 'w8-room');
    const first = await chatSocket(arena, 'w8-room');
    const second = await chatSocket(arena, 'w8-room');
    await first.waitUntil((frame) => frame.type === 'hello');
    await second.waitUntil((frame) => frame.type === 'hello');

    await post(arena, '/api/chat/rooms/w8-room/messages', { text: '群发' });

    for (const handle of [first, second]) {
      await handle.waitUntil(
        (frame) =>
          frame.type === 'message' && (frame as any).message.text === '群发',
      );
    }
    await first.close();
    await second.close();
  });

  it('W9: reconnecting replays the full state through hello, losing nothing', async () => {
    await createChatRoom(arena, 'w9-room');
    const first = await chatSocket(arena, 'w9-room');
    await first.waitUntil((frame) => frame.type === 'hello');
    await first.close();

    await post(arena, '/api/chat/rooms/w9-room/messages', { text: '断线一' });
    await post(arena, '/api/chat/rooms/w9-room/messages', { text: '断线二' });

    const second = await chatSocket(arena, 'w9-room');
    await second.waitUntil((frame) => frame.type === 'hello');
    const hello = second.frames.find((frame) => frame.type === 'hello') as any;
    expect(hello.messages.map((m: any) => m.text)).toEqual(['断线一', '断线二']);
    expect(hello.room.seq).toBe(2);
    expect(hello.room.messageCount).toBe(2);
    await second.close();
  });
});
