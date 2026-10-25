import { describe, expect, it } from 'vitest';
import type { PlayerSpec, StoneColor } from '@arena/shared';
import { GameRoom } from '../src/rooms/room';

const SEATS: Record<StoneColor, PlayerSpec> = {
  black: { kind: 'human' },
  white: { kind: 'agent' },
};

function newRoom(): GameRoom {
  const room = new GameRoom('r1', { seats: SEATS });
  room.newGame({ agentColor: 'white' });
  return room;
}

describe('GameRoom identity resolution', () => {
  it('resolves a participant id to its seat', () => {
    const room = newRoom();
    const agent = room.join({ name: 'dsh', kind: 'agent', seat: 'white' });

    const identity = room.resolve({ participantId: agent.id });
    expect(identity.ok).toBe(true);
    if (identity.ok) {
      expect(identity.seat).toBe('white');
      expect(identity.participant.name).toBe('dsh');
    }
  });

  it('routes two agents to their own colors', () => {
    // The capability the old seat-keyed model could not express.
    const room = newRoom();
    const black = room.join({ name: 'dsh', kind: 'agent', seat: 'black' });
    const white = room.join({ name: 'codex', kind: 'agent', seat: 'white' });

    const a = room.resolve({ participantId: black.id });
    const b = room.resolve({ participantId: white.id });
    expect(a.ok && a.seat).toBe('black');
    expect(b.ok && b.seat).toBe('white');
  });

  it('refuses the legacy actor form once two agents are seated', () => {
    const room = newRoom();
    room.join({ name: 'dsh', kind: 'agent', seat: 'black' });
    room.join({ name: 'codex', kind: 'agent', seat: 'white' });

    const identity = room.resolve({ actor: 'agent' });
    expect(identity.ok).toBe(false);
    if (!identity.ok) {
      expect(identity.code).toBe('AMBIGUOUS_ACTOR');
      // The message has to tell the caller how to fix it.
      expect(identity.message).toContain('participantId');
    }
  });

  it('keeps the legacy actor form working with one agent', () => {
    const room = newRoom();
    const agent = room.join({ name: 'dsh', kind: 'agent', seat: 'white' });

    const identity = room.resolve({ actor: 'agent' });
    expect(identity.ok).toBe(true);
    if (identity.ok) {
      expect(identity.participant.id).toBe(agent.id);
      expect(identity.seat).toBe('white');
    }
  });

  it('falls back to the seat when no roster entry exists', () => {
    // A room created before participants existed must still answer.
    const room = newRoom();
    const identity = room.resolve({ actor: 'agent' });
    expect(identity.ok).toBe(true);
    if (identity.ok) {
      expect(identity.seat).toBe('white');
      expect(identity.participant.id).toBe('legacy:agent');
    }
  });

  it('reports an unknown participant id', () => {
    const room = newRoom();
    const identity = room.resolve({ participantId: 'p_nope00' });
    expect(identity.ok).toBe(false);
    if (!identity.ok) {
      expect(identity.code).toBe('PARTICIPANT_NOT_FOUND');
    }
  });

  it('reports a participant that holds no seat', () => {
    const room = newRoom();
    const watcher = room.join({ name: 'watcher', kind: 'human' });

    const identity = room.resolve({ participantId: watcher.id });
    expect(identity.ok).toBe(false);
    if (!identity.ok) {
      expect(identity.code).toBe('NOT_SEATED');
    }
  });

  it('mirrors a joined participant into the game seats', () => {
    const room = newRoom();
    const agent = room.join({ name: 'dsh', kind: 'agent', seat: 'white' });

    const seat = room.getState().seats.white;
    expect(seat.id).toBe(agent.id);
    expect(seat.name).toBe('dsh');
    expect(seat.kind).toBe('agent');
  });
});

describe('GameRoom acting as a participant', () => {
  it('moves for the right color when two agents share a room', () => {
    const room = newRoom();
    const black = room.join({ name: 'dsh', kind: 'agent', seat: 'black' });
    room.join({ name: 'codex', kind: 'agent', seat: 'white' });

    const result = room.moveAs({ participantId: black.id }, 7, 7);
    expect(result.ok).toBe(true);
    expect(room.getState().board[7]?.[7]).toBe('black');
  });

  it('rejects a move from a participant that is not seated', () => {
    const room = newRoom();
    const watcher = room.join({ name: 'watcher', kind: 'human' });

    const result = room.moveAs({ participantId: watcher.id }, 7, 7);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_SEATED');
    }
  });

  it('resigns for the resolved participant', () => {
    const room = newRoom();
    const black = room.join({ name: 'dsh', kind: 'agent', seat: 'black' });

    const result = room.resignAs({ participantId: black.id });
    expect(result.ok).toBe(true);
    expect(room.getState().status).toBe('finished');
    expect(room.getState().winner).toBe('white');
  });

  it('unseats a departing participant without ending the game', () => {
    const room = newRoom();
    const agent = room.join({ name: 'dsh', kind: 'agent', seat: 'white' });
    room.leave(agent.id);

    expect(room.getState().seats.white.id).toBeUndefined();
    // The seat keeps its kind so the board can still label it.
    expect(room.getState().seats.white.kind).toBe('agent');
    expect(room.getRoster()).toHaveLength(0);
  });
});
