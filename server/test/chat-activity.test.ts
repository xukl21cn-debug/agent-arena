import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { ChatManager } from '../src/chat/manager';
import { FileRoomRepository } from '../src/rooms/repository';
import { RoomManager } from '../src/rooms/room-manager';

/**
 * P5B's pre-fix and its regressions: the chat summary's `updatedAt` is the
 * room's real clock (L1–L3), the games keep theirs (L4), and the summary
 * shape the lobby renders stays what it was.
 */

let server: Server;
let baseUrl: string;
let dataDir: string;

async function post(pathname: string, body?: unknown): Promise<any> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function get(pathname: string): Promise<any> {
  return (await fetch(`${baseUrl}${pathname}`)).json();
}

async function chatList(): Promise<any[]> {
  return get('/api/chat/rooms') as Promise<any[]>;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'arena-lobby-'));
  const manager = new RoomManager({
    repository: new FileRoomRepository(dataDir),
  });
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

describe('chat room summary timestamps (the lobby sorts by these)', () => {
  it('L1: updatedAt does not drift while nothing happens', async () => {
    await post('/api/chat/rooms', { roomId: 'l1' });
    const first = (await chatList()).find((room: any) => room.id === 'l1');
    expect(first?.updatedAt).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = (await chatList()).find((room: any) => room.id === 'l1');
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it('L2: a new message moves updatedAt', async () => {
    const before = (await chatList()).find((room: any) => room.id === 'l1');
    const sent = await post('/api/chat/rooms/l1/messages', { text: 'moved' });
    expect(sent.status).toBe(201);

    const after = (await chatList()).find((room: any) => room.id === 'l1');
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect(after.updatedAt).toBe(sent.json.message.at);
  });

  it('L3: a room with no messages falls back to its creation time', async () => {
    await post('/api/chat/rooms', { roomId: 'l3' });
    const detail = await get('/api/chat/rooms/l3');
    const summary = (await chatList()).find((room: any) => room.id === 'l3');
    expect(summary.updatedAt).toBe(detail.room.createdAt);
  });

  it('follows the newest message, not the first', async () => {
    await post('/api/chat/rooms', { roomId: 'seq-room' });
    const first = await post('/api/chat/rooms/seq-room/messages', {
      text: 'one',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await post('/api/chat/rooms/seq-room/messages', {
      text: 'two',
    });
    const summary = (await chatList()).find(
      (room: any) => room.id === 'seq-room',
    );
    expect(summary.updatedAt).toBe(second.json.message.at);
    expect(summary.updatedAt).not.toBe(first.json.message.at);
  });

  it('survives a restart: the restored room reports the same clock', async () => {
    const before = (await chatList()).find((room: any) => room.id === 'l1');
    const rebooted = new ChatManager(dataDir);
    rebooted.restoreAll();
    const after = rebooted.list().find((room) => room.id === 'l1');
    expect(after?.updatedAt).toBe(before.updatedAt);
  });

  it('keeps the summary shape the lobby renders', async () => {
    await post('/api/chat/rooms', { roomId: 'shape', title: '卡片' });
    const entry = (await chatList()).find((room: any) => room.id === 'shape');
    expect(entry).toMatchObject({
      id: 'shape',
      title: '卡片',
      phase: 'open',
      // The reserved human member is present from creation.
      memberCount: 1,
      agentCount: 0,
      messageCount: 0,
      hop: 0,
      maxHops: 16,
    });
    expect(typeof entry.updatedAt).toBe('string');
  });

  it('carries the phase through the list as the room moves', async () => {
    await post('/api/chat/rooms', { roomId: 'phase-room' });
    await post('/api/chat/rooms/phase-room/pause');
    const paused = (await chatList()).find(
      (room: any) => room.id === 'phase-room',
    );
    expect(paused.phase).toBe('paused');
    await post('/api/chat/rooms/phase-room/close');
    const closed = (await chatList()).find(
      (room: any) => room.id === 'phase-room',
    );
    expect(closed.phase).toBe('closed');
  });

  it('still lists rooms by id, the oldest contract of this endpoint', async () => {
    await post('/api/chat/rooms', { roomId: 'zz-room' });
    await post('/api/chat/rooms', { roomId: 'aa-room' });
    const ids = (await chatList()).map((room: any) => room.id);
    const sorted = [...ids].sort((a: string, b: string) => a.localeCompare(b));
    expect(ids).toEqual(sorted);
  });
});

describe('game room summaries keep their own clock (regression)', () => {
  it('L4: updatedAt still comes from the game state and moves with moves', async () => {
    await post('/api/rooms', { roomId: 'l4' });
    await post('/api/rooms/l4/games', {});

    const beforeSummary = (await get('/api/rooms')).find(
      (room: any) => room.roomId === 'l4',
    );
    const beforeView = await get('/api/rooms/l4');
    expect(beforeSummary.updatedAt).toBe(beforeView.state.updatedAt);

    await new Promise((resolve) => setTimeout(resolve, 25));
    await post('/api/rooms/l4/moves', { row: 7, col: 7, actor: 'human' });

    const afterSummary = (await get('/api/rooms')).find(
      (room: any) => room.roomId === 'l4',
    );
    const afterView = await get('/api/rooms/l4');
    expect(afterSummary.updatedAt).toBe(afterView.state.updatedAt);
    expect(afterSummary.updatedAt).not.toBe(beforeSummary.updatedAt);
  });
});
