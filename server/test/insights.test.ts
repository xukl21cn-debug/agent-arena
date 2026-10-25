import { describe, expect, it } from 'vitest';
import type { GameState, HotPoint, Move, StoneColor } from '@arena/shared';
import { AGENT_RECENT_MOVES } from '@arena/shared';
import {
  createBoard,
  findWinLine,
} from '../src/core/rules';
import {
  findHotPoints,
  renderBoardText,
  toAgentStateView,
} from '../src/core/insights';
import { applyMove, createInitialState } from '../src/core/engine';

const RULES = {
  boardSize: 15,
  winLength: 5,
  overlineWin: true,
  forbidden: 'none',
} as const;

function boardWith(
  stones: ReadonlyArray<readonly [StoneColor, number, number]>,
): ReturnType<typeof createBoard> {
  const board = createBoard(15);
  for (const [color, row, col] of stones) {
    board[row]![col] = color;
  }
  return board;
}

function pointsAt(
  points: readonly HotPoint[],
  row: number,
  col: number,
): HotPoint | undefined {
  return points.find((point) => point.row === row && point.col === col);
}

/** Place a stone on a copy and hand it to findWinLine, as the engine would. */
function winsIfPlaced(
  board: ReturnType<typeof createBoard>,
  rules: typeof RULES | { boardSize: number; winLength: number; overlineWin: boolean; forbidden: 'none' },
  color: StoneColor,
  row: number,
  col: number,
): boolean {
  const scratch = board.map((line) => line.slice());
  scratch[row]![col] = color;
  return findWinLine(scratch, row, col, rules) !== null;
}

/** Game 2 (2026-10-23): black = human, white = GLM agent. */
const GAME2_MOVES: ReadonlyArray<readonly [number, number]> = [
  [7, 7], [8, 8], [7, 8], [7, 9], [9, 7], [8, 7], [8, 9], [9, 8],
  [7, 6], [7, 5], [6, 7], [9, 10], [5, 6], [4, 5], [5, 8], [8, 5],
  [5, 7], [5, 5], [6, 5], [8, 6], [8, 4], [8, 10], [4, 7], [3, 7], [7, 4],
];

function game2StateAfter(moveCount: number): GameState {
  let state: GameState = {
    ...createInitialState('room'),
    status: 'playing',
    gameId: 'g2',
  };
  for (let i = 0; i < moveCount; i += 1) {
    const [row, col] = GAME2_MOVES[i]!;
    const result = applyMove(state, i % 2 === 0 ? 'black' : 'white', row, col);
    if (!result.ok) {
      throw new Error(result.message);
    }
    state = result.state;
  }
  return state;
}

describe('findHotPoints', () => {
  it('returns nothing on an empty board', () => {
    expect(findHotPoints(createBoard(15), RULES)).toEqual({ black: [], white: [] });
  });

  it('marks both open ends of an open two as live-three makers', () => {
    const board = boardWith([['black', 7, 7], ['black', 7, 8]]);
    const hot = findHotPoints(board, RULES);

    // Extending a two in place, or one cell further with a gap, both leave
    // a live-three shape (the gap version still guarantees an open four).
    expect(pointsAt(hot.black, 7, 6)?.effect).toBe('open3');
    expect(pointsAt(hot.black, 7, 9)?.effect).toBe('open3');
    expect(pointsAt(hot.black, 7, 5)?.effect).toBe('open3');
    // Far stretchers create no three-level shape at all.
    expect(pointsAt(hot.black, 7, 4)).toBeUndefined();
    expect(pointsAt(hot.black, 7, 0)).toBeUndefined();
  });

  it('classifies rush four with its single five point', () => {
    const board = boardWith([
      ['white', 7, 3],
      ['black', 7, 4],
      ['black', 7, 5],
      ['black', 7, 7],
    ]);
    const hot = findHotPoints(board, RULES);

    const point = pointsAt(hot.black, 7, 6);
    expect(point?.effect).toBe('four');
    expect(point?.fiveAt).toEqual([{ row: 7, col: 8 }]);
  });

  it('classifies an open four as unstoppable with two five points', () => {
    const board = boardWith([
      ['black', 7, 5],
      ['black', 7, 6],
      ['black', 7, 7],
    ]);
    const hot = findHotPoints(board, RULES);

    const point = pointsAt(hot.black, 7, 4);
    expect(point?.effect).toBe('open4');
    expect(point?.fiveAt).toEqual([{ row: 7, col: 3 }, { row: 7, col: 8 }]);
  });

  it('flags the winning point of a four with one open end', () => {
    const board = boardWith([
      ['white', 7, 2],
      ['black', 7, 3],
      ['black', 7, 4],
      ['black', 7, 5],
      ['black', 7, 6],
    ]);
    const hot = findHotPoints(board, RULES);

    expect(pointsAt(hot.black, 7, 7)?.effect).toBe('win');
  });

  it('detects the split four that decided game 1 (diagonal with a gap)', () => {
    // Black played (8,3) ... (10,5) (11,6); the gap at (9,4) completed an
    // open four with both (7,2) and (12,7) empty. The agent lost to exactly
    // this shape - it must be impossible to miss in hotPoints.
    const board = boardWith([
      ['white', 0, 0],
      ['white', 0, 1],
      ['black', 8, 3],
      ['black', 10, 5],
      ['black', 11, 6],
    ]);
    const hot = findHotPoints(board, RULES);

    const point = pointsAt(hot.black, 9, 4);
    expect(point?.effect).toBe('open4');
    expect(point?.fiveAt).toEqual([{ row: 7, col: 2 }, { row: 12, col: 7 }]);
  });

  it('merges four + live three into double at game 2 move 21', () => {
    // Black (4,7) is a vertical rush four (fiveAt 3,7) plus an anti-diagonal
    // live three (3,8)/(7,4). v0.3 kept only the higher `four`, hiding the
    // two-step kill that decided the game.
    const state = game2StateAfter(21);
    const hot = findHotPoints(state.board, state.rules);
    const point = pointsAt(hot.black, 4, 7);

    expect(point?.effect).toBe('four');
    expect(point?.fiveAt).toEqual([{ row: 3, col: 7 }]);
    expect(point?.double).toEqual(['four', 'open3']);
    expect(point?.open3At).toHaveLength(2);
    expect(point?.open3At).toEqual(
      expect.arrayContaining([
        { row: 3, col: 8 },
        { row: 7, col: 4 },
      ]),
    );
  });

  it('does not mark an open four as double (game 2, moves 11 and 23)', () => {
    const after11 = game2StateAfter(11);
    const hot11 = findHotPoints(after11.board, after11.rules);

    expect(pointsAt(hot11.black, 5, 6)?.effect).toBe('open4');
    expect(pointsAt(hot11.black, 5, 6)?.double).toBeUndefined();
    expect(pointsAt(hot11.black, 9, 10)?.effect).toBe('open4');
    expect(pointsAt(hot11.black, 9, 10)?.double).toBeUndefined();

    const after23 = game2StateAfter(23);
    const hot23 = findHotPoints(after23.board, after23.rules);
    expect(pointsAt(hot23.black, 3, 8)?.effect).toBe('open4');
    expect(pointsAt(hot23.black, 3, 8)?.double).toBeUndefined();
    expect(pointsAt(hot23.black, 7, 4)?.effect).toBe('open4');
    expect(pointsAt(hot23.black, 7, 4)?.double).toBeUndefined();
  });

  it('does not promote a same-direction four + three to double', () => {
    // White (5,5) at game 2 move 17 is a four with fiveAt (6,5). The extra
    // three-windows are on the same vertical line: blocking (6,5) defuses
    // both, so this must stay a plain `four`.
    const state = game2StateAfter(17);
    const hot = findHotPoints(state.board, state.rules);
    const point = pointsAt(hot.white, 5, 5);

    expect(point?.effect).toBe('four');
    expect(point?.fiveAt).toEqual([{ row: 6, col: 5 }]);
    expect(point?.double).toBeUndefined();
    expect(point?.open3At).toBeUndefined();
  });

  it('marks two independent live threes as double open3', () => {
    // Placing (7,7) makes a horizontal live three (7,5)(7,7) with ends
    // (7,4)/(7,8) and a vertical live three (5,7)(7,7) with ends
    // (4,7)/(8,7). Different directions, no shared defense point.
    const board = boardWith([
      ['black', 7, 5],
      ['black', 7, 6],
      ['black', 5, 7],
      ['black', 6, 7],
    ]);
    const hot = findHotPoints(board, RULES);
    const point = pointsAt(hot.black, 7, 7);

    expect(point?.effect).toBe('open3');
    expect(point?.double).toEqual(['open3', 'open3']);
    expect(point?.open3At).toHaveLength(4);
    expect(point?.open3At).toEqual(
      expect.arrayContaining([
        { row: 7, col: 4 },
        { row: 7, col: 8 },
        { row: 4, col: 7 },
        { row: 8, col: 7 },
      ]),
    );
  });

  it('does not mark a plain live three as double', () => {
    const board = boardWith([
      ['black', 7, 5],
      ['black', 7, 6],
    ]);
    const hot = findHotPoints(board, RULES);

    expect(pointsAt(hot.black, 7, 7)?.effect).toBe('open3');
    expect(pointsAt(hot.black, 7, 7)?.double).toBeUndefined();
  });

  it('orders double fours before ordinary four candidates', () => {
    const state = game2StateAfter(21);
    const hot = findHotPoints(state.board, state.rules);
    const doubleIndex = hot.black.findIndex(
      (point) => point.row === 4 && point.col === 7,
    );
    const ordinaryIndex = hot.black.findIndex(
      (point) => point.row === 3 && point.col === 7,
    );

    expect(doubleIndex).toBeGreaterThanOrEqual(0);
    expect(ordinaryIndex).toBeGreaterThan(doubleIndex);
  });

  it('treats a split three with room as a live three', () => {
    // _ X X _ X _ : filling the gap yields an open four, so the gap itself
    // must surface as an open4 point, and the pattern is at least open3-live.
    const board = boardWith([
      ['black', 7, 6],
      ['black', 7, 7],
      ['black', 7, 9],
    ]);
    const hot = findHotPoints(board, RULES);

    expect(pointsAt(hot.black, 7, 8)?.effect).toBe('open4');
  });

  it('does not mutate the board it analyses', () => {
    const board = boardWith([
      ['black', 7, 5],
      ['black', 7, 6],
      ['white', 3, 3],
    ]);
    findHotPoints(board, RULES);

    expect(board[7]![4]).toBeNull();
    expect(board[7]![5]).toBe('black');
    expect(board[3]![3]).toBe('white');
    expect(board[0]![0]).toBeNull();
  });

  it('agrees with the engine on every win point and five point (invariant)', () => {
    // A dense middlegame-ish position: every reported win must be confirmed
    // by findWinLine, and completing any fiveAt must actually win.
    const board = boardWith([
      ['black', 7, 3], ['black', 7, 4], ['black', 7, 5], ['black', 7, 6],
      ['white', 6, 5], ['white', 6, 6], ['white', 6, 7],
      ['black', 8, 3], ['black', 10, 5], ['black', 11, 6],
      ['white', 9, 6], ['white', 9, 7], ['white', 9, 8],
    ]);
    const hot = findHotPoints(board, RULES);

    for (const color of ['black', 'white'] as const) {
      for (const point of hot[color]) {
        if (point.effect === 'win') {
          expect(winsIfPlaced(board, RULES, color, point.row, point.col)).toBe(true);
        } else {
          expect(winsIfPlaced(board, RULES, color, point.row, point.col)).toBe(false);
        }
        for (const five of point.fiveAt) {
          const withPoint = board.map((line) => line.slice());
          withPoint[point.row]![point.col] = color;
          expect(winsIfPlaced(withPoint, RULES, color, five.row, five.col)).toBe(true);
        }
      }
    }
  });

  it('respects exact-five rules: a six-line completion is not a win', () => {
    // overlineWin=false: filling the gap makes a six-run, which the engine
    // rejects; the pre-existing exact-five flank (7,2) stays a real win.
    const rules = { ...RULES, overlineWin: false };
    const board = boardWith([
      ['black', 7, 3],
      ['black', 7, 4],
      ['black', 7, 5],
      ['black', 7, 6],
      ['black', 7, 8],
    ]);
    const hot = findHotPoints(board, rules);

    expect(pointsAt(hot.black, 7, 7)?.effect).not.toBe('win');
    expect(pointsAt(hot.black, 7, 2)?.effect).toBe('win');
  });

  it('supports winLength=6: six in a row wins', () => {
    const rules = { ...RULES, winLength: 6 };
    const board = boardWith([
      ['black', 7, 3],
      ['black', 7, 4],
      ['black', 7, 5],
      ['black', 7, 6],
      ['black', 7, 7],
    ]);
    const hot = findHotPoints(board, rules);

    expect(pointsAt(hot.black, 7, 8)?.effect).toBe('win');
    expect(pointsAt(hot.black, 7, 2)?.effect).toBe('win');
  });

  it('caps the reference tier so decisive points stay visible', () => {
    // Black has a straight four (win/four makers); white has three separate
    // pairs, each spawning several open3 makers - more than the cap.
    const board = boardWith([
      ['black', 7, 5],
      ['black', 7, 6],
      ['black', 7, 7],
      ['black', 7, 8],
      ['white', 6, 5],
      ['white', 6, 6],
      ['white', 8, 5],
      ['white', 8, 6],
      ['white', 10, 5],
      ['white', 10, 6],
    ]);
    const hot = findHotPoints(board, RULES);

    expect(pointsAt(hot.black, 7, 4)?.effect).toBe('win');
    expect(pointsAt(hot.black, 7, 3)?.effect).toBe('four');
    expect(hot.black.filter((point) => point.effect === 'open3')).toEqual([]);
    const open3s = hot.white.filter((point) => point.effect === 'open3');
    expect(open3s.length).toBeGreaterThan(0);
    expect(open3s.length).toBeLessThanOrEqual(10);
  });
});

describe('renderBoardText', () => {
  function playedState() {
    let state = createInitialState('room');
    state = {
      ...state,
      status: 'playing',
      gameId: 'g1',
    };
    const first = applyMove(state, 'black', 7, 7);
    if (!first.ok) {
      throw new Error(first.message);
    }
    const second = applyMove(first.state, 'white', 8, 8);
    if (!second.ok) {
      throw new Error(second.message);
    }
    return second.state;
  }

  it('renders stones, empties and the latest move marker', () => {
    const text = renderBoardText(playedState());
    const lines = text.split('\n');

    expect(lines).toHaveLength(15 + 3); // header + 15 rows + legend + latest
    expect(lines[8]).toContain('X'); // row 7 (lines[0] is the column header)
    expect(lines[9]).toContain('o'); // row 8: white just moved -> lowercase
    expect(lines[8]).not.toContain('x'); // black's move is no longer latest
    expect(text).toContain('0-based');
  });

  it('has unambiguous column and row labels (no glued numbers)', () => {
    const lines = renderBoardText(playedState()).split('\n');

    const header = lines[0]!.trim().split(/\s+/);
    expect(header).toEqual(Array.from({ length: 15 }, (_, i) => String(i)));

    for (let row = 0; row < 15; row += 1) {
      const label = lines[row + 1]!.slice(0, 2);
      expect(label).toBe(String(row).padStart(2, '0'));
    }
  });

  it('marks the winning line when the game is finished', () => {
    let state = { ...createInitialState('room'), status: 'playing', gameId: 'g' };
    for (const [color, row, col] of [
      ['black', 7, 3],
      ['white', 0, 0],
      ['black', 7, 4],
      ['white', 0, 1],
      ['black', 7, 5],
      ['white', 0, 2],
      ['black', 7, 6],
      ['white', 0, 3],
      ['black', 7, 7],
    ] as const) {
      const result = applyMove(state, color, row, col);
      if (!result.ok) {
        throw new Error(result.message);
      }
      state = result.state;
    }

    expect(findWinLine(state.board, 7, 7, state.rules)?.length).toBe(5);
    const text = renderBoardText(state);
    expect(text).toContain('#');
    expect(text).toContain('五连');
  });
});

describe('toAgentStateView', () => {
  function stateAfter(moves: ReadonlyArray<readonly [StoneColor, number, number]>) {
    let state = { ...createInitialState('room'), status: 'playing', gameId: 'g' };
    const history: Move[] = [];
    for (const [color, row, col] of moves) {
      const result = applyMove(state, color, row, col);
      if (!result.ok) {
        throw new Error(result.message);
      }
      state = result.state;
      history.push(result.move);
    }
    return { state, history };
  }

  it('replaces the board array with boardText, moves and hotPoints', () => {
    const { state, history } = stateAfter([
      ['black', 7, 7],
      ['white', 8, 8],
      ['black', 7, 8],
    ]);
    const view = toAgentStateView(state, history);

    expect('board' in view).toBe(false);
    expect(view.moveCount).toBe(3);
    expect(view.movesOmitted).toBe(0);
    expect(view.moves).toEqual([
      { row: 7, col: 7, color: 'black', index: 1 },
      { row: 8, col: 8, color: 'white', index: 2 },
      { row: 7, col: 8, color: 'black', index: 3 },
    ]);
    expect(view.boardText).toContain('O'); // white stone (black moved last)
    expect(view.boardText).toContain('x'); // latest move marker on (7,8)
    // Black already has two stones in a row, so live-three makers exist;
    // white holds a single stone and cannot have a three-level point yet.
    expect(view.hotPoints.black.length).toBeGreaterThan(0);
    expect(view.hotPoints.white).toEqual([]);
  });

  it('carries double/open3At into the agent view', () => {
    const state = game2StateAfter(21);
    const view = toAgentStateView(state, null);
    const point = view.hotPoints.black.find(
      (candidate) => candidate.row === 4 && candidate.col === 7,
    );

    expect(point?.double).toEqual(['four', 'open3']);
    expect(point?.open3At).toHaveLength(2);
  });

  it('keeps only recent moves on the hot path and reports the omission', () => {
    // Same 46-stone middlegame as the demo, history padded to 100 moves.
    const { state } = stateAfter([['black', 7, 7], ['white', 8, 8]]);
    const history: Move[] = Array.from({ length: 100 }, (_, i) => ({
      row: Math.floor(i / 10),
      col: i % 10,
      color: i % 2 === 0 ? ('black' as const) : ('white' as const),
      index: i + 1,
      at: '',
    }));
    const longState = {
      ...state,
      moveCount: 100,
      lastMove: { ...history[99]!, index: 100 },
    };

    const hotPath = toAgentStateView(longState, history, {
      recentMoves: AGENT_RECENT_MOVES,
    });
    expect(hotPath.moves).toHaveLength(AGENT_RECENT_MOVES);
    expect(hotPath.moves[0]!.index).toBe(100 - AGENT_RECENT_MOVES + 1);
    expect(hotPath.movesOmitted).toBe(100 - AGENT_RECENT_MOVES);

    // get_state (no truncation) still carries the full history.
    const full = toAgentStateView(longState, history);
    expect(full.moves).toHaveLength(100);
    expect(full.movesOmitted).toBe(0);

    // The hot-path payload must stay well under the old full-history size.
    const payload = JSON.stringify({
      state: hotPath,
      yourColor: 'white',
      reason: 'your_turn',
    });
    expect(payload.length).toBeLessThanOrEqual(4000);
  });

  it('marks unknown history honestly instead of pretending it is empty', () => {
    const { state } = stateAfter([
      ['black', 7, 7],
      ['white', 8, 8],
      ['black', 7, 8],
    ]);
    const view = toAgentStateView(state, null);

    expect(view.moves).toEqual([]);
    expect(view.movesOmitted).toBe(3); // == state.moveCount
  });
});
