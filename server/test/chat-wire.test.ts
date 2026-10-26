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

async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: '0.0.1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/chat/mcp`)),
  );
  return client;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'arena-chat-wire-'));
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

describe('chat over the wire', () => {
  it('REST: create, list, speak as human, pause/resume, transcript', async () => {
    const created = await fetch(`${baseUrl}/api/chat/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'wire', title: '线上房' }),
    });
    expect(created.status).toBe(201);
    const { room } = (await created.json()) as any;
    expect(room.id).toBe('wire');
    expect(room.members.map((m: any) => m.id)).toEqual(['human']);

    const list = (await (await fetch(`${baseUrl}/api/chat/rooms`)).json()) as any[];
    expect(list.map((r) => r.id)).toContain('wire');

    const spoke = await fetch(`${baseUrl}/api/chat/rooms/wire/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '主持人开场' }),
    });
    expect(spoke.status).toBe(201);
    const { message } = (await spoke.json()) as any;
    expect(message.from).toBe('human');
    expect(message.hop).toBe(0);

    const detail = (await (await fetch(`${baseUrl}/api/chat/rooms/wire`)).json()) as any;
    expect(detail.messages).toHaveLength(1);

    const paused = await fetch(`${baseUrl}/api/chat/rooms/wire/pause`, { method: 'POST' });
    expect(((await paused.json()) as any).room.phase).toBe('paused');
    // A human post is still allowed while paused.
    const hostLine = await fetch(`${baseUrl}/api/chat/rooms/wire/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '暂停中的插话' }),
    });
    expect(hostLine.status).toBe(201);
    const resumed = await fetch(`${baseUrl}/api/chat/rooms/wire/resume`, { method: 'POST' });
    expect(((await resumed.json()) as any).room.phase).toBe('open');

    const transcript = (await (
      await fetch(`${baseUrl}/api/chat/rooms/wire/transcript?format=md`)
    ).json()) as any;
    expect(transcript.format).toBe('md');
    expect(transcript.text).toContain('**human**');

    // Errors answer in the chat error shape, with the game routes untouched.
    const missing = await fetch(`${baseUrl}/api/chat/rooms/nope/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.code).toBe('ROOM_NOT_FOUND');
  });

  it('/chat/mcp: two agents join, take relay turns, and read the transcript', async () => {
    await fetch(`${baseUrl}/api/chat/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'duel', title: '对聊' }),
    });

    const dsh = await connect('dsh');
    const codex = await connect('codex');
    try {
      const dshJoin = await call(dsh, 'join_room', { roomId: 'duel', name: 'dsh' });
      expect(dshJoin.participantId).toEqual(expect.any(String));
      const codexJoin = await call(codex, 'join_room', { roomId: 'duel', name: 'codex' });
      expect(codexJoin.participantId).not.toBe(dshJoin.participantId);

      // The human opens from REST and names dsh.
      await fetch(`${baseUrl}/api/chat/rooms/duel/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '先请 dsh 说说', to: 'dsh' }),
      });

      // dsh is on turn: an immediate wait returns with yourTurn and a hint.
      const dshWait = await call(dsh, 'wait_for_messages', { roomId: 'duel' });
      expect(dshWait.yourTurn).toBe(true);
      expect(dshWait.hint).toContain('轮到你');

      // codex parks for real: with the cursor at the latest seq and the turn
      // elsewhere, the call must hang — and dsh's send wakes it.
      const codexCursor = await call(codex, 'get_transcript', { roomId: 'duel', limit: 1 });
      const parked = call(codex, 'wait_for_messages', {
        roomId: 'duel',
        afterSeq: codexCursor.room.seq,
        timeoutMs: 10000,
      });
      let parkedSettled = false;
      void parked.then((r) => {
        parkedSettled = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(parkedSettled).toBe(false);

      const dshSend = await call(dsh, 'send_message', {
        roomId: 'duel',
        text: 'MCP 最大的坑是会话黏性',
        to: 'codex',
      });
      expect(dshSend.message.hop).toBe(1);
      expect(dshSend.room.turn.name).toBe('codex');

      const codexWait = await parked;
      expect(codexWait.timedOut).toBe(false);
      expect(codexWait.messages.map((m: any) => m.text)).toContain(
        'MCP 最大的坑是会话黏性',
      );
      expect(codexWait.yourTurn).toBe(true);

      const codexSend = await call(codex, 'send_message', {
        roomId: 'duel',
        text: '我遇到的是工具数量爆炸',
        to: 'dsh',
      });
      expect(codexSend.message.hop).toBe(2);

      // Out-of-turn sends are refused with a model-actionable error:
      // codex just handed the turn to dsh, so codex speaking again is refused.
      const rogue = await codex.callTool({
        name: 'send_message',
        arguments: { roomId: 'duel', text: '还没轮到我' },
      });
      expect(rogue.isError).toBe(true);
      const rogueText = (rogue.content as any[])[0].text as string;
      expect(rogueText).toContain('NOT_YOUR_TURN');

      const transcript = await call(dsh, 'get_transcript', { roomId: 'duel' });
      const texts = transcript.messages.map((m: any) => m.text) as string[];
      expect(texts).toContain('先请 dsh 说说');
      expect(texts).toContain('MCP 最大的坑是会话黏性');
      expect(transcript.room.hop).toBe(2);
    } finally {
      await dsh.close();
      await codex.close();
    }
  });

  it('/chat/mcp refuses tools before join_room with an identity error', async () => {
    const stranger = await connect('stranger');
    try {
      const result = await stranger.callTool({
        name: 'send_message',
        arguments: { roomId: 'duel', text: '我没进房' },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any[])[0].text).toContain('IDENTITY_REQUIRED');
    } finally {
      await stranger.close();
    }
  });
});
