import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ChatMember } from '../src/chat/model';
import type { ChatRoom } from '../src/chat/chat-room';
import { ChatManager } from '../src/chat/manager';
import { CHAT_SWEEP_MS, startChatSweep } from '../src/chat/sweep';

// The lease sweep (HANDOFF-CHAT-LEASE): settlement of an expired turn is
// lazy and only fires when someone touches the room (send / pass / wait), so
// a room whose agents all left held its dead lease forever. ChatManager.sweep
// is the background pass that closes the hole; these tests pin both what it
// does and what it must not touch (live leases, paused/closed rooms, and
// snapshot()'s pure-read contract is never the mechanism).

const T0 = 1_000_000;

const tempRoots: string[] = [];
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'arena-chat-lease-'));
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

/** A room with a 1s lease, the given agents joined, turn parked on the first. */
function seededRoom(
  mgr: ChatManager,
  roomId: string,
  names: string[],
): { room: ChatRoom; members: ChatMember[] } {
  const room = mgr.create(roomId, { policy: { turnTimeoutMs: 1_000 } });
  const members = names.map((name, index) => room.join(name, undefined, T0 + index));
  // The human's opener posts at T0 + names.length → the lease ends at +1000.
  room.sendMessage(room.humanMember(), '开始', { to: names[0]! }, T0 + names.length);
  return { room, members };
}

describe('ChatManager.sweep (domain)', () => {
  it('T1: sweep settles an expired lease — the turn moves on with a timeout trace', () => {
    const mgr = manager();
    const { room, members } = seededRoom(mgr, 't1', ['alpha', 'beta']);

    mgr.sweep(T0 + 2_500);

    expect(room.snapshot().turn?.participantId).toBe(members[1]!.id);
    expect(
      room.transcript({}).messages.some((m) => m.text === 'alpha 超时，跳过'),
    ).toBe(true);
  });

  it('T2: sweep leaves a live lease alone — no turn change, no message', () => {
    const mgr = manager();
    const { room } = seededRoom(mgr, 't2', ['alpha', 'beta']);
    const before = room.snapshot();

    mgr.sweep(T0 + 2 + 500); // mid-lease

    const after = room.snapshot();
    expect(after.turn?.participantId).toBe(before.turn?.participantId);
    expect(after.seq).toBe(before.seq);
  });

  it('T3: a settling sweep emits change (persistence/WS ride on it); a no-op one stays silent', () => {
    const mgr = manager();
    const { room } = seededRoom(mgr, 't3', ['alpha', 'beta']);
    let fires = 0;
    room.subscribe(() => {
      fires += 1;
    });

    mgr.sweep(T0 + 500); // mid-lease: nothing happened, nobody is told
    expect(fires).toBe(0);

    mgr.sweep(T0 + 2_500); // settles: listeners fire
    expect(fires).toBe(1);
  });

  it('T4: a parked wait wakes from the sweep — resolved by the change, not its own timeout', async () => {
    const mgr = manager();
    const { room, members } = seededRoom(mgr, 't4', ['alpha', 'beta']);
    const cursor = room.snapshot().seq;

    const parked = room.wait(members[1]!.id, cursor, 10_000, T0 + 500);
    let woken = false;
    void parked.then(() => {
      woken = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(woken).toBe(false); // parked: turn on alpha, nothing new

    mgr.sweep(T0 + 2_500); // nobody in the room acts — only the sweep moves it
    const outcome = await parked;
    expect(woken).toBe(true);
    expect(outcome.timedOut).toBe(false); // woken by the settlement, not the 10s timer
    expect(room.unreadAfter(cursor, 10).messages.map((m) => m.text)).toContain(
      'alpha 超时，跳过',
    );
  });

  it('T5: paused and closed rooms are untouched by the sweep', () => {
    const mgr = manager();
    const paused = mgr.create('t5-paused', { policy: { turnTimeoutMs: 1_000 } });
    paused.join('alpha', undefined, T0);
    paused.sendMessage(paused.humanMember(), '开始', { to: 'alpha' }, T0);
    paused.pause(T0 + 1);
    const closed = mgr.create('t5-closed');
    closed.close(T0);
    const before = [paused.snapshot(), closed.snapshot()];

    mgr.sweep(T0 + 10_000);

    expect(paused.snapshot()).toEqual(before[0]);
    expect(closed.snapshot()).toEqual(before[1]);
  });

  it('T6: a room with no live turn sweeps cleanly', () => {
    const mgr = manager();
    const idle = mgr.create('t6');

    expect(() => mgr.sweep(T0)).not.toThrow();
    expect(idle.snapshot().seq).toBe(0);
    expect(idle.snapshot().phase).toBe('open');
  });

  it('T7: consecutive timeouts still pause the room — driven by sweeps alone', () => {
    const mgr = manager();
    const room = mgr.create('t7', { policy: { turnTimeoutMs: 1_000 } });
    room.join('solo', undefined, T0);
    room.sendMessage(room.humanMember(), '开始', { to: 'solo' }, T0);

    mgr.sweep(T0 + 2_500); // solo timeout #1 → the wrap hands solo a fresh lease
    expect(room.snapshot().phase).toBe('open');
    expect(room.snapshot().turn?.name).toBe('solo');

    mgr.sweep(T0 + 4_500); // solo timeout #2 → the two-strike pause, as before
    expect(room.snapshot().phase).toBe('paused');
    expect(room.snapshot().turn).toBeNull();
    expect(
      room.transcript({}).messages.some((m) => m.text.includes('连续第 2 次超时')),
    ).toBe(true);
  });

  it('one room throwing in the sweep does not stop the others from settling', () => {
    const mgr = manager();
    const boom = mgr.create('sweep-boom'); // iterated first: inserted first
    const { room } = seededRoom(mgr, 'sweep-ok', ['alpha', 'beta']);
    const settle = vi
      .spyOn(boom, 'settleExpiredTurn')
      .mockImplementation(() => {
        throw new Error('boom');
      });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => mgr.sweep(T0 + 2_500)).not.toThrow();
      expect(room.snapshot().turn?.name).toBe('beta'); // the healthy room settled anyway
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('sweep-boom'),
        expect.anything(),
      );
    } finally {
      errorLog.mockRestore();
      settle.mockRestore();
    }
  });
});

describe('the sweep timer', () => {
  it('T9: the timer is unref\'d — it cannot hold the process open', () => {
    const timer = startChatSweep(manager());
    try {
      expect(timer.hasRef()).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });

  it('drives chat.sweep on the interval, and clearInterval really stops it', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const mgr = manager();
      const { room } = seededRoom(mgr, 'timer', ['alpha', 'beta']);

      const timer = startChatSweep(mgr);
      vi.advanceTimersByTime(CHAT_SWEEP_MS + 100);
      expect(room.snapshot().turn?.name).toBe('beta'); // the tick settled the dead lease

      clearInterval(timer);
      vi.advanceTimersByTime(CHAT_SWEEP_MS * 4); // beta's 1s lease is long dead
      expect(room.snapshot().turn?.name).toBe('beta'); // no tick fired after the clear
      expect(room.snapshot().phase).toBe('open');
    } finally {
      vi.useRealTimers();
    }
  });
});

// -- end-to-end: the real process with the real 15s timer -------------------

function payloadOf(result: Awaited<ReturnType<Client['callTool']>>): any {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === 'text')?.text;
  if (!text) {
    throw new Error('tool returned no text content');
  }
  return JSON.parse(text);
}

async function until(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return predicate();
}

describe('lease sweep end-to-end (spawned server)', () => {
  it(
    'T8: a room whose agents all left recovers within a sweep cycle',
    { timeout: 60_000 },
    async () => {
      const e2eDir = mkdtempSync(path.join(os.tmpdir(), 'arena-chat-lease-e2e-'));
      tempRoots.push(e2eDir);
      const serverDir = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
      );
      const child: ChildProcess = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/index.ts'],
        {
          cwd: serverDir,
          env: {
            ...process.env,
            PORT: '3223',
            HOST: '127.0.0.1',
            ARENA_DATA_DIR: e2eDir,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      // Drain the pipes or the child blocks once a buffer fills.
      child.stdout.on('data', () => {});
      child.stderr.on('data', () => {});
      const base = 'http://127.0.0.1:3223';

      try {
        const up = await until(async () => {
          try {
            return (await fetch(`${base}/api/chat/rooms`)).ok;
          } catch {
            return false;
          }
        }, 20_000);
        expect(up).toBe(true);

        const created = await fetch(`${base}/api/chat/rooms`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ roomId: 'e2e', policy: { turnTimeoutMs: 1000 } }),
        });
        expect(created.status).toBe(201);

        const alice = new Client({ name: 'alice', version: '0.0.1' });
        const bob = new Client({ name: 'bob', version: '0.0.1' });
        await alice.connect(
          new StreamableHTTPClientTransport(new URL(`${base}/chat/mcp`)),
        );
        await bob.connect(
          new StreamableHTTPClientTransport(new URL(`${base}/chat/mcp`)),
        );
        const tool = async (
          client: Client,
          name: string,
          args: Record<string, unknown>,
        ) => payloadOf(await client.callTool({ name, arguments: args }));

        await tool(alice, 'join_room', { roomId: 'e2e', name: 'alice' });
        await tool(bob, 'join_room', { roomId: 'e2e', name: 'bob' });
        await fetch(`${base}/api/chat/rooms/e2e/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: '先请 alice', to: 'alice' }),
        });
        const sent = await tool(alice, 'send_message', {
          roomId: 'e2e',
          text: '我说完了',
          to: 'bob',
        });
        expect(sent.room.turn.name).toBe('bob');

        // Everyone leaves. The lease dies 1s later and nobody is left to
        // touch the room — before the sweep, it stayed stuck on bob forever.
        await alice.close();
        await bob.close();

        const recovered = await until(async () => {
          const detail = (await (
            await fetch(`${base}/api/chat/rooms/e2e`)
          ).json()) as any;
          return detail.messages.some((m: any) => m.text === 'bob 超时，跳过');
        }, 40_000);
        expect(recovered).toBe(true);
      } finally {
        child.kill();
        await new Promise<void>((resolve) => {
          child.once('exit', resolve);
          setTimeout(resolve, 5_000);
        });
      }
    },
  );
});
