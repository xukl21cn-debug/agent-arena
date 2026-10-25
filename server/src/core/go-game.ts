import { randomUUID } from 'node:crypto';
import type {
  Cell,
  ErrorCode,
  GoPassMove,
  GoRules,
  GoState,
  Move,
  PlayerSpec,
  StoneColor,
} from '@arena/shared';
import {
  DEFAULT_KOMI,
  GO_BOARD_SIZE,
  blockAt,
  playMove,
  scoreBoard,
} from './go.js';
import { opposite } from './engine.js';

/**
 * Room-level Go state transitions (M2).
 *
 * The strict counterpart of engine.ts for the other game: this file only
 * moves state around (turns, counts, history) and delegates every rules
 * question — captures, ko, suicide — to the audited engine in go.ts.
 * If a rule is written out here, the two games have drifted; P3a's engine
 * is the single source of truth.
 *
 * The scoring transition (two consecutive passes → 'scoring') belongs to M3;
 * until it lands, consecutivePasses merely accumulates and 'scoring' is
 * unreachable, which is why mark_dead/confirm_score/resume_play can only
 * answer NOT_SCORING.
 */

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

/** new_game's Go rule parameters, validated. Unsupported = rejected loudly. */
export type GoRulesResolution =
  | { ok: true; rules: GoRules }
  | { ok: false; message: string };

/**
 * Resolve the Go rules a new game should run under.
 *
 * v1 is 9×9 with simple ko only: anything else is rejected, never silently
 * accepted (PROPOSAL-GO-MCP §0).
 */
export function resolveGoRules(raw: {
  boardSize?: number;
  komi?: number;
  koRule?: 'simple';
}): GoRulesResolution {
  const { boardSize, komi, koRule } = raw;

  if (boardSize !== undefined) {
    if (!Number.isInteger(boardSize) || boardSize < 1 || boardSize > 36) {
      return {
        ok: false,
        message: `rules.boardSize must be an integer between 1 and 36, got ${String(boardSize)}.`,
      };
    }
    if (boardSize !== GO_BOARD_SIZE) {
      return {
        ok: false,
        message: `v1 supports the ${GO_BOARD_SIZE}×${GO_BOARD_SIZE} board only; ${boardSize}×${boardSize} is rejected instead of silently accepted.`,
      };
    }
  }

  if (koRule !== undefined && koRule !== 'simple') {
    return {
      ok: false,
      message: `v1 supports koRule "simple" only, got "${String(koRule)}".`,
    };
  }

  if (komi !== undefined && (typeof komi !== 'number' || !Number.isFinite(komi))) {
    return {
      ok: false,
      message: `rules.komi must be a finite number, got ${String(komi)}.`,
    };
  }

  return {
    ok: true,
    rules: {
      boardSize: GO_BOARD_SIZE,
      komi: komi ?? DEFAULT_KOMI,
      koRule: 'simple',
    },
  };
}

export type GoPlacementResult =
  | { ok: true; state: GoState; move: Move }
  | { ok: false; code: ErrorCode; message: string };

export type GoPassResult =
  | { ok: true; state: GoState; move: GoPassMove }
  | { ok: false; code: ErrorCode; message: string };

export type GoResignResult =
  | { ok: true; state: GoState }
  | { ok: false; code: ErrorCode; message: string };

export interface StartGoGameOptions {
  gameId?: string;
  now?: string;
  rules: GoRules;
}

/**
 * Start a Go game over a room's previous state. Identity/version bookkeeping
 * follows engine.ts's startGame; only the game body differs.
 */
export function startGoGame(
  prev: { roomId: string; version: number },
  seats: Record<StoneColor, PlayerSpec>,
  options: StartGoGameOptions,
): GoState {
  const size = options.rules.boardSize;
  return {
    game: 'go',
    schemaVersion: 2,
    roomId: prev.roomId,
    gameId: options.gameId ?? randomUUID(),
    rules: { ...options.rules },
    board: Array.from({ length: size }, () =>
      Array<StoneColor | null>(size).fill(null),
    ),
    turn: 'black',
    status: 'playing',
    seats: {
      black: { ...seats.black },
      white: { ...seats.white },
    },
    winner: null,
    endReason: null,
    winLine: null,
    lastMove: null,
    moveCount: 0,
    version: prev.version + 1,
    updatedAt: nowIso(options.now),
    captures: { black: 0, white: 0 },
    lastCaptured: [],
    koPoint: null,
    consecutivePasses: 0,
    deadStones: [],
    scoreConfirmed: { black: false, white: false },
    score: null,
  };
}

/**
 * The checks most Go actions share: a playing game and the mover's turn.
 *
 * `scoring` decides what a scoring-phase game means here:
 * - 'reject' (place/pass): NOT_SCORING, the actionable hint that the game has
 *   moved on to dead-stone marking;
 * - 'allow-no-turn' (resign): allowed, because scoring has no turns — either
 *   side may still resign.
 */
function checkTurn(
  state: GoState,
  color: StoneColor,
  scoring: 'reject' | 'allow-no-turn' = 'reject',
): { ok: false; code: ErrorCode; message: string } | undefined {
  if (state.status === 'scoring') {
    if (scoring === 'allow-no-turn') {
      return undefined;
    }
    return {
      ok: false,
      code: 'NOT_SCORING',
      message:
        'The game is in the scoring phase; use mark_dead / confirm_score / resume_play.',
    };
  }
  if (state.status !== 'playing') {
    return {
      ok: false,
      code: 'GAME_NOT_PLAYING',
      message: 'Game is not in progress.',
    };
  }
  if (state.turn !== color) {
    return {
      ok: false,
      code: 'NOT_YOUR_TURN',
      message: `It is ${state.turn}'s turn.`,
    };
  }
  return undefined;
}

/**
 * Place a stone. Captures / ko / suicide come straight from the engine —
 * this function forwards the engine's verdict verbatim and updates the
 * bookkeeping fields around it.
 */
export function applyGoPlacement(
  state: GoState,
  color: StoneColor,
  row: number,
  col: number,
  now?: string,
): GoPlacementResult {
  const turn = checkTurn(state, color);
  if (turn) {
    return turn;
  }

  const played = playMove(state.board, color, row, col, state.koPoint);
  if (!played.ok) {
    return { ok: false, code: played.code, message: played.message };
  }

  const move: Move = {
    row,
    col,
    color,
    index: state.moveCount + 1,
    at: nowIso(now),
  };

  const capturedCount = played.captured.length;

  return {
    ok: true,
    move,
    state: {
      ...state,
      board: played.board,
      turn: opposite(color),
      // M3 turns two consecutive passes into 'scoring'; a placement always
      // resets the count.
      consecutivePasses: 0,
      lastMove: move,
      moveCount: state.moveCount + 1,
      version: state.version + 1,
      updatedAt: nowIso(now),
      captures: {
        black: state.captures.black + (color === 'black' ? capturedCount : 0),
        white: state.captures.white + (color === 'white' ? capturedCount : 0),
      },
      lastCaptured: played.captured,
      koPoint: played.koPoint,
    },
  };
}

/**
 * Pass a turn. A pass clears the ko point (the position repeats instead of
 * alternating) and empties lastCaptured; the second consecutive pass moves
 * the game to the scoring phase — with `turn` untouched, still pointing at
 * the side that would have played next.
 */
export function applyGoPass(
  state: GoState,
  color: StoneColor,
  now?: string,
): GoPassResult {
  const turn = checkTurn(state, color);
  if (turn) {
    return turn;
  }

  const move: GoPassMove = {
    kind: 'pass',
    color,
    index: state.moveCount + 1,
    at: nowIso(now),
  };

  const consecutivePasses = state.consecutivePasses + 1;

  return {
    ok: true,
    move,
    state: {
      ...state,
      turn: opposite(color),
      consecutivePasses,
      status: consecutivePasses >= 2 ? 'scoring' : state.status,
      lastMove: move,
      moveCount: state.moveCount + 1,
      version: state.version + 1,
      updatedAt: nowIso(now),
      koPoint: null,
      lastCaptured: [],
    },
  };
}

export function resignGoGame(
  state: GoState,
  color: StoneColor,
  now?: string,
): GoResignResult {
  // Scoring keeps no turns, but resigning stays available to either side.
  const turn = checkTurn(state, color, 'allow-no-turn');
  if (turn) {
    return turn;
  }

  const winner = opposite(color);

  return {
    ok: true,
    state: {
      ...state,
      status: 'finished',
      winner,
      endReason: 'resign',
      turn: winner,
      version: state.version + 1,
      updatedAt: nowIso(now),
    },
  };
}

// ---------------------------------------------------------------------------
// Scoring (M3)
// ---------------------------------------------------------------------------

export type GoScoringResult =
  | { ok: true; state: GoState }
  | { ok: false; code: ErrorCode; message: string };

function keyOf(cell: Cell): string {
  return `${cell.row},${cell.col}`;
}

function requireScoring(
  state: GoState,
  tool: string,
): { ok: false; code: ErrorCode; message: string } | undefined {
  if (state.status !== 'scoring') {
    return {
      ok: false,
      code: 'NOT_SCORING',
      message: `${tool} needs the scoring phase (two consecutive passes).`,
    };
  }
  return undefined;
}

/**
 * Toggle the whole block at a point as dead.
 *
 * One call acts on the entire connected block — half-marked blocks would
 * make the area count nonsense. Any change resets BOTH confirmations: a
 * confirmation made against a different dead-stone set is not a
 * confirmation of this score, so it must not survive the edit.
 */
export function markGoDead(
  state: GoState,
  row: number,
  col: number,
  now?: string,
): GoScoringResult {
  const scoring = requireScoring(state, 'mark_dead');
  if (scoring) {
    return scoring;
  }
  // Off-board and empty points fail the same way: neither names a block.
  if (state.board[row]?.[col] === undefined || state.board[row]?.[col] === null) {
    return {
      ok: false,
      code: 'INVALID_DEAD_STONE',
      message: `Point (${row},${col}) holds no stone to mark.`,
    };
  }

  const block = blockAt(state.board, row, col);
  const dead = new Map(state.deadStones.map((cell) => [keyOf(cell), cell]));
  const blockAllDead = block.stones.every((stone) => dead.has(keyOf(stone)));
  if (blockAllDead) {
    for (const stone of block.stones) {
      dead.delete(keyOf(stone));
    }
  } else {
    for (const stone of block.stones) {
      dead.set(keyOf(stone), stone);
    }
  }

  return {
    ok: true,
    state: {
      ...state,
      deadStones: [...dead.values()],
      scoreConfirmed: { black: false, white: false },
      version: state.version + 1,
      updatedAt: nowIso(now),
    },
  };
}

/**
 * Record one side's agreement with the current dead-stone set. Idempotent:
 * confirming again without any change in between is a no-op. Once both sides
 * have confirmed, the engine's area score decides the game — captures never
 * enter it.
 */
export function confirmGoScore(
  state: GoState,
  color: StoneColor,
  now?: string,
): GoScoringResult {
  const scoring = requireScoring(state, 'confirm_score');
  if (scoring) {
    return scoring;
  }
  if (state.scoreConfirmed[color]) {
    return { ok: true, state };
  }

  const scoreConfirmed = { ...state.scoreConfirmed, [color]: true };
  if (!scoreConfirmed.black || !scoreConfirmed.white) {
    return {
      ok: true,
      state: {
        ...state,
        scoreConfirmed,
        version: state.version + 1,
        updatedAt: nowIso(now),
      },
    };
  }

  const score = scoreBoard(state.board, state.deadStones, state.rules.komi);
  return {
    ok: true,
    state: {
      ...state,
      scoreConfirmed,
      score,
      status: 'finished',
      winner: score.winner,
      endReason: 'scored',
      version: state.version + 1,
      updatedAt: nowIso(now),
    },
  };
}

/**
 * Leave scoring and keep playing from the same position: dead-stone marks
 * and confirmations are dropped, the pass counter resets, and `turn` is
 * exactly what it was when scoring began.
 */
export function resumeGoPlay(state: GoState, now?: string): GoScoringResult {
  const scoring = requireScoring(state, 'resume_play');
  if (scoring) {
    return scoring;
  }
  return {
    ok: true,
    state: {
      ...state,
      status: 'playing',
      deadStones: [],
      scoreConfirmed: { black: false, white: false },
      consecutivePasses: 0,
      version: state.version + 1,
      updatedAt: nowIso(now),
    },
  };
}
