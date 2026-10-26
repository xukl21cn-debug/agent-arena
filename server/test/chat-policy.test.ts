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
import { DEFAULT_CHAT_POLICY } from '../src/chat/model';
import { RoomManager } from '../src/rooms/room-manager';

// The REST layer used to read only `title` from POST /api/chat/rooms and drop
// `policy` without a word. These tests pin the wire contract: the policy takes
// effect, every field is validated, and an unknown field is an error — P8
// checks the behaviour (an expired turn really is skipped), not just the
// returned snapshot.

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

async function createRoom(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/chat/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'arena-chat-policy-'));
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

describe('chat room policy over REST', () => {
  it('P1: a full policy round-trips instead of silently falling back to defaults', async () => {
    const requested = {
      mode: 'mentions',
      maxHops: 5,
      maxMessagesPerMember: 3,
      turnTimeoutMs: 90_000,
      maxMessageChars: 500,
    };
    const created = await createRoom({ roomId: 'policy-full', policy: requested });
    expect(created.status).toBe(201);
    const { room } = (await created.json()) as any;
    expect(room.policy).toEqual(requested);
  });

  it('P2: a partial policy fills the missing fields from the defaults', async () => {
    const created = await createRoom({
      roomId: 'policy-partial',
      policy: { maxHops: 4 },
    });
    expect(created.status).toBe(201);
    const { room } = (await created.json()) as any;
    expect(room.policy).toEqual({ ...DEFAULT_CHAT_POLICY, maxHops: 4 });
  });

  it('P3: no policy keeps the defaults (no regression)', async () => {
    const created = await createRoom({ roomId: 'policy-none', title: '默认房' });
    expect(created.status).toBe(201);
    const { room } = (await created.json()) as any;
    expect(room.policy).toEqual(DEFAULT_CHAT_POLICY);
  });

  it('P4: an unknown mode is INVALID_REQUEST, not a silent default', async () => {
    const created = await createRoom({
      roomId: 'policy-bad-mode',
      policy: { mode: 'nope' },
    });
    expect(created.status).toBe(400);
    const payload = (await created.json()) as any;
    expect(payload.error.code).toBe('INVALID_REQUEST');
    expect(payload.error.message).toContain('mode');
  });

  it('P5: out-of-range and non-integer values are INVALID_REQUEST', async () => {
    const cases: Array<[string, unknown]> = [
      ['maxHops', 0],
      ['maxHops', 1001],
      ['maxMessagesPerMember', 0],
      ['turnTimeoutMs', 10],
      ['turnTimeoutMs', 600_001],
      ['maxMessageChars', 0],
      ['maxHops', 1.5],
      ['turnTimeoutMs', '2000'],
    ];
    for (const [field, value] of cases) {
      const created = await createRoom({
        roomId: 'policy-range',
        policy: { [field]: value },
      });
      expect(created.status, `${field}=${value} must be rejected`).toBe(400);
      const payload = (await created.json()) as any;
      expect(payload.error.code, `${field}=${value}`).toBe('INVALID_REQUEST');
    }
  });

  it('P6: an unknown policy field is INVALID_REQUEST — the misspelled-field trap', async () => {
    for (const field of ['nope', 'turnTimeoutsMs']) {
      const created = await createRoom({
        roomId: 'policy-unknown',
        policy: { [field]: 1 },
      });
      expect(created.status, `${field} must be rejected`).toBe(400);
      const payload = (await created.json()) as any;
      expect(payload.error.code).toBe('INVALID_REQUEST');
      expect(payload.error.message).toContain(field);
    }
  });

  it('P7: a non-object policy is INVALID_REQUEST', async () => {
    for (const value of ['x', 42, true, null, []]) {
      const created = await createRoom({
        roomId: 'policy-shape',
        policy: value,
      });
      expect(created.status, `policy=${String(value)} must be rejected`).toBe(400);
      const payload = (await created.json()) as any;
      expect(payload.error.code).toBe('INVALID_REQUEST');
    }
  });

  it('P8: a custom turnTimeoutMs really skips the expired turn (behaviour, not just the snapshot)', async () => {
    const created = await createRoom({
      roomId: 'policy-live',
      policy: { turnTimeoutMs: 1000 },
    });
    expect(created.status).toBe(201);

    const alpha = await connect('alpha');
    const beta = await connect('beta');
    try {
      await call(alpha, 'join_room', { roomId: 'policy-live', name: 'alpha' });
      await call(beta, 'join_room', { roomId: 'policy-live', name: 'beta' });

      const opened = await fetch(
        `${baseUrl}/api/chat/rooms/policy-live/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'alpha 先说', to: 'alpha' }),
        },
      );
      expect(opened.status).toBe(201);
      const { room } = (await opened.json()) as any;
      expect(room.turn.name).toBe('alpha');
      expect(room.turn.expiresAt).toBeGreaterThan(Date.now());

      // The room has no background clock: past the 1s lease nothing settles
      // on its own. The next touch must skip alpha and hand the turn to beta.
      await new Promise((r) => setTimeout(r, 1200));
      const nudged = await fetch(
        `${baseUrl}/api/chat/rooms/policy-live/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: '主持人推一下' }),
        },
      );
      expect(nudged.status).toBe(201);
      const { room: after, message } = (await nudged.json()) as any;
      expect(message.text).toBe('主持人推一下');
      expect(after.turn.name).toBe('beta');

      const transcript = (await (
        await fetch(`${baseUrl}/api/chat/rooms/policy-live/transcript`)
      ).json()) as any;
      const texts = transcript.messages.map((m: any) => m.text) as string[];
      expect(texts).toContain('alpha 超时，跳过');
    } finally {
      await alpha.close();
      await beta.close();
    }
  });
});
