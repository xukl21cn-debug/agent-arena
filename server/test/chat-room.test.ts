import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ChatRoom, HUMAN_MEMBER_ID } from '../src/chat/chat-room';
import { ChatManager } from '../src/chat/manager';
import {
  CHAT_WAIT_MAX_MS,
  ChatError,
  DEFAULT_CHAT_POLICY,
  type ChatMessage,
} from '../src/chat/model';

const tempRoots: string[] = [];
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'arena-chat-test-'));
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

/** An agent joined under `name`, returning [room, member]. */
function joined(room: ChatRoom, name: string, now = 1000) {
  const member = room.join(name, 'test-client', now);
  return member;
}

const T0 = 1_000_000;

describe('ChatRoom basics', () => {
  it('C1: create joins the human member automatically and the snapshot is right', () => {
    const room = manager().create('c1', { title: '茶话会' });
    const snap = room.snapshot();

    expect(snap.id).toBe('c1');
    expect(snap.title).toBe('茶话会');
    expect(snap.phase).toBe('open');
    expect(snap.policy).toEqual(DEFAULT_CHAT_POLICY);
    expect(snap.seq).toBe(0);
    expect(snap.hop).toBe(0);
    expect(snap.turn).toBeNull();
    expect(snap.members.map((m) => m.id)).toEqual([HUMAN_MEMBER_ID]);
    expect(snap.members[0]!.kind).toBe('human');
  });

  it('C2: relay — the human redirects the turn with `to`', () => {
    const room = manager().create('c2');
    const dsh = joined(room, 'dsh');
    const codex = joined(room, 'codex');

    const message = room.sendMessage(
      room.humanMember(),
      '你们聊聊 MCP 的坑',
      { to: 'codex' },
      T0,
    );

    expect(message.hop).toBe(0); // humans never burn budget
    expect(message.fromName).toBe('human');
    expect(room.snapshot().turn?.participantId).toBe(codex.id);
    expect(room.snapshot().hop).toBe(0);
    expect(dsh.id).not.toBe(codex.id);
  });

  it('C3: relay — without `to` the turn rotates in join order after the speaker', () => {
    const room = manager().create('c3');
    const a = joined(room, 'alpha');
    const b = joined(room, 'beta');

    // Seed the rotation: the human opens, no `to` → first agent.
    room.sendMessage(room.humanMember(), '开始', {}, T0);
    expect(room.snapshot().turn?.participantId).toBe(a.id);

    // alpha speaks without `to` → beta (join order), hop and counters advance.
    const message = room.sendMessage(a, '我先说', {}, T0 + 1);
    expect(message.hop).toBe(1);
    expect(room.snapshot().turn?.participantId).toBe(b.id);
    expect(room.snapshot().hop).toBe(1);
    expect(a.messages).toBe(1);

    // beta names alpha as the next speaker explicitly.
    room.sendMessage(b, '我接着说', { to: 'alpha' }, T0 + 2);
    expect(room.snapshot().turn?.participantId).toBe(a.id);
    // ...and can name the human's agent by member name too (resolve by name).
    expect(room.snapshot().members.some((m) => m.name === 'alpha')).toBe(true);
  });

  it('C4: wait parks until a message lands, then wakes with the new data', async () => {
    const room = manager().create('c4');
    const a = joined(room, 'alpha');

    const parked = room.wait(a.id, 0, 5_000, T0);
    let woken = false;
    void parked.then((outcome) => {
      woken = true;
      return outcome;
    });

    // Give the event loop a tick — the waiter must be parked, not resolved.
    await new Promise((r) => setTimeout(r, 20));
    expect(woken).toBe(false);

    room.sendMessage(room.humanMember(), '唤醒', { to: 'alpha' }, T0 + 1);
    const outcome = await parked;
    expect(outcome.timedOut).toBe(false);
  });

  it('C5: wait times out with timedOut=true', async () => {
    const room = manager().create('c5');
    const a = joined(room, 'alpha');

    const outcome = await room.wait(a.id, 0, 40, T0);
    expect(outcome.timedOut).toBe(true);
  });

  it('C6: wait returns immediately when it is already your turn', async () => {
    const room = manager().create('c6');
    const a = joined(room, 'alpha');
    room.sendMessage(room.humanMember(), '该你了', { to: 'alpha' }, T0);

    const started = Date.now();
    const outcome = await room.wait(a.id, room.snapshot().seq, 10_000, T0 + 1);
    expect(outcome.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(CHAT_WAIT_MAX_MS);
  });

  it('C7: the hop budget pauses the room when exhausted', () => {
    const room = manager().create('c7', {
      title: '预算房',
    });
    room.pause(T0);
    room.resume(T0 + 1);
    // Shrink the budget by rebuilding with a tiny policy through the file model.
    const tiny = ChatRoom.fromSnapshotFile({
      ...room.toSnapshotFile(),
      policy: { ...DEFAULT_CHAT_POLICY, maxHops: 2 },
    });
    const a = tiny.join('alpha', undefined, T0 + 2);
    const b = tiny.join('beta', undefined, T0 + 3);
    tiny.sendMessage(tiny.humanMember(), '开始', { to: 'alpha' }, T0 + 4);

    tiny.sendMessage(a, '第一跳', {}, T0 + 5);
    expect(tiny.snapshot().phase).toBe('open');
    tiny.sendMessage(b, '第二跳', {}, T0 + 6);
    expect(tiny.snapshot().phase).toBe('paused');
    expect(tiny.snapshot().turn).toBeNull();
    const system = tiny.transcript({ limit: 5 }).messages;
    expect(system.at(-1)!.kind).toBe('system');
    expect(system.at(-1)!.text).toContain('hop');
  });

  it('C8: a member past its message limit is refused and skipped', () => {
    const room = ChatRoom.fromSnapshotFile({
      id: 'c8',
      title: '限额房',
      phase: 'open',
      policy: { ...DEFAULT_CHAT_POLICY, maxMessagesPerMember: 1 },
      seq: 0,
      hop: 0,
      createdAt: new Date(T0).toISOString(),
      members: [],
      messages: [],
      consecutiveTimeouts: {},
    });
    const a = room.join('alpha', undefined, T0);
    const b = room.join('beta', undefined, T0 + 1);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);

    room.sendMessage(a, '唯一一次', {}, T0 + 3);
    expect(room.snapshot().turn?.participantId).toBe(b.id);
    // Re-arm alpha's turn; the send is refused — and the rotation moves on
    // to beta instead of parking on the exhausted member.
    room.sendMessage(room.humanMember(), '还想让 alpha 说', { to: 'alpha' }, T0 + 3.5);
    expect(() => room.sendMessage(a, '第二次', {}, T0 + 4)).toThrow(
      /limit|上限/,
    );
    expect(room.snapshot().turn?.participantId).toBe(b.id);
    // The refusal left an event behind so observers see why the turn moved.
    expect(room.transcript({ limit: 2 }).messages.some((m) => m.kind === 'system')).toBe(true);
  });

  it('C9: an identical consecutive message is refused without burning hop', () => {
    const room = manager().create('c9');
    const a = joined(room, 'alpha');
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0);

    const first = room.sendMessage(a, '同样的话', {}, T0 + 1);
    expect(() => room.sendMessage(a, '同样的话', {}, T0 + 2)).toThrow(
      /identical|重复|相同/,
    );
    expect(room.snapshot().hop).toBe(1);
    expect(first.seq).toBe(2);
    // The turn did not move on the refused retry.
    expect(room.snapshot().turn?.participantId).toBe(a.id);
  });

  it('C10: an over-long message is refused', () => {
    const room = manager().create('c10');
    const a = joined(room, 'alpha');
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0);

    const long = 'x'.repeat(DEFAULT_CHAT_POLICY.maxMessageChars + 1);
    expect(() => room.sendMessage(a, long, {}, T0 + 1)).toThrow(/limit|characters|上限/);
    expect(room.snapshot().seq).toBe(1); // only the human's seed exists
    expect(room.snapshot().hop).toBe(0);
  });

  it('C11: pause / resume / close gate the room as promised', () => {
    const room = manager().create('c11');
    const a = joined(room, 'alpha');
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0);

    room.pause(T0 + 1);
    expect(room.snapshot().phase).toBe('paused');
    expect(() => room.sendMessage(a, '暂停时抢话', {}, T0 + 2)).toThrow(/paused|暂停/);
    // The host can still speak into a paused room.
    const hostLine = room.sendMessage(room.humanMember(), '主持人插话', {}, T0 + 3);
    expect(hostLine.kind).toBe('chat');

    room.resume(T0 + 4);
    expect(room.snapshot().phase).toBe('open');
    expect(room.snapshot().turn).toBeNull(); // rotation restarts

    room.close(T0 + 5);
    expect(room.snapshot().phase).toBe('closed');
    expect(() => room.sendMessage(a, '关了还说', {}, T0 + 6)).toThrow(/closed|关闭/);
    expect(() => room.join('late', undefined, T0 + 7)).toThrow(/closed|关闭/);
    // Idempotent close.
    expect(() => room.close(T0 + 8)).not.toThrow();
  });

  it('C12: transcript slices and counts the omitted head', () => {
    const room = manager().create('c12');
    const a = joined(room, 'alpha');
    room.sendMessage(room.humanMember(), '开场', { to: 'alpha' }, T0);
    for (let i = 0; i < 5; i += 1) {
      room.sendMessage(a, `第 ${i} 句`, {}, T0 + 1 + i);
      // The human hands the turn back to alpha for the next round.
      room.sendMessage(room.humanMember(), '继续', { to: 'alpha' }, T0 + 1.5 + i);
    }

    const full = room.transcript({});
    expect(full.messages).toHaveLength(11);
    expect(full.omitted).toBe(0);

    const slice = room.transcript({ limit: 4 });
    expect(slice.messages).toHaveLength(4);
    expect(slice.omitted).toBe(7);
    expect(slice.messages[0]!.seq).toBe(8);

    const after = room.transcript({ afterSeq: 10 });
    expect(after.messages.every((m) => m.seq > 10)).toBe(true);
    expect(after.messages).toHaveLength(1);
    // A caller-supplied cursor is its own knowledge, not an omission.
    expect(after.omitted).toBe(0);
  });

  it('C13: restoreAll brings chat rooms back with messages; corrupt files are skipped', () => {
    const first = manager();
    const room = first.create('c13', { title: '存续房' });
    const a = room.join('alpha', undefined, T0);
    room.sendMessage(room.humanMember(), '开场', { to: 'alpha' }, T0);
    room.sendMessage(a, '回应', {}, T0 + 1);
    first.create('c13-idle');

    // A corrupt file that must not break the boot.
    const chatDir = path.join(dataDir, 'chat');
    writeFileSync(path.join(chatDir, 'c13broken.json'), '{bad json', 'utf8');

    const second = manager();
    second.restoreAll();

    const restored = second.get('c13');
    expect(restored).toBeDefined();
    expect(restored!.snapshot().title).toBe('存续房');
    expect(restored!.snapshot().seq).toBe(2);
    const messages = restored!.transcript({}).messages;
    expect(messages.map((m: ChatMessage) => m.text)).toEqual(['开场', '回应']);
    // The duplicate guard survives the restart (rebuilt from the log).
    expect(() => restored!.sendMessage(a, '回应', {}, T0 + 2)).toThrow();
    // Idle room and human member are there; corrupt room is absent.
    expect(second.get('c13-idle')).toBeDefined();
    expect(second.get('c13-idle')!.snapshot().members.map((m) => m.id)).toContain(HUMAN_MEMBER_ID);
    expect(second.get('c13broken')).toBeUndefined();
    expect(readdirSync(chatDir).some((n) => n === 'c13broken.json')).toBe(true);
    expect(existsSync(path.join(chatDir, 'c13.json.tmp'))).toBe(false);
  });

  it('A1: the send past maxMessagesPerMember is refused with MEMBER_LIMIT_REACHED', () => {
    const room = manager().create('limit-domain', {
      policy: { maxMessagesPerMember: 2, maxHops: 50 },
    });
    const a1 = joined(room, 'a1');
    const a2 = joined(room, 'a2');
    room.sendMessage(room.humanMember(), '开始', { to: 'a1' }, T0);
    room.sendMessage(a1, 'a1-1', {}, T0 + 1);
    room.sendMessage(a2, 'a2-1', {}, T0 + 2);
    room.sendMessage(a1, 'a1-2', {}, T0 + 3);
    room.sendMessage(a2, 'a2-2', {}, T0 + 4);
    expect(a1.messages).toBe(2);

    let caught: unknown;
    try {
      room.sendMessage(a1, 'a1-3', {}, T0 + 5);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChatError);
    expect((caught as ChatError).code).toBe('MEMBER_LIMIT_REACHED');
  });

  it('A2: memberRef returns the live record — writes through it reach the snapshot', () => {
    const room = manager().create('ref-domain');
    const a1 = joined(room, 'a1');
    const ref = room.memberRef(a1.id);
    // join hands out the live record; memberRef must be that same object,
    // not another copy — a copy is exactly what made the counter stick at 0.
    expect(ref).toBe(a1);
    ref!.messages = 4;
    expect(room.snapshot().members.find((m) => m.id === a1.id)?.messages).toBe(4);
  });
});
