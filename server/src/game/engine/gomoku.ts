import { randomUUID } from 'node:crypto';
import type {
  ErrorCode,
  GameState,
  Move,
  PlayerSpec,
  RuleSet,
  StoneColor,
} from '@arena/shared';
import {
  createBoard,
  findWinLine,
  isBoardFull,
  isInside,
  resolveRules,
} from './rules.js';

export type MoveResult =
  | { ok: true; state: GameState; move: Move }
  | { ok: false; code: ErrorCode; message: string };

export type ResignResult =
  | { ok: true; state: GameState }
  | { ok: false; code: ErrorCode; message: string };

export interface StartGameOptions {
  gameId?: string;
  now?: string;
  rules?: Partial<RuleSet>;
}

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

export function opposite(color: StoneColor): StoneColor {
  return color === 'black' ? 'white' : 'black';
}

export function createInitialState(
  roomId: string,
  rules?: Partial<RuleSet>,
  now?: string,
): GameState {
  const resolved = resolveRules(rules);

  return {
    game: 'gomoku',
    schemaVersion: 2,
    roomId,
    gameId: '',
    rules: resolved,
    board: createBoard(resolved.boardSize),
    turn: 'black',
    seats: {
      black: { kind: 'human' },
      white: { kind: 'agent' },
    },
    status: 'idle',
    winner: null,
    endReason: null,
    winLine: null,
    lastMove: null,
    moveCount: 0,
    version: 0,
    updatedAt: nowIso(now),
  };
}

export function startGame(
  prev: { roomId: string; version: number; rules?: RuleSet },
  seats: Record<StoneColor, PlayerSpec>,
  options: StartGameOptions = {},
): GameState {
  const rules = resolveRules(options.rules ?? prev.rules);

  return {
    game: 'gomoku',
    schemaVersion: 2,
    roomId: prev.roomId,
    gameId: options.gameId ?? randomUUID(),
    rules,
    board: createBoard(rules.boardSize),
    turn: 'black',
    seats: {
      black: { ...seats.black },
      white: { ...seats.white },
    },
    status: 'playing',
    winner: null,
    endReason: null,
    winLine: null,
    lastMove: null,
    moveCount: 0,
    version: prev.version + 1,
    updatedAt: nowIso(options.now),
  };
}

export function applyMove(
  state: GameState,
  color: StoneColor,
  row: number,
  col: number,
  now?: string,
): MoveResult {
  if (state.status !== 'playing') {
    return {
      ok: false,
      code: 'GAME_NOT_PLAYING',
      message: 'Game is not in progress.',
    };
  }

  if (!isInside(state.board, row, col)) {
    return {
      ok: false,
      code: 'OUT_OF_BOUNDS',
      message: `Cell (${row}, ${col}) is outside the board.`,
    };
  }

  if (state.board[row]?.[col] !== null) {
    return {
      ok: false,
      code: 'CELL_OCCUPIED',
      message: `Cell (${row}, ${col}) is already occupied.`,
    };
  }

  if (state.turn !== color) {
    return {
      ok: false,
      code: 'NOT_YOUR_TURN',
      message: `It is ${state.turn}'s turn.`,
    };
  }

  const board = state.board.map((boardRow) => boardRow.slice());
  board[row]![col] = color;

  const move: Move = {
    row,
    col,
    color,
    index: state.moveCount + 1,
    at: nowIso(now),
  };

  const winLine = findWinLine(board, row, col, state.rules);
  const full = isBoardFull(board);
  const finished = winLine !== null || full;

  return {
    ok: true,
    move,
    state: {
      ...state,
      board,
      turn: opposite(color),
      status: finished ? 'finished' : 'playing',
      winner: winLine ? color : full ? 'draw' : null,
      endReason: winLine ? 'five' : full ? 'draw' : null,
      winLine,
      lastMove: move,
      moveCount: state.moveCount + 1,
      version: state.version + 1,
      updatedAt: nowIso(now),
    },
  };
}

export function resignGame(
  state: GameState,
  color: StoneColor,
  now?: string,
): ResignResult {
  if (state.status !== 'playing') {
    return {
      ok: false,
      code: 'GAME_NOT_PLAYING',
      message: 'Game is not in progress.',
    };
  }

  const winner = opposite(color);

  return {
    ok: true,
    state: {
      ...state,
      status: 'finished',
      winner,
      endReason: 'resign',
      winLine: null,
      turn: winner,
      version: state.version + 1,
      updatedAt: nowIso(now),
    },
  };
}
