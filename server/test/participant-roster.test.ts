import { describe, expect, it } from 'vitest';
import { ParticipantRoster } from '../src/rooms/participant-roster';

const NOW = 1_800_000_000_000;

function roster(): ParticipantRoster {
  return new ParticipantRoster();
}

describe('ParticipantRoster', () => {
  it('assigns a stable id and the requested seat', () => {
    const reg = roster();
    const p = reg.join({ name: 'dsh', kind: 'agent', seat: 'white', now: NOW });

    expect(p.id).toMatch(/^p_[0-9a-f]{6}$/);
    expect(p.name).toBe('dsh');
    expect(p.seat).toBe('white');
    expect(reg.get(p.id)).toBe(p);
  });

  it('defaults a name when none is given', () => {
    const reg = roster();
    expect(reg.join({ kind: 'agent' }).name).toBe('agent');
    expect(reg.join({ kind: 'agent' }).name).toBe('agent-2');
    expect(reg.join({ kind: 'human' }).name).toBe('human');
  });

  it('treats a repeated name as a reconnect, not a new participant', () => {
    const reg = roster();
    const first = reg.join({ name: 'dsh', kind: 'agent', seat: 'white', now: NOW });
    const again = reg.join({
      name: 'dsh',
      kind: 'agent',
      seat: 'white',
      now: NOW + 5_000,
    });

    expect(again.id).toBe(first.id);
    expect(reg.list()).toHaveLength(1);
    expect(again.lastSeenAt).toBe(NOW + 5_000);
  });

  it('lets two agents coexist with distinct ids', () => {
    // The whole point of the model: both seats say `agent`, only ids differ.
    const reg = roster();
    const a = reg.join({ name: 'dsh', kind: 'agent', seat: 'black' });
    const b = reg.join({ name: 'codex', kind: 'agent', seat: 'white' });

    expect(a.id).not.toBe(b.id);
    expect(reg.byKind('agent')).toHaveLength(2);
    expect(reg.bySeat('black')?.id).toBe(a.id);
    expect(reg.bySeat('white')?.id).toBe(b.id);
  });

  it('evicts the previous holder when a seat is taken', () => {
    const reg = roster();
    const human = reg.join({ name: 'you', kind: 'human', seat: 'black' });
    const agent = reg.join({ name: 'dsh', kind: 'agent', seat: 'black' });

    expect(agent.seat).toBe('black');
    expect(human.seat).toBeNull();
    expect(reg.list()).toHaveLength(2);
  });

  it('frees the seat on leave', () => {
    const reg = roster();
    const p = reg.join({ name: 'dsh', kind: 'agent', seat: 'white' });

    expect(reg.leave(p.id)).toBe(true);
    expect(reg.get(p.id)).toBeUndefined();
    expect(reg.bySeat('white')).toBeUndefined();
    expect(reg.leave(p.id)).toBe(false);
  });

  it('trims and clamps display names', () => {
    const reg = roster();
    expect(reg.join({ name: '  dsh  ', kind: 'agent' }).name).toBe('dsh');
    expect(
      reg.join({ name: 'x'.repeat(50), kind: 'agent' }).name,
    ).toHaveLength(24);
  });

  it('keeps participants seatless until they choose', () => {
    const reg = roster();
    const p = reg.join({ name: 'watcher', kind: 'human' });
    expect(p.seat).toBeNull();
    expect(reg.bySeat('black')).toBeUndefined();
  });
});
