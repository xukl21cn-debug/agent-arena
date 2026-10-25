import { describe, expect, it } from 'vitest';
import type { AnyGameState, AnyMove, GoPassMove, GoState } from '@arena/shared';
import { createInitialState } from '../src/core/engine';
import { migrateSnapshot, type PersistedRoomV1 } from '../src/rooms/repository';

const NOW = '2026-10-25T00:00:00.000Z';

/**
 * The narrowing contract of the AnyGameState union: `game` is a required
 * discriminant on every member, so checking it must narrow without a cast.
 * If this function ever needs an `as`, the union design has broken.
 */
function assertGo(state: AnyGameState): GoState {
  if (state.game !== 'go') {
    throw new Error('not go');
  }
  return state;
}

function makeGoState(overrides: Partial<GoState> = {}): GoState {
  return {
    game: 'go',
    schemaVersion: 2,
    roomId: 'room-go',
    gameId: 'game-1',
    rules: { boardSize: 9, komi: 7.5, koRule: 'simple' },
    board: Array.from({ length: 9 }, () => Array<null>(9).fill(null)),
    turn: 'black',
    status: 'playing',
    seats: { black: { kind: 'human' }, white: { kind: 'agent' } },
    winner: null,
    endReason: null,
    winLine: null,
    lastMove: null,
    moveCount: 0,
    version: 0,
    updatedAt: NOW,
    captures: { black: 0, white: 0 },
    lastCaptured: [],
    koPoint: null,
    consecutivePasses: 0,
    deadStones: [],
    scoreConfirmed: { black: false, white: false },
    score: null,
    ...overrides,
  };
}

describe('AnyGameState narrowing (T4)', () => {
  it('narrows to GoState after the game check, without a cast', () => {
    const goState = makeGoState();
    expect(assertGo(goState)).toBe(goState);
  });

  it('rejects a gomoku state', () => {
    const gomoku = createInitialState('room-1', undefined, NOW);
    expect(() => assertGo(gomoku)).toThrow('not go');
  });
});

describe('AnyMove discrimination (T3)', () => {
  it('tells a pass apart from a placement by the kind field', () => {
    const pass: GoPassMove = {
      kind: 'pass',
      color: 'white',
      index: 5,
      at: NOW,
    };
    const moves: AnyMove[] = [
      { row: 2, col: 3, color: 'black', index: 4, at: NOW },
      pass,
    ];
    const kinds = moves.map((move) => ('kind' in move ? move.kind : 'place'));
    expect(kinds).toEqual(['place', 'pass']);
  });
});

describe('v1 snapshot migration (T2)', () => {
  it('fills in game "gomoku" and bumps schemaVersion for v1 snapshots', () => {
    const state = createInitialState('room-1', undefined, NOW);
    // Rebuild a v1 snapshot: strip the fields v1 did not have.
    const { game: _game, schemaVersion: _schemaVersion, ...rest } = state;
    const v1: PersistedRoomV1 = {
      id: 'room-1',
      state: { ...rest, schemaVersion: 1 },
      history: [],
      commentary: [],
    };

    const migrated = migrateSnapshot(v1);
    expect(migrated.state).toEqual({
      ...v1.state,
      game: 'gomoku',
      schemaVersion: 2,
    });
  });

  it('passes a v2 snapshot through unchanged', () => {
    const v2 = {
      id: 'room-1',
      state: createInitialState('room-1', undefined, NOW),
      history: [],
      commentary: [],
    };

    expect(migrateSnapshot(v2)).toEqual(v2);
  });
});
