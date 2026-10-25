import type {
  AgentStateView,
  AnyAgentStateView,
  AnyGameState,
  AnyMove,
  Cell,
  GameState,
  GoAgentStateView,
  GoState,
  HotPoint,
  HotPointEffect,
  MoveRecord,
  RuleSet,
  StoneColor,
} from '@arena/shared';
import { opposite } from './engine.js';
import {
  renderGoBoardText,
  scoreBoard,
  summarizeGroups,
} from './go.js';
import { findWinLine } from './rules.js';

const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
] as const;

const EFFECT_RANK: Record<HotPointEffect, number> = {
  win: 0,
  open4: 1,
  four: 2,
  open3: 3,
};

/**
 * Hot-point lists are guidance, not an oracle: cap the reference tier so a
 * middlegame board cannot drown the decisive win/open4/four entries.
 */
const MAX_PER_EFFECT: Partial<Record<HotPointEffect, number>> = {
  open3: 10,
};

interface DirectionThreat {
  /** Validated five points on this direction (empty now, winning next move). */
  fiveAt: Cell[];
  /** Empty cells that turn this direction's live three into an open four. */
  open3At: Cell[];
}

interface PlacementEffect {
  effect: HotPointEffect;
  fiveAt: Cell[];
  double?: HotPointEffect[];
  open3At?: Cell[];
}

const keyOf = (cell: Cell): string => `${cell.row},${cell.col}`;

/** Five points of `color` on one direction through (row, col), engine-checked. */
function collectFivePoints(
  board: (StoneColor | null)[][],
  rules: RuleSet,
  color: StoneColor,
  row: number,
  col: number,
  dr: number,
  dc: number,
): Cell[] {
  const win = rules.winLength;
  const foe = opposite(color);
  const size = board.length;
  const candidates = new Map<string, Cell>();

  for (let back = win - 1; back >= 0; back -= 1) {
    const startRow = row - dr * back;
    const startCol = col - dc * back;
    const endRow = startRow + dr * (win - 1);
    const endCol = startCol + dc * (win - 1);
    if (
      startRow < 0 ||
      startCol < 0 ||
      endRow < 0 ||
      endCol < 0 ||
      endRow >= size ||
      endCol >= size
    ) {
      continue;
    }

    let stones = 0;
    let gap: Cell | null = null;
    let blocked = false;
    for (let step = 0; step < win; step += 1) {
      const cell = board[startRow + dr * step]![startCol + dc * step]!;
      if (cell === color) {
        stones += 1;
      } else if (cell === foe) {
        blocked = true;
        break;
      } else {
        gap = { row: startRow + dr * step, col: startCol + dc * step };
      }
    }

    if (!blocked && stones === win - 1 && gap) {
      candidates.set(keyOf(gap), gap);
    }
  }

  // A five point only counts if the engine agrees completing there wins;
  // exact-length rules reject completions that overline the run.
  const fiveAt: Cell[] = [];
  for (const cell of candidates.values()) {
    board[cell.row]![cell.col] = color;
    if (findWinLine(board, cell.row, cell.col, rules)) {
      fiveAt.push(cell);
    }
    board[cell.row]![cell.col] = null;
  }
  return fiveAt;
}

/**
 * Endpoints that turn a live three into an open four on this direction.
 * We test empty cells near the candidate directly instead of parsing the
 * shape, so split threes (`X X _ X`) are handled by the same code.
 */
function findOpen3Endpoints(
  board: (StoneColor | null)[][],
  rules: RuleSet,
  color: StoneColor,
  row: number,
  col: number,
  dr: number,
  dc: number,
): Cell[] {
  const size = board.length;
  const reach = rules.winLength - 1;
  const endpoints = new Map<string, Cell>();

  for (let step = -reach; step <= reach; step += 1) {
    if (step === 0) {
      continue;
    }
    const r = row + dr * step;
    const c = col + dc * step;
    if (r < 0 || c < 0 || r >= size || c >= size || board[r]![c] !== null) {
      continue;
    }

    board[r]![c] = color;
    const winsNow = findWinLine(board, r, c, rules) !== null;
    const fiveAt = winsNow
      ? []
      : collectFivePoints(board, rules, color, r, c, dr, dc);
    board[r]![c] = null;

    if (fiveAt.length >= 2) {
      const endpoint = { row: r, col: c };
      endpoints.set(keyOf(endpoint), endpoint);
    }
  }

  return [...endpoints.values()];
}

/**
 * Analyse one direction after (row, col) has been temporarily filled.
 * A direction is either a four/open4 (fiveAt non-empty) or, if it has at
 * least two three-windows, a live three with explicit extension endpoints.
 */
function analyseDirection(
  board: (StoneColor | null)[][],
  rules: RuleSet,
  color: StoneColor,
  row: number,
  col: number,
  dr: number,
  dc: number,
): DirectionThreat {
  const win = rules.winLength;
  const foe = opposite(color);
  const size = board.length;
  let threeWindows = 0;

  for (let back = win - 1; back >= 0; back -= 1) {
    const startRow = row - dr * back;
    const startCol = col - dc * back;
    const endRow = startRow + dr * (win - 1);
    const endCol = startCol + dc * (win - 1);
    if (
      startRow < 0 ||
      startCol < 0 ||
      endRow < 0 ||
      endCol < 0 ||
      endRow >= size ||
      endCol >= size
    ) {
      continue;
    }

    let stones = 0;
    let blocked = false;
    for (let step = 0; step < win; step += 1) {
      const cell = board[startRow + dr * step]![startCol + dc * step]!;
      if (cell === color) {
        stones += 1;
      } else if (cell === foe) {
        blocked = true;
        break;
      }
    }

    if (blocked) {
      continue;
    }
    if (stones === win - 2) {
      threeWindows += 1;
    }
  }

  const fiveAt = collectFivePoints(board, rules, color, row, col, dr, dc);
  if (fiveAt.length > 0) {
    return { fiveAt, open3At: [] };
  }
  if (threeWindows < 2) {
    return { fiveAt: [], open3At: [] };
  }
  return {
    fiveAt: [],
    open3At: findOpen3Endpoints(board, rules, color, row, col, dr, dc),
  };
}

/**
 * Classify what placing `color` at (row, col) immediately creates.
 *
 * Win detection and every five point are validated with the engine's
 * `findWinLine`, so `overlineWin` / `winLength` semantics can never diverge
 * from the rules engine (an exact-five rule rejects six-line completions).
 *
 * A `double` is two threats that cannot be answered by one opponent move:
 * - four + open3 in different directions: the four forces a block, then the
 *   live three becomes an open four;
 * - two live threes in different directions: blocking one leaves the other.
 * A four and a three on the same direction are NOT independent (one fiveAt
 * block defuses both), so the same direction never contributes an open3 when
 * it already has a fiveAt.
 *
 * `board` is mutated for the duration of the call and restored afterwards.
 */
function classifyPlacement(
  board: (StoneColor | null)[][],
  rules: RuleSet,
  color: StoneColor,
  row: number,
  col: number,
): PlacementEffect | null {
  board[row]![col] = color;
  try {
    if (findWinLine(board, row, col, rules) !== null) {
      return { effect: 'win', fiveAt: [] };
    }

    const directions = DIRECTIONS.map(([dr, dc]) =>
      analyseDirection(board, rules, color, row, col, dr, dc),
    );

    const fiveMap = new Map<string, Cell>();
    for (const direction of directions) {
      for (const cell of direction.fiveAt) {
        fiveMap.set(keyOf(cell), cell);
      }
    }
    const fiveAt = [...fiveMap.values()];

    if (fiveAt.length >= 2) {
      return { effect: 'open4', fiveAt };
    }

    // Split live threes (`X . X X`) have one gap extension, not two open
    // ends; `analyseDirection` already requires two live-three windows.
    const open3Directions = directions.filter(
      (direction) => direction.fiveAt.length === 0 && direction.open3At.length > 0,
    );
    const open3Map = new Map<string, Cell>();
    for (const direction of open3Directions) {
      for (const cell of direction.open3At) {
        open3Map.set(keyOf(cell), cell);
      }
    }
    const open3At = [...open3Map.values()];

    if (fiveAt.length === 1) {
      if (open3Directions.length > 0) {
        return { effect: 'four', fiveAt, double: ['four', 'open3'], open3At };
      }
      return { effect: 'four', fiveAt };
    }

    if (open3Directions.length >= 2) {
      return { effect: 'open3', fiveAt: [], double: ['open3', 'open3'], open3At };
    }
    if (open3Directions.length === 1) {
      return { effect: 'open3', fiveAt: [] };
    }
    return null;
  } finally {
    board[row]![col] = null;
  }
}

/**
 * Every empty cell where a stone of either color would create an immediate
 * threat, sorted win > open4 > four > open3, with double points (four+open3
 * or two live threes) ahead of ordinary points in the same tier. Split
 * shapes such as `X X _ X` show up here as four/open3 instead of hiding in
 * the grid.
 *
 * Note the tier names assume winLength=5; for other rule sets the semantics
 * stay engine-correct (win / fiveAt always agree with findWinLine), only
 * the labels "four"/"open3" become relative to `winLength`.
 */
export function findHotPoints(
  board: (StoneColor | null)[][],
  rules: RuleSet,
): Record<StoneColor, HotPoint[]> {
  const scratch = board.map((row) => row.slice());
  const found: Record<StoneColor, HotPoint[]> = { black: [], white: [] };

  for (let row = 0; row < scratch.length; row += 1) {
    for (let col = 0; col < scratch.length; col += 1) {
      if (scratch[row]![col] !== null) {
        continue;
      }
      for (const color of ['black', 'white'] as const) {
        const result = classifyPlacement(scratch, rules, color, row, col);
        if (result) {
          found[color].push({
            row,
            col,
            effect: result.effect,
            fiveAt: result.fiveAt,
            ...(result.double ? { double: result.double } : {}),
            ...(result.open3At ? { open3At: result.open3At } : {}),
          });
        }
      }
    }
  }

  for (const color of ['black', 'white'] as const) {
    found[color].sort(
      (a, b) =>
        EFFECT_RANK[a.effect] - EFFECT_RANK[b.effect] ||
        Number(Boolean(b.double)) - Number(Boolean(a.double)) ||
        a.row - b.row ||
        a.col - b.col,
    );
    const kept: HotPoint[] = [];
    const counts = new Map<HotPointEffect, number>();
    for (const point of found[color]) {
      const used = counts.get(point.effect) ?? 0;
      const cap = MAX_PER_EFFECT[point.effect];
      if (cap !== undefined && used >= cap) {
        continue;
      }
      counts.set(point.effect, used + 1);
      kept.push(point);
    }
    found[color] = kept;
  }

  return found;
}

function stoneChar(
  board: (StoneColor | null)[][],
  row: number,
  col: number,
  lastMove: Cell | null,
  winLine: ReadonlySet<string>,
): string {
  const color = board[row]![col]!;
  if (!color) {
    return '.';
  }
  let ch = color === 'black' ? 'X' : 'O';
  if (lastMove && lastMove.row === row && lastMove.col === col) {
    ch = ch.toLowerCase();
  } else if (winLine.has(keyOf({ row, col }))) {
    ch = ch === 'X' ? '#' : '@';
  }
  return ch;
}

/**
 * Monospace board picture with 0-based coordinates. Every column label is a
 * whitespace-separated token (no glued numbers at 10+), row labels are
 * zero-padded two-digit strings. `#`/`@` mark the winning line once the game
 * is over; the latest move keeps its lowercase letter.
 */
export function renderBoardText(state: GameState): string {
  const size = state.rules.boardSize;
  const lastMove = state.lastMove;
  const winLine = new Set<string>(
    (state.winLine ?? []).map((cell) => keyOf(cell)),
  );

  const header =
    '  ' +
    Array.from({ length: size }, (_, col) =>
      String(col).padStart(3, ' '),
    ).join('');

  const rows = Array.from({ length: size }, (_, row) =>
    `${String(row).padStart(2, '0')}` +
    Array.from(
      { length: size },
      (_, col) => stoneChar(state.board, row, col, lastMove, winLine).padStart(3, ' '),
    ).join(''),
  );

  const lines = [
    header,
    ...rows,
    `(X=黑 O=白 .=空 小写=最新一手${state.winLine ? ' #/@=五连' : ''}；行号 00-14、列号 0-14，均 0-based)`,
  ];
  if (lastMove) {
    const whose = lastMove.color === 'black' ? '黑' : '白';
    lines.push(`最新一手: ${whose} (${lastMove.row},${lastMove.col}) 第${lastMove.index}手`);
  }
  return lines.join('\n');
}

function toMoveRecord(move: AnyMove): MoveRecord {
  // A pass is the only AnyMove carrying `kind`; placements are plain Moves.
  if ('kind' in move) {
    return { kind: 'pass', color: move.color, index: move.index };
  }
  return {
    kind: 'place',
    row: move.row,
    col: move.col,
    color: move.color,
    index: move.index,
  };
}

export interface AgentViewOptions {
  /**
   * Keep only the last N move records (hot-path payload control). The full
   * history stays available through get_state.
   */
  recentMoves?: number;
}

/**
 * Project the authoritative GameState into the agent-facing view: same fields
 * as GameState (minus the nested board array) plus boardText, moves and
 * hotPoints, so an LLM never has to count cells in a 15×15 JSON matrix.
 *
 * `history` may be null when the move list is genuinely unavailable (error
 * paths): then moves is empty and movesOmitted reports state.moveCount, so
 * the view never pretends a long game just started.
 */
export function toAgentStateView(
  state: GameState,
  history: readonly AnyMove[] | null,
  options: AgentViewOptions = {},
): AgentStateView {
  const recent = options.recentMoves;
  const known = history ?? [];
  const moves =
    recent !== undefined && known.length > recent
      ? known.slice(-recent)
      : known;

  const { board: _board, ...rest } = state;
  return {
    ...rest,
    boardText: renderBoardText(state),
    moves: moves.map(toMoveRecord),
    movesOmitted: history === null ? state.moveCount : known.length - moves.length,
    hotPoints: findHotPoints(state.board, state.rules),
  };
}

/**
 * GoState rendered for LLM agents: monospace board picture, compact move
 * records, prisoner counts and block summaries. Facts only — the liberties,
 * sizes and coordinates say what the position is; whether a group should run
 * or die stays the model's judgement (PROPOSAL-GO-MCP §5.2).
 */
export function toGoAgentStateView(
  state: GoState,
  history: readonly AnyMove[] | null,
  options: AgentViewOptions = {},
): GoAgentStateView {
  const recent = options.recentMoves;
  const known = history ?? [];
  const moves =
    recent !== undefined && known.length > recent ? known.slice(-recent) : known;

  // renderGoBoardText highlights a placement's point; a pass has none, so it
  // renders as a plain board plus the move record.
  const lastPlacement =
    state.lastMove && !('kind' in state.lastMove) ? state.lastMove : null;

  const { board: _board, ...rest } = state;
  return {
    ...rest,
    boardText: renderGoBoardText(state.board, {
      lastMove: lastPlacement,
      lastCaptured: state.lastCaptured,
    }),
    moves: moves.map(toMoveRecord),
    movesOmitted:
      history === null ? state.moveCount : known.length - moves.length,
    captures: {
      black: state.captures.black,
      white: state.captures.white,
      lastCaptured: state.lastCaptured,
    },
    groups: summarizeGroups(state.board),
    // A preview of the area count under the current dead-stone marks — the
    // marks are not applied to the board, and the preview is not the result.
    scorePreview:
      state.status === 'scoring'
        ? scoreBoard(state.board, state.deadStones, state.rules.komi)
        : null,
  };
}

/**
 * Discriminating entry for the state union: the view is picked by `game`,
 * so a Go room gets the Go radar and a gomoku room the gomoku view.
 */
export function toAnyAgentStateView(
  state: AnyGameState,
  history: readonly AnyMove[] | null,
  options: AgentViewOptions = {},
): AnyAgentStateView {
  if (state.game === 'go') {
    return toGoAgentStateView(state, history, options);
  }
  return toAgentStateView(state, history, options);
}
