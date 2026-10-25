import { describe, expect, it } from 'vitest';
import { AGENT_RECENT_MOVES } from "@arena/shared";
import { GameRoom, RoomError } from '../src/rooms/room';
import { toAnyAgentStateView } from '../src/core/insights';

/**
 * Go wired into rooms (P3b-2): G7/G8/G17 and N1-N6 from the work order.
 * The rules themselves (capture/ko/suicide maths) were audited in P3a —
 * these tests pin the room dispatch around them, not the engine.
 */

function goRoom(): GameRoom {
  const room = new GameRoom('go-test');
  room.newGame({ game: 'go', agentColor: 'white' });
  return room;
}

/** The human seat moves for black, the agent seat for white. */
function play(room: GameRoom, color: 'black' | 'white', row: number, col: number) {
  const result = room.moveAs(
    { actor: color === 'black' ? 'human' : 'agent' },
    row,
    col,
  );
  if (!result.ok) {
    throw new Error(`expected ${color} (${row},${col}) to succeed: ${result.code}`);
  }
  return result;
}

describe('G7: new_game with game "go" turns the room into a Go game', () => {
  it('starts a 9x9 playing Go state with default rules', () => {
    const state = goRoom().getState();

    expect(state.game).toBe('go');
    expect(state.status).toBe('playing');
    if (state.game !== 'go') {
      throw new Error('expected a Go state');
    }
    expect(state.rules).toEqual({ boardSize: 9, komi: 7.5, koRule: 'simple' });
    expect(state.board).toHaveLength(9);
    expect(state.board.every((line) => line.length === 9)).toBe(true);
    expect(state.turn).toBe('black');
    expect(state.schemaVersion).toBe(2);
  });

  it('answers the room summary with the game discriminant', () => {
    expect(goRoom().getSummary().game).toBe('go');
  });
});

describe('N1: unsupported Go rules are rejected, not silently accepted', () => {
  it('rejects boardSize 13', () => {
    const room = new GameRoom('go-test');
    expect(() =>
      room.newGame({ game: 'go', boardSize: 13 }),
    ).toThrow(RoomError);
    try {
      room.newGame({ game: 'go', boardSize: 13 });
    } catch (error) {
      expect((error as RoomError).code).toBe('UNSUPPORTED_RULE');
    }
  });

  it('rejects a ko rule other than simple', () => {
    const room = new GameRoom('go-test');
    expect(() =>
      room.newGame({
        game: 'go',
        koRule: 'japanese' as unknown as 'simple',
      }),
    ).toThrow(RoomError);
  });

  it('rejects Go-only parameters for gomoku', () => {
    const room = new GameRoom('gomoku-test');
    expect(() => room.newGame({ komi: 7.5 })).toThrow(RoomError);
    expect(() => room.newGame({ koRule: 'simple' })).toThrow(RoomError);
  });

  it('accepts boardSize 9 and komi for Go', () => {
    const room = new GameRoom('go-test');
    room.newGame({ game: 'go', boardSize: 9, komi: 5.5 });
    const state = room.getState();
    if (state.game !== 'go') {
      throw new Error('expected a Go state');
    }
    expect(state.rules.komi).toBe(5.5);
  });
});

describe('N6: new_game without game stays gomoku (compatibility)', () => {
  it('starts a gomoku game when game is omitted', () => {
    const room = new GameRoom('room-1');
    room.newGame();
    expect(room.getState().game).toBe('gomoku');
    expect(room.getState().status).toBe('playing');
  });

  it('starts a gomoku game even with only agentColor given', () => {
    const room = new GameRoom('room-1');
    room.newGame({ agentColor: 'black' });
    expect(room.getState().game).toBe('gomoku');
  });

  it('switches a Go room back to gomoku when game is omitted', () => {
    const room = goRoom();
    room.newGame();
    const state = room.getState();
    expect(state.game).toBe('gomoku');
    if (state.game === 'gomoku') {
      expect(state.rules.boardSize).toBe(15);
    }
  });
});

describe('N2: captures bookkeeping follows the engine', () => {
  it('counts captured stones and records the emptied points', () => {
    const room = goRoom();
    // Black surrounds the white stone at (0,0) and takes it.
    play(room, 'black', 1, 0);
    play(room, 'white', 0, 0);
    play(room, 'black', 0, 1);

    const state = room.getState();
    if (state.game !== 'go') {
      throw new Error('expected a Go state');
    }
    expect(state.captures.black).toBe(1);
    expect(state.captures.white).toBe(0);
    expect(state.lastCaptured).toEqual([{ row: 0, col: 0 }]);
    expect(state.board[0]![0]).toBeNull();
    // The history carries the placement, and the view reports the capture.
    expect(room.getHistory()).toHaveLength(3);
  });
});

describe('N3: suicide is rejected and the board is untouched', () => {
  it('answers SUICIDE without changing the state', () => {
    const room = goRoom();
    play(room, 'black', 8, 0);
    play(room, 'white', 0, 1);
    play(room, 'black', 8, 1);
    play(room, 'white', 1, 0);

    const before = room.getState();
    const result = room.moveAs({ actor: 'human' }, 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SUICIDE');
    }
    // The failed move left state and move count exactly as they were.
    expect(room.getState()).toBe(before);
    expect(room.getState().moveCount).toBe(4);
  });
});

describe('N4: immediate ko recapture is forbidden', () => {
  it('sets the ko point and answers KO on the recapture', () => {
    const room = goRoom();
    play(room, 'black', 0, 1);
    play(room, 'white', 1, 1);
    play(room, 'black', 1, 0);
    play(room, 'white', 0, 2);
    play(room, 'black', 2, 1);
    play(room, 'white', 1, 3);
    play(room, 'black', 8, 8);
    play(room, 'white', 2, 2);

    // Black takes the single white stone at (1,1); the recapture point
    // becomes the ko point.
    const capture = play(room, 'black', 1, 2);
    let state = room.getState();
    if (state.game !== 'go') {
      throw new Error('expected a Go state');
    }
    expect(state.captures.black).toBe(1);
    expect(state.koPoint).toEqual({ row: 1, col: 1 });

    // White may not take back immediately.
    const recapture = room.moveAs({ actor: 'agent' }, 1, 1);
    expect(recapture.ok).toBe(false);
    if (!recapture.ok) {
      expect(recapture.code).toBe('KO');
    }
    // The board still holds black (1,2).
    state = room.getState();
    if (state.game !== 'go') {
      throw new Error('expected a Go state');
    }
    expect(state.board[1]![2]).toBe('black');
    expect(capture.move.index).toBe(9);
  });
});

describe('N5: pass counts as a move', () => {
  it('records the pass in history and switches the turn', () => {
    const room = goRoom();
    play(room, 'black', 8, 8);

    const passed = room.passAs({ actor: 'agent' });
    expect(passed.ok).toBe(true);

    const state = room.getState();
    if (state.game !== 'go') {
      throw new Error('expected a Go state');
    }
    expect(state.moveCount).toBe(2);
    expect(state.turn).toBe('black');
    expect(state.consecutivePasses).toBe(1);
    expect(state.koPoint).toBeNull();
    expect(state.lastCaptured).toEqual([]);
    const last = room.getHistory().at(-1);
    expect(last).toEqual({
      kind: 'pass',
      color: 'white',
      index: 2,
      at: expect.any(String),
    });

    // Two consecutive passes accumulate; the scoring transition is M3's.
    room.passAs({ actor: 'human' });
    const afterSecond = room.getState();
    if (afterSecond.game !== 'go') {
      throw new Error('expected a Go state');
    }
    expect(afterSecond.consecutivePasses).toBe(2);
    expect(afterSecond.status).toBe('playing');
  });
});

describe('G17: gomoku rooms reject the Go-only actions', () => {
  it('answers WRONG_GAME for pass and the scoring tools', () => {
    const room = new GameRoom('room-1');
    room.newGame();

    const pass = room.passAs({ actor: 'human' });
    expect(pass.ok).toBe(false);
    if (!pass.ok) {
      expect(pass.code).toBe('WRONG_GAME');
    }

    for (const probe of [
      () => room.markDeadAs({ actor: 'human' }, 0, 0),
      () => room.confirmScoreAs({ actor: 'human' }),
      () => room.resumePlayAs({ actor: 'human' }),
    ]) {
      const result = probe();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('WRONG_GAME');
      }
    }
  });

  it('answers NOT_SCORING for the scoring tools in a Go room', () => {
    const room = goRoom();

    const marked = room.markDeadAs({ actor: 'human' }, 0, 0);
    expect(marked.ok).toBe(false);
    if (!marked.ok) {
      expect(marked.code).toBe('NOT_SCORING');
    }

    const confirmed = room.confirmScoreAs({ actor: 'human' });
    expect(confirmed.ok).toBe(false);
    if (!confirmed.ok) {
      expect(confirmed.code).toBe('NOT_SCORING');
    }
  });
});

describe('G8: the Go agent view stays within its serialization budget', () => {
  it('serializes a 60-move position in at most 4000 characters', () => {
    const room = goRoom();
    // Fill rows left to right, alternating colours: no captures, no suicide,
    // every stone keeps a liberty below and (after row 0) above.
    for (let i = 0; i < 60; i += 1) {
      const color = i % 2 === 0 ? 'black' : 'white';
      play(room, color, Math.floor(i / 9), i % 9);
    }

    expect(room.getState().moveCount).toBe(60);

    const view = toAnyAgentStateView(
      room.getState(),
      room.getHistory(),
      { recentMoves: AGENT_RECENT_MOVES },
    );
    const serialized = JSON.stringify(view);
    expect(serialized.length).toBeLessThanOrEqual(4000);
  });

  it('renders the board picture and group summaries', () => {
    const room = goRoom();
    play(room, 'black', 4, 4);

    const view = toAnyAgentStateView(
      room.getState(),
      room.getHistory(),
      { recentMoves: AGENT_RECENT_MOVES },
    );
    // The `game` discriminant narrows the view union without a cast.
    if (view.game !== 'go') {
      throw new Error('expected a Go view');
    }
    expect(view.boardText).toContain('b'); // lowercase latest stone
    expect(view.groups.black).toHaveLength(1);
    expect(view.groups.black[0]!.liberties).toBe(4);
    expect(view.captures).toEqual({
      black: 0,
      white: 0,
      lastCaptured: [],
    });
    expect(view.scorePreview).toBeNull();
  });
});
