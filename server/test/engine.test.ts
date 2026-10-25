import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES,
  type GameState,
  type PlayerSpec,
  type RuleSet,
  type StoneColor,
} from '@arena/shared';
import {
  applyMove,
  createInitialState,
  opposite,
  resignGame,
  startGame,
} from '../src/core/engine';
import {
  createBoard,
  findWinLine,
  isBoardFull,
  isInside,
  resolveRules,
} from '../src/core/rules';

const NOW = '2026-01-01T00:00:00.000Z';
const GAME_ID = 'game-1';

const SEATS: Record<StoneColor, PlayerSpec> = {
  black: { kind: 'human' },
  white: { kind: 'agent' },
};

type MoveTuple = readonly [StoneColor, number, number];

const horizontalWin: ReadonlyArray<MoveTuple> = [
  ['black', 7, 3],
  ['white', 0, 0],
  ['black', 7, 4],
  ['white', 0, 1],
  ['black', 7, 5],
  ['white', 0, 2],
  ['black', 7, 6],
  ['white', 0, 3],
  ['black', 7, 7],
];

const verticalWin: ReadonlyArray<MoveTuple> = [
  ['black', 3, 7],
  ['white', 0, 0],
  ['black', 4, 7],
  ['white', 0, 1],
  ['black', 5, 7],
  ['white', 0, 2],
  ['black', 6, 7],
  ['white', 0, 3],
  ['black', 7, 7],
];

const diagonalWin: ReadonlyArray<MoveTuple> = [
  ['black', 3, 3],
  ['white', 0, 0],
  ['black', 4, 4],
  ['white', 0, 1],
  ['black', 5, 5],
  ['white', 0, 2],
  ['black', 6, 6],
  ['white', 0, 3],
  ['black', 7, 7],
];

const antiDiagonalWin: ReadonlyArray<MoveTuple> = [
  ['black', 3, 11],
  ['white', 0, 0],
  ['black', 4, 10],
  ['white', 0, 1],
  ['black', 5, 9],
  ['white', 0, 2],
  ['black', 6, 8],
  ['white', 0, 3],
  ['black', 7, 7],
];

function playingState(rules?: Partial<RuleSet>): GameState {
  const initial = createInitialState('test-room', rules, NOW);
  return startGame(initial, SEATS, { gameId: GAME_ID, now: NOW });
}

function play(
  state: GameState,
  color: StoneColor,
  row: number,
  col: number,
): GameState {
  const result = applyMove(state, color, row, col, NOW);
  if (!result.ok) {
    throw new Error(`Unexpected move failure: ${result.code} ${result.message}`);
  }
  return result.state;
}

function playMoves(
  moves: ReadonlyArray<MoveTuple>,
  base: GameState = playingState(),
): GameState {
  return moves.reduce(
    (state, [color, row, col]) => play(state, color, row, col),
    base,
  );
}

function expectWin(state: GameState, color: StoneColor): void {
  expect(state.status).toBe('finished');
  expect(state.winner).toBe(color);
  expect(state.endReason).toBe('five');
  expect(state.winLine?.length).toBeGreaterThanOrEqual(5);
}

describe('createInitialState', () => {
  it('creates an idle, empty board with default rules', () => {
    const state = createInitialState('room-1', undefined, NOW);

    expect(state.schemaVersion).toBe(1);
    expect(state.roomId).toBe('room-1');
    expect(state.gameId).toBe('');
    expect(state.status).toBe('idle');
    expect(state.turn).toBe('black');
    expect(state.rules).toEqual(DEFAULT_RULES);
    expect(state.board).toHaveLength(DEFAULT_RULES.boardSize);
    expect(
      state.board.every((row) => row.length === DEFAULT_RULES.boardSize),
    ).toBe(true);
    expect(state.board.flat().every((cell) => cell === null)).toBe(true);
    expect(state.seats).toEqual({
      black: { kind: 'human' },
      white: { kind: 'agent' },
    });
    expect(state.winner).toBeNull();
    expect(state.endReason).toBeNull();
    expect(state.winLine).toBeNull();
    expect(state.lastMove).toBeNull();
    expect(state.moveCount).toBe(0);
    expect(state.version).toBe(0);
    expect(state.updatedAt).toBe(NOW);
  });

  it('accepts custom rules', () => {
    const state = createInitialState(
      'room-1',
      { boardSize: 9, winLength: 4 },
      NOW,
    );

    expect(state.rules).toEqual({
      ...DEFAULT_RULES,
      boardSize: 9,
      winLength: 4,
    });
    expect(state.board).toHaveLength(9);
  });
});

describe('startGame', () => {
  it('starts a fresh game and bumps the room version', () => {
    const initial = createInitialState('room-1', undefined, NOW);
    const state = startGame(
      initial,
      {
        black: { kind: 'agent' },
        white: { kind: 'human' },
      },
      { gameId: GAME_ID, now: NOW },
    );

    expect(state.status).toBe('playing');
    expect(state.gameId).toBe(GAME_ID);
    expect(state.turn).toBe('black');
    expect(state.seats).toEqual({
      black: { kind: 'agent' },
      white: { kind: 'human' },
    });
    expect(state.moveCount).toBe(0);
    expect(state.lastMove).toBeNull();
    expect(state.version).toBe(initial.version + 1);
    expect(initial.status).toBe('idle');
  });

  it('can change the board size with new rules', () => {
    const initial = createInitialState('room-1', undefined, NOW);
    const state = startGame(initial, SEATS, {
      gameId: GAME_ID,
      now: NOW,
      rules: { boardSize: 9, winLength: 4 },
    });

    expect(state.board).toHaveLength(9);
    expect(state.rules.boardSize).toBe(9);
  });
});

describe('applyMove', () => {
  it('places a stone, records the move and switches turn', () => {
    const before = playingState();
    const result = applyMove(before, 'black', 7, 7, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected move to succeed');
    }

    expect(result.move).toEqual({
      row: 7,
      col: 7,
      color: 'black',
      index: 1,
      at: NOW,
    });
    expect(result.state.board[7]?.[7]).toBe('black');
    expect(result.state.turn).toBe('white');
    expect(result.state.lastMove).toEqual(result.move);
    expect(result.state.moveCount).toBe(1);
    expect(result.state.version).toBe(before.version + 1);
    expect(result.state.status).toBe('playing');
    expect(before.board[7]?.[7]).toBeNull();
  });

  it('rejects moves when the game is idle', () => {
    const state = createInitialState('room-1', undefined, NOW);
    const result = applyMove(state, 'black', 7, 7);

    expect(result).toMatchObject({ ok: false, code: 'GAME_NOT_PLAYING' });
  });

  it('rejects out-of-bounds coordinates', () => {
    const state = playingState();
    const coords: ReadonlyArray<readonly [number, number]> = [
      [-1, 0],
      [0, -1],
      [15, 0],
      [0, 15],
      [1.5, 2],
    ];

    for (const [row, col] of coords) {
      const result = applyMove(state, 'black', row, col);
      expect(result).toMatchObject({ ok: false, code: 'OUT_OF_BOUNDS' });
    }
  });

  it('rejects an occupied cell', () => {
    const state = play(playingState(), 'black', 7, 7);
    const result = applyMove(state, 'white', 7, 7);

    expect(result).toMatchObject({ ok: false, code: 'CELL_OCCUPIED' });
  });

  it('rejects a move from the wrong color', () => {
    const state = playingState();
    const result = applyMove(state, 'white', 7, 7);

    expect(result).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
  });

  it('rejects moves after the game is finished', () => {
    const state = playMoves(horizontalWin);
    const result = applyMove(state, 'white', 0, 4);

    expect(result).toMatchObject({ ok: false, code: 'GAME_NOT_PLAYING' });
  });
});

describe('win detection', () => {
  it('detects a horizontal five', () => {
    const state = playMoves(horizontalWin);

    expectWin(state, 'black');
    expect(state.winLine).toEqual([
      { row: 7, col: 3 },
      { row: 7, col: 4 },
      { row: 7, col: 5 },
      { row: 7, col: 6 },
      { row: 7, col: 7 },
    ]);
  });

  it('detects a vertical five', () => {
    const state = playMoves(verticalWin);

    expectWin(state, 'black');
    expect(state.winLine).toEqual([
      { row: 3, col: 7 },
      { row: 4, col: 7 },
      { row: 5, col: 7 },
      { row: 6, col: 7 },
      { row: 7, col: 7 },
    ]);
  });

  it('detects a main-diagonal five', () => {
    const state = playMoves(diagonalWin);

    expectWin(state, 'black');
    expect(state.winLine).toEqual([
      { row: 3, col: 3 },
      { row: 4, col: 4 },
      { row: 5, col: 5 },
      { row: 6, col: 6 },
      { row: 7, col: 7 },
    ]);
  });

  it('detects an anti-diagonal five', () => {
    const state = playMoves(antiDiagonalWin);

    expectWin(state, 'black');
    expect(state.winLine).toEqual([
      { row: 3, col: 11 },
      { row: 4, col: 10 },
      { row: 5, col: 9 },
      { row: 6, col: 8 },
      { row: 7, col: 7 },
    ]);
  });

  it('does not end the game on four in a row', () => {
    const state = playMoves(horizontalWin.slice(0, 7));

    expect(state.status).toBe('playing');
    expect(state.winner).toBeNull();
    expect(state.winLine).toBeNull();
  });

  it('supports a custom win length', () => {
    const sixInRow: ReadonlyArray<MoveTuple> = [
      ['black', 7, 3],
      ['white', 0, 0],
      ['black', 7, 4],
      ['white', 0, 2],
      ['black', 7, 5],
      ['white', 0, 4],
      ['black', 7, 6],
      ['white', 0, 6],
      ['black', 7, 7],
      ['white', 0, 8],
      ['black', 7, 8],
    ];

    const state = playMoves(sixInRow, playingState({ winLength: 6 }));

    expectWin(state, 'black');
    expect(state.winLine).toHaveLength(6);
  });

  it('returns the full overline when overlineWin is true', () => {
    const board = createBoard(15);
    for (let col = 3; col <= 8; col += 1) {
      board[7]![col] = 'black';
    }

    const line = findWinLine(board, 7, 5, resolveRules());

    expect(line).toHaveLength(6);
    expect(line?.[0]).toEqual({ row: 7, col: 3 });
    expect(line?.[5]).toEqual({ row: 7, col: 8 });
  });

  it('rejects an overline when overlineWin is false', () => {
    const board = createBoard(15);
    for (let col = 3; col <= 8; col += 1) {
      board[7]![col] = 'black';
    }

    const line = findWinLine(
      board,
      7,
      5,
      resolveRules({ overlineWin: false }),
    );

    expect(line).toBeNull();
  });

  it('declares a draw when the board is full with no winning line', () => {
    const rows = [
      'BBWBWW',
      'WBWBBW',
      'BWBWBW',
      'WBBWWB',
      'BWWBBW',
      'WBWWBB',
    ];
    const board: (StoneColor | null)[][] = rows.map((row) =>
      [...row].map((cell) => (cell === 'B' ? 'black' : 'white')),
    );
    board[5]![5] = null;

    const base = playingState({ boardSize: 6, winLength: 6 });
    const state: GameState = {
      ...base,
      board,
      turn: 'black',
      moveCount: 35,
      version: 35,
      status: 'playing',
      lastMove: null,
    };

    const result = applyMove(state, 'black', 5, 5, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected the final move to succeed');
    }

    expect(result.state.status).toBe('finished');
    expect(result.state.winner).toBe('draw');
    expect(result.state.endReason).toBe('draw');
    expect(result.state.winLine).toBeNull();
    expect(result.state.moveCount).toBe(36);
  });
});

describe('resignGame', () => {
  it('ends the game with the opponent as winner', () => {
    const before = playingState();
    const result = resignGame(before, 'black', NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected resign to succeed');
    }

    expect(result.state.status).toBe('finished');
    expect(result.state.winner).toBe('white');
    expect(result.state.endReason).toBe('resign');
    expect(result.state.winLine).toBeNull();
    expect(result.state.version).toBe(before.version + 1);
    expect(before.status).toBe('playing');
  });

  it('rejects resign when the game is not playing', () => {
    const idle = createInitialState('room-1', undefined, NOW);
    const result = resignGame(idle, 'black');

    expect(result).toMatchObject({ ok: false, code: 'GAME_NOT_PLAYING' });
  });
});

describe('rules', () => {
  it('merges defaults', () => {
    expect(resolveRules()).toEqual(DEFAULT_RULES);
    expect(resolveRules({ boardSize: 9, winLength: 4 })).toEqual({
      ...DEFAULT_RULES,
      boardSize: 9,
      winLength: 4,
    });
  });

  it('rejects invalid board sizes and win lengths', () => {
    expect(() => resolveRules({ boardSize: 2 })).toThrow(/boardSize/);
    expect(() => resolveRules({ winLength: 2 })).toThrow(/winLength/);
    expect(() => resolveRules({ winLength: 16 })).toThrow(/winLength/);
  });

  it('rejects unsupported forbidden rules', () => {
    expect(() => resolveRules({ forbidden: 'renju' as never })).toThrow(
      /forbidden/i,
    );
  });
});

describe('board helpers', () => {
  it('creates independent rows', () => {
    const board = createBoard(3);
    board[0]![0] = 'black';

    expect(board[1]![0]).toBeNull();
    expect(board[2]![2]).toBeNull();
  });

  it('detects full boards', () => {
    const board = createBoard(2);
    expect(isBoardFull(board)).toBe(false);

    board[0]![0] = 'black';
    board[0]![1] = 'white';
    board[1]![0] = 'white';
    board[1]![1] = 'black';

    expect(isBoardFull(board)).toBe(true);
  });

  it('checks bounds including non-integers', () => {
    const board = createBoard(3);

    expect(isInside(board, 0, 0)).toBe(true);
    expect(isInside(board, 2, 2)).toBe(true);
    expect(isInside(board, 3, 0)).toBe(false);
    expect(isInside(board, 0, 3)).toBe(false);
    expect(isInside(board, -1, 0)).toBe(false);
    expect(isInside(board, 1.5, 0)).toBe(false);
  });
});

describe('opposite', () => {
  it('flips colors', () => {
    expect(opposite('black')).toBe('white');
    expect(opposite('white')).toBe('black');
  });
});
