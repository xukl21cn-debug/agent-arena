import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ChatManager } from '../src/chat/manager';

// memberGone (auto-pass on session drop): a member whose session ended is
// marked gone — out of the rotation, never assigned a turn — and a turn
// parked on it is handed back at once. Any tool call (touch) or a fresh
// join revives the member. The lease remains the fallback for clients that
// cannot signal death.

const T0 = 1_000_000;

const tempRoots: string[] = [];
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'arena-chat-depart-'));
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

const lastText = (room: ReturnType<ChatManager['create']>): string =>
  room.messages.at(-1)?.text ?? '';

describe('ChatRoom.memberGone (domain)', () => {
  it('D1: a gone member holding the turn hands it to the next live one', () => {
    const room = manager().create('d1');
    const a = room.join('alpha', undefined, T0);
    const b = room.join('beta', undefined, T0 + 1);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);
    expect(room.snapshot().turn?.participantId).toBe(a.id);

    room.memberGone(a.id, T0 + 3);

    expect(room.snapshot().turn?.participantId).toBe(b.id);
    expect(lastText(room)).toBe('alpha 退出，把轮次交给 beta');
  });

  it('D2: alone with the turn, the gone member hands it to the host', () => {
    const room = manager().create('d2');
    const a = room.join('alpha', undefined, T0);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);

    room.memberGone(a.id, T0 + 3);

    expect(room.snapshot().turn).toBeNull();
    expect(lastText(room)).toBe('alpha 退出，把轮次交还给主持人');
  });

  it('D3: both gone — the first departure re-homes the turn, the second is silent', () => {
    const room = manager().create('d3');
    const a = room.join('alpha', undefined, T0);
    room.join('beta', undefined, T0 + 1);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);

    room.memberGone(a.id, T0 + 3); // turn → beta
    room.memberGone('beta-id-nope', T0 + 4); // unknown id: no-op
    room.memberGone(room.snapshot().turn!.participantId, T0 + 4); // beta gone → host

    expect(room.snapshot().turn).toBeNull();
    expect(lastText(room)).toBe('beta 退出，把轮次交还给主持人');
  });

  it('D4: a gone member not holding the turn leaves it untouched', () => {
    const room = manager().create('d4');
    const a = room.join('alpha', undefined, T0);
    const b = room.join('beta', undefined, T0 + 1);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);
    const seqBefore = room.snapshot().seq;

    room.memberGone(b.id, T0 + 3);

    expect(room.snapshot().turn?.participantId).toBe(a.id);
    expect(room.snapshot().seq).toBe(seqBefore); // no system line
  });

  it('D5: rotation and makeTurn skip gone members entirely', () => {
    const room = manager().create('d5');
    const a = room.join('alpha', undefined, T0);
    const b = room.join('beta', undefined, T0 + 1);
    const c = room.join('gamma', undefined, T0 + 2);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 3);

    room.memberGone(b.id, T0 + 4);
    // alpha speaks with no explicit target: rotation must land on gamma.
    room.sendMessage(a, '接着说', undefined, T0 + 5);

    expect(room.snapshot().turn?.participantId).toBe(c.id);
  });

  it('D6: naming a gone member in pass_turn hands the turn to the host', () => {
    const room = manager().create('d6');
    const a = room.join('alpha', undefined, T0);
    room.join('beta', undefined, T0 + 1);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);
    const betaId = room
      .snapshot()
      .members.find((m) => m.name === 'beta')!.id;
    room.memberGone(betaId, T0 + 3);

    room.passTurn(a, 'beta', T0 + 4);

    expect(room.snapshot().turn).toBeNull();
    expect(lastText(room)).toBe('beta 已退出，alpha 把轮次交还给主持人');
  });

  it('D7: touch revives a gone member — the turn may land on them again', () => {
    const room = manager().create('d7');
    const a = room.join('alpha', undefined, T0);
    const b = room.join('beta', undefined, T0 + 1);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);
    room.memberGone(b.id, T0 + 3);

    room.touch(b.id, T0 + 4); // beta calls wait_for_messages again
    room.sendMessage(a, '轮到你了', { to: 'beta' }, T0 + 5);

    expect(room.snapshot().turn?.participantId).toBe(b.id);
  });

  it('D8: a fresh join revives a gone member', () => {
    const room = manager().create('d8');
    const a = room.join('alpha', undefined, T0);
    const b = room.join('beta', undefined, T0 + 1);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);
    room.memberGone(b.id, T0 + 3);

    room.join('beta', undefined, T0 + 4); // reconnect reclaims the record
    room.sendMessage(a, '轮到你了', { to: 'beta' }, T0 + 5);

    expect(room.snapshot().turn?.participantId).toBe(b.id);
  });

  it('D9: the human "member" is never marked gone', () => {
    const room = manager().create('d9');
    room.join('alpha', undefined, T0);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);
    const seqBefore = room.snapshot().seq;

    room.memberGone('human', T0 + 3);

    expect(room.snapshot().seq).toBe(seqBefore);
    expect(room.snapshot().turn?.name).toBe('alpha');
  });

  it('D10: after the turn lands on the host, a revived member waits for the host', () => {
    const room = manager().create('d10');
    const a = room.join('alpha', undefined, T0);
    room.sendMessage(room.humanMember(), '开始', { to: 'alpha' }, T0 + 2);
    room.memberGone(a.id, T0 + 3); // alone → host
    expect(room.snapshot().turn).toBeNull();

    room.touch(a.id, T0 + 4); // revived
    // The turn stays with the host until the host speaks — revive does not
    // steal it back.
    expect(room.snapshot().turn).toBeNull();

    room.sendMessage(room.humanMember(), '继续', { to: 'alpha' }, T0 + 5);
    expect(room.snapshot().turn?.participantId).toBe(a.id);
  });
});
