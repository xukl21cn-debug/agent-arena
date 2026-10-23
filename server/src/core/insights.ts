import type {
  AgentStateView,
  Cell,
  GameState,
  HotPoint,
  HotPointEffect,
  Move,
  MoveRecord,
  RuleSet,
  StoneColor,
} from '@gomoku/shared';
import { opposite } from './engine.js';
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

interface PlacementEffect {
  effect: HotPointEffect;
  fiveAt: Cell[];
}

const keyOf = (cell: Cell): string => `${cell.row},${cell.col}`;

/**
 * Classify what placing `color` at (row, col) immediately creates.
 *
 * Win detection and every five point are validated with the engine's
 * `findWinLine`, so `overlineWin` / `winLength` semantics can never diverge
 * from the rules engine (an exact-five rule rejects six-line completions).
 * Open threes are detected with winLength-sized windows: two or more
 * three-windows in one direction means the shape can grow into a four in
 * one move - including split shapes like `X X _ X`.
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
  const win = rules.winLength;
  const foe = opposite(color);
  const size = board.length;

  board[row]![col] = color;
  try {
    const winNow = findWinLine(board, row, col, rules) !== null;
    let bestThreeWindows = 0;
    const fiveCandidates = new Map<string, Cell>();

    for (const [dr, dc] of DIRECTIONS) {
      let threeWindows = 0;

      // Try every window of `win` cells that contains (row, col).
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

        if (blocked) {
          continue;
        }
        if (stones === win - 1 && gap) {
          fiveCandidates.set(keyOf(gap), gap);
        } else if (stones === win - 2) {
          threeWindows += 1;
        }
      }

      bestThreeWindows = Math.max(bestThreeWindows, threeWindows);
    }

    if (winNow) {
      return { effect: 'win', fiveAt: [] };
    }

    // A five point only counts if the engine agrees completing there wins;
    // exact-length rules reject completions that overline the run.
    const fiveAt: Cell[] = [];
    for (const cell of fiveCandidates.values()) {
      board[cell.row]![cell.col] = color;
      if (findWinLine(board, cell.row, cell.col, rules)) {
        fiveAt.push(cell);
      }
      board[cell.row]![cell.col] = null;
    }

    if (fiveAt.length >= 2) {
      return { effect: 'open4', fiveAt: fiveAt };
    }
    if (fiveAt.length === 1) {
      return { effect: 'four', fiveAt: fiveAt };
    }
    if (bestThreeWindows >= 2) {
      return { effect: 'open3', fiveAt: [] };
    }
    return null;
  } finally {
    board[row]![col] = null;
  }
}

/**
 * Every empty cell where a stone of either color would create an immediate
 * threat, sorted win > open4 > four > open3. Split shapes such as
 * `X X _ X` show up here as four/open3 instead of hiding in the grid.
 *
 * Note the tier names assume winLength=5; for other rule sets the semantics
 * stay engine-correct (win / fiveAt always agree with findWinLine), only
 * the labels "four"/"three" become relative to `winLength`.
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
          found[color].push({ row, col, effect: result.effect, fiveAt: result.fiveAt });
        }
      }
    }
  }

  for (const color of ['black', 'white'] as const) {
    found[color].sort(
      (a, b) =>
        EFFECT_RANK[a.effect] - EFFECT_RANK[b.effect] ||
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

function toMoveRecord(move: Move): MoveRecord {
  return { row: move.row, col: move.col, color: move.color, index: move.index };
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
  history: readonly Move[] | null,
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
