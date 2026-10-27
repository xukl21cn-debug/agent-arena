import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ChatRoom } from '../src/chat/chat-room';
import { ChatManager } from '../src/chat/manager';
import { ChatError, DEFAULT_CHAT_POLICY } from '../src/chat/model';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { RoomManager } from '../src/rooms/room-manager';

// pass_turn (HANDOFF-CHAT-PASS): an agent yields the turn without speaking —
// no hop, no chat message, one system trace, and the passer's timeout streak
// resets. P5 follows §1.3's timing discipline exactly: streaks are
// per-member, leases restart at each settle, so the person whose counter we
// are testing must time out (and pass) personally, with no foreign timeout
// in between.

const T0 = 1_000_000;

const tempRoots: string[] = [];
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'arena-chat-pass-'));
  tempRoots.push(dataDir);
});

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function manager(): ChatManager {
  return new ChatManager(dataDir);
}

function expectChatError(action: () => unknown, code: ChatError['code']): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).code).toBe(code);
    return;
  }
  throw new Error(`expected a ChatError ${code}, but nothing was thrown`);
}

describe('ChatRoom.passTurn (domain)', () => {
  it('P1: passing on your turn hands the turn to the next member in join order', () => {
    const room = manager().create('p1');
    const a = room.join('alpha', undefined, T0);
    const b = room.join('beta', undefined, T0 + 1);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);

    const turn = room.passTurn(a, undefined, T0 + 3);
    expect(turn?.participantId).toBe(b.id);
    expect(room.snapshot().turn?.participantId).toBe(b.id);
  });

  it('P2: pass consumes neither hop nor the passer counters', () => {
    const room = manager().create('p2');
    const a = room.join('alpha', undefined, T0);
    room.join('beta', undefined, T0 + 1);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);
    // One real send so the budget and the counter hold something to keep.
    room.sendMessage(a, '我说一句', { to: 'alpha' }, T0 + 3);
    const hopBefore = room.snapshot().hop;

    room.passTurn(a, undefined, T0 + 4);

    expect(room.snapshot().hop).toBe(hopBefore);
    expect(room.memberRef(a.id)!.messages).toBe(1);
  });

  it('P3: pass posts no chat message — the only trace is the system line', () => {
    const room = manager().create('p3');
    const a = room.join('alpha', undefined, T0);
    room.join('beta', undefined, T0 + 1);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);
    const chatBefore = room
      .transcript({})
      .messages.filter((m) => m.kind === 'chat').length;

    room.passTurn(a, undefined, T0 + 3);

    const messages = room.transcript({}).messages;
    expect(messages.filter((m) => m.kind === 'chat')).toHaveLength(chatBefore);
    expect(messages.at(-1)!.kind).toBe('system');
  });

  it('P4: the system message names the passer, the target, and reaches disk', () => {
    const room = manager().create('p4');
    const a = room.join('alpha', undefined, T0);
    room.join('beta', undefined, T0 + 1);
    room.join('gamma', undefined, T0 + 2);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 3);

    room.passTurn(a, undefined, T0 + 4);
    let last = room.transcript({ limit: 1 }).messages[0]!;
    expect(last.kind).toBe('system');
    expect(last.text).toBe('alpha 让出轮次');
    expect(last.hop).toBe(0);

    room.sendMessage(room.humanMember(), '再给 alpha', { to: 'alpha' }, T0 + 5);
    room.passTurn(a, 'gamma', T0 + 6);
    last = room.transcript({ limit: 1 }).messages[0]!;
    expect(last.text).toBe('alpha 把轮次交给 gamma');

    // emitChange is wired: the trace is persisted, not just in memory.
    const persisted = JSON.parse(
      readFileSync(path.join(dataDir, 'chat', 'p4.json'), 'utf8'),
    ) as { messages: Array<{ text: string }> };
    expect(persisted.messages.some((m) => m.text === 'alpha 让出轮次')).toBe(true);
  });

  it('P5: the passer\'s own pass clears their timeout streak; without it the room pauses', () => {
    // Leases restart at each settle, so every timestamp below is chosen
    // against the *previous settle moment*, not the send that opened it.
    const mgr = manager();
    const passed = mgr.create('p5-pass', { policy: { turnTimeoutMs: 1_000 } });
    const a = passed.join('alpha', undefined, 1_000);
    const b = passed.join('beta', undefined, 1_001);
    passed.sendMessage(passed.humanMember(), '开始', { to: 'alpha' }, 1_000);
    // alpha lease [1000, 2000)

    passed.settleExpiredTurn(2_500); // alpha timeout #1 → streak 1, beta lease [2500, 3500)
    expect(passed.snapshot().turn?.participantId).toBe(b.id);

    passed.sendMessage(b, 'beta 说', { to: 'alpha' }, 3_000); // alpha lease [3000, 4000)
    passed.passTurn(a, undefined, 3_500); // alpha's streak cleared, beta lease [3500, 4500)

    // Alpha must hold the turn again and let it expire himself — beta's
    // counter is a different one and proves nothing about alpha.
    passed.sendMessage(b, '再给 alpha', { to: 'alpha' }, 4_000); // alpha lease [4000, 5000)
    passed.settleExpiredTurn(5_500); // alpha timeout #2 → streak 1 again, NOT a pause

    expect(passed.snapshot().phase).toBe('open');
    expect(passed.snapshot().turn?.participantId).toBe(b.id);
    const texts = passed.transcript({}).messages.map((m) => m.text);
    expect(texts.filter((t) => t === 'alpha 超时，跳过')).toHaveLength(2);
    expect(texts).toContain('alpha 让出轮次');
    expect(texts.some((t) => t.includes('连续'))).toBe(false);

    // Control: the identical history without the pass — the second timeout
    // is streak 2 and the room pauses. Proves this harness can produce the
    // pause at all, so the "open" above is not a timing accident.
    const control = mgr.create('p5-ctrl', { policy: { turnTimeoutMs: 1_000 } });
    const ca = control.join('alpha', undefined, 1_000);
    const cb = control.join('beta', undefined, 1_001);
    control.sendMessage(control.humanMember(), '开始', { to: 'alpha' }, 1_000);
    control.settleExpiredTurn(2_500); // alpha streak 1
    control.sendMessage(cb, 'beta 说', { to: 'alpha' }, 3_000);
    control.settleExpiredTurn(4_500); // alpha streak 2 → paused
    expect(control.snapshot().phase).toBe('paused');
    expect(control.snapshot().turn).toBeNull();
    expect(ca.id).not.toBe(cb.id);
  });

  it('P6: passing out of turn is NOT_YOUR_TURN and leaves nothing behind', () => {
    const room = manager().create('p6');
    const a = room.join('alpha', undefined, T0);
    const b = room.join('beta', undefined, T0 + 1);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);
    const seqBefore = room.snapshot().seq;

    expectChatError(() => room.passTurn(b, undefined, T0 + 3), 'NOT_YOUR_TURN');
    expect(room.snapshot().turn?.participantId).toBe(a.id);
    expect(room.snapshot().seq).toBe(seqBefore);
  });

  it('P7: pass with no live turn is INVALID_REQUEST (send may claim a turn; pass cannot)', () => {
    const room = manager().create('p7');
    const a = room.join('alpha', undefined, T0);
    // Fresh room: nobody spoke, no turn exists.
    expectChatError(() => room.passTurn(a, undefined, T0 + 1), 'INVALID_REQUEST');

    // And after a pause/resume cycle clears the turn, still nothing to yield.
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);
    room.pause(T0 + 3);
    room.resume(T0 + 4);
    expectChatError(() => room.passTurn(a, undefined, T0 + 5), 'INVALID_REQUEST');
  });

  it('P8: `to` routes the turn to the named member on a fresh lease', () => {
    const room = manager().create('p8');
    const a = room.join('alpha', undefined, T0);
    room.join('beta', undefined, T0 + 1);
    const c = room.join('gamma', undefined, T0 + 2);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 3);

    const turn = room.passTurn(a, 'gamma', T0 + 4);
    expect(turn?.participantId).toBe(c.id);
    expect(turn?.name).toBe('gamma');
    expect(turn?.expiresAt).toBe(T0 + 4 + DEFAULT_CHAT_POLICY.turnTimeoutMs);
  });

  it('P9: `to` the human host is refused — humans never hold turns', () => {
    const room = manager().create('p9');
    const a = room.join('alpha', undefined, T0);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 1);

    expectChatError(() => room.passTurn(a, 'human', T0 + 2), 'INVALID_REQUEST');
    // An unknown name answers like send_message's, not with a new code.
    expectChatError(() => room.passTurn(a, 'nobody', T0 + 3), 'MEMBER_NOT_FOUND');
  });

  it('P10: `to` yourself is refused — yielding to yourself changes nothing', () => {
    const room = manager().create('p10');
    const a = room.join('alpha', undefined, T0);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 1);

    expectChatError(() => room.passTurn(a, 'alpha', T0 + 2), 'INVALID_REQUEST');
    expect(room.snapshot().turn?.participantId).toBe(a.id);
  });

  it('P11: a paused room refuses pass with ROOM_PAUSED', () => {
    const room = manager().create('p11');
    const a = room.join('alpha', undefined, T0);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 1);
    room.pause(T0 + 2);

    expectChatError(() => room.passTurn(a, undefined, T0 + 3), 'ROOM_PAUSED');
  });

  it('P12: a closed room refuses pass with ROOM_CLOSED', () => {
    const room = manager().create('p12');
    const a = room.join('alpha', undefined, T0);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 1);
    room.close(T0 + 2);

    expectChatError(() => room.passTurn(a, undefined, T0 + 3), 'ROOM_CLOSED');
  });

  it('pass wakes a parked waiter immediately (the domain half of P13)', async () => {
    const room = manager().create('p-wake');
    const a = room.join('alpha', undefined, T0);
    const b = room.join('beta', undefined, T0 + 1);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);

    const cursor = room.snapshot().seq;
    const parked = room.wait(b.id, cursor, 5_000, T0 + 3);
    let woken = false;
    void parked.then(() => {
      woken = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(woken).toBe(false); // parked: turn at alpha, nothing new

    room.passTurn(a, undefined, T0 + 3);
    const outcome = await parked;
    expect(outcome.timedOut).toBe(false);
    expect(woken).toBe(true);
  });
});

// -- MCP layer ---------------------------------------------------------------

let server: Server;
let baseUrl: string;

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
  const wireDir = mkdtempSync(path.join(os.tmpdir(), 'arena-chat-pass-wire-'));
  tempRoots.push(wireDir);
  const roomManager = new RoomManager();
  roomManager.initializeDefaultRoom();
  const chat = new ChatManager(wireDir);
  chat.restoreAll();

  server = createServer(
    createApp(roomManager, loadConfig({ ARENA_DATA_DIR: wireDir }), { chat }),
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
});

describe('pass_turn over /chat/mcp', () => {
  it('P13/P14/P15: A pass wakes B\'s parked wait at once, with the system line and the budget intact', async () => {
    const created = await fetch(`${baseUrl}/api/chat/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'pass-duel', title: '让轮' }),
    });
    expect(created.status).toBe(201);

    const dsh = await connect('dsh');
    const codex = await connect('codex');
    try {
      await call(dsh, 'join_room', { roomId: 'pass-duel', name: 'dsh' });
      await call(codex, 'join_room', { roomId: 'pass-duel', name: 'codex' });
      await fetch(`${baseUrl}/api/chat/rooms/pass-duel/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '先请 dsh', to: 'dsh' }),
      });
      // One real send so the hop has something to hold (P15).
      await call(dsh, 'send_message', {
        roomId: 'pass-duel',
        text: 'dsh 说完收工',
        to: 'codex',
      });

      // dsh parks for real: cursor at the latest seq, turn elsewhere.
      const dshCursor = (await call(dsh, 'get_transcript', {
        roomId: 'pass-duel',
        limit: 1,
      })) as any;
      const parkedAt = Date.now();
      const parked = call(dsh, 'wait_for_messages', {
        roomId: 'pass-duel',
        afterSeq: dshCursor.room.seq,
        timeoutMs: 10000,
      });
      let settled = false;
      void parked.then(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);

      const passed = await call(codex, 'pass_turn', { roomId: 'pass-duel' });
      expect(passed.passed).toBe(true);
      expect(passed.turn).toBe('dsh');
      expect(passed.hop).toBe('1/16'); // P15: the pass burned nothing

      const woke = await parked;
      expect(woke.timedOut).toBe(false);
      expect(Date.now() - parkedAt).toBeLessThan(2_000); // woken by the pass, not the 10s timeout
      expect(woke.yourTurn).toBe(true);
      expect(woke.room.hop).toBe(1); // P15, MCP view
      expect(
        woke.messages.some(
          (m: any) => m.kind === 'system' && m.text === 'codex 让出轮次',
        ),
      ).toBe(true); // P14

      // Out-of-turn pass answers with the same refusal shape as send_message.
      const rogue = await codex.callTool({
        name: 'pass_turn',
        arguments: { roomId: 'pass-duel' },
      });
      expect(rogue.isError).toBe(true);
      expect((rogue.content as any[])[0].text).toContain('NOT_YOUR_TURN');
    } finally {
      await dsh.close();
      await codex.close();
    }
  });

  it('P16: pass_turn is listed in tools/list and named in the instructions', async () => {
    const client = await connect('lister');
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('pass_turn');
      // The instructions are how a model learns the tool exists at all.
      expect(client.getInstructions()).toContain('pass_turn');
    } finally {
      await client.close();
    }
  });
});
