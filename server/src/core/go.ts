import type { Cell, StoneColor } from '@arena/shared';

/**
 * 9-line Go rules engine (P3a / M1).
 *
 * Pure functions only: board in, board out. Nothing here knows about rooms,
 * transports, sessions or game phases — pass/scoring state machines land in
 * M3, and the moment this file grows a dependency on them, P1c and P3b will
 * be fighting over the same new_game surface this engine deliberately never
 * touches.
 */

export const GO_BOARD_SIZE = 9;
export const DEFAULT_KOMI = 7.5;

export interface GoRules {
  /** v1 is fixed at 9; other sizes are rejected by the game layer, not here. */
  boardSize: 9;
  /** Compensation for white playing second, added to WHITE's total. */
  komi: number;
  koRule: 'simple';
}

export type GoBoard = (StoneColor | null)[][];

export type GoErrorCode = 'OUT_OF_BOUNDS' | 'CELL_OCCUPIED' | 'SUICIDE' | 'KO';

export type GoMoveResult =
  | { ok: true; board: GoBoard; captured: Cell[]; koPoint: Cell | null }
  | { ok: false; code: GoErrorCode; message: string };

/** Chinese area scoring result. Captures never enter these numbers. */
export interface GoScore {
  blackArea: number;
  whiteArea: number;
  komi: number;
  blackTotal: number;
  whiteTotal: number;
  winner: StoneColor | 'draw';
  margin: number;
}

export interface GoGroupSummary {
  color: StoneColor;
  stones: number;
  /** Topmost stone, then leftmost — stable across calls for the same board. */
  representative: Cell;
  liberties: number;
  /** Exact liberty coordinates for 1-2 liberty groups; omitted at 3+. */
  libertyAt?: Cell[];
}

export interface GoGroupsView {
  black: GoGroupSummary[];
  white: GoGroupSummary[];
  /** Groups beyond the per-color cap — counts, not prose to re-parse. */
  omitted: { black: number; white: number };
}

/** A group summary carries more context than a bare stone list; 12 per color. */
const GROUP_SUMMARY_LIMIT = 12;

const ORTHOGONAL = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

function oppositeOf(color: StoneColor): StoneColor {
  return color === 'black' ? 'white' : 'black';
}

function keyOf(row: number, col: number): string {
  return `${row},${col}`;
}

function inBounds(board: GoBoard, row: number, col: number): boolean {
  return (
    Number.isInteger(row) &&
    Number.isInteger(col) &&
    row >= 0 &&
    col >= 0 &&
    row < board.length &&
    col < (board[0]?.length ?? 0)
  );
}

/** Direct neighbours of a point that lie on the board. */
function neighbours(
  board: GoBoard,
  row: number,
  col: number,
): Array<{ row: number; col: number }> {
  const result: Array<{ row: number; col: number }> = [];
  for (const [dr, dc] of ORTHOGONAL) {
    const r = row + dr;
    const c = col + dc;
    if (inBounds(board, r, c)) {
      result.push({ row: r, col: c });
    }
  }
  return result;
}

export function createGoBoard(size: number = GO_BOARD_SIZE): GoBoard {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`boardSize must be a positive integer, got ${size}`);
  }
  return Array.from({ length: size }, () =>
    Array<StoneColor | null>(size).fill(null),
  );
}

/**
 * The whole block at a point, plus its liberties as a deduplicated set.
 *
 * Liberties belong to the block, not to individual stones: two stones of one
 * block that both touch the same empty point share that liberty, and counting
 * it twice would make a dying block look alive — every life-and-death answer
 * this file gives is only as correct as this deduplication.
 *
 * A point with no stone has no block: the empty result says so loudly enough
 * for a caller that miscounted its own board.
 */
export function blockAt(
  board: GoBoard,
  row: number,
  col: number,
): { stones: Cell[]; liberties: Set<string>; libertyCells: Cell[] } {
  if (!inBounds(board, row, col)) {
    throw new Error(`point (${row},${col}) is not on the board`);
  }
  const color = board[row]![col]!;
  if (color === null) {
    return { stones: [], liberties: new Set(), libertyCells: [] };
  }

  const stones: Cell[] = [];
  const libertyKeys = new Set<string>();
  const libertyCells: Cell[] = [];
  const visited = new Set<string>([keyOf(row, col)]);
  const stack: Cell[] = [{ row, col }];

  while (stack.length > 0) {
    const point = stack.pop()!;
    stones.push(point);

    for (const n of neighbours(board, point.row, point.col)) {
      const occupant = board[n.row]![n.col]!;
      if (occupant === color) {
        const key = keyOf(n.row, n.col);
        if (!visited.has(key)) {
          visited.add(key);
          stack.push({ row: n.row, col: n.col });
        }
      } else if (occupant === null) {
        const key = keyOf(n.row, n.col);
        if (!libertyKeys.has(key)) {
          libertyKeys.add(key);
          libertyCells.push({ row: n.row, col: n.col });
        }
      }
    }
  }

  return { stones, liberties: libertyKeys, libertyCells };
}

/** Liberty count of the block at a point — deduplicated, see {@link blockAt}. */
export function libertiesAt(board: GoBoard, row: number, col: number): number {
  return blockAt(board, row, col).liberties.size;
}

/**
 * Place a stone and resolve captures. The input board is never modified.
 *
 * The order below is the rules, not a suggestion:
 *
 * 1. reject occupied / off-board / ko points
 * 2. place the stone on a copy
 * 3. remove EVERY adjacent enemy block left without liberties — one move can
 *    cut two blocks to zero at once, and stopping after the first would leave
 *    an illegal position on the board
 * 4. only then judge the mover's own block: if it still has no liberties the
 *    move was suicide. Swapping steps 3 and 4 misrules "capture to breathe" —
 *    the most common legal move a wrong engine rejects.
 *
 * Simple ko: when a move captures exactly one stone, the played stone is a
 * lone stone (not connected to a friendly stone), and its only liberty
 * afterwards is the captured point, that point becomes koPoint and the
 * opponent may not take it back immediately. The lone-stone condition is what
 * separates a real ko from an ordinary re-capture by a multi-stone block;
 * checking liberties alone would forbid moves that are perfectly legal.
 */
export function playMove(
  board: GoBoard,
  color: StoneColor,
  row: number,
  col: number,
  koPoint?: Cell | null,
): GoMoveResult {
  if (!inBounds(board, row, col)) {
    return {
      ok: false,
      code: 'OUT_OF_BOUNDS',
      message: `Point (${row},${col}) is not on the board.`,
    };
  }
  if (koPoint && koPoint.row === row && koPoint.col === col) {
    return {
      ok: false,
      code: 'KO',
      message: `Point (${row},${col}) is a ko point; play elsewhere first.`,
    };
  }
  if (board[row]![col] !== null) {
    return {
      ok: false,
      code: 'CELL_OCCUPIED',
      message: `Point (${row},${col}) is occupied.`,
    };
  }

  const next: GoBoard = board.map((line) => line.slice());
  next[row]![col] = color;

  const enemy = oppositeOf(color);
  const captured: Cell[] = [];
  for (const n of neighbours(next, row, col)) {
    // Cells of an already-removed block are empty here, so a block adjacent
    // through two of the played stone's sides is only flooded once.
    if (next[n.row]![n.col] !== enemy) {
      continue;
    }
    const block = blockAt(next, n.row, n.col);
    if (block.liberties.size === 0) {
      for (const stone of block.stones) {
        next[stone.row]![stone.col] = null;
      }
      captured.push(...block.stones);
    }
  }

  const own = blockAt(next, row, col);
  if (own.liberties.size === 0) {
    return {
      ok: false,
      code: 'SUICIDE',
      message: `Point (${row},${col}) leaves the played block without liberties.`,
    };
  }

  let newKoPoint: Cell | null = null;
  if (
    captured.length === 1 &&
    own.stones.length === 1 &&
    own.liberties.size === 1 &&
    own.libertyCells[0]!.row === captured[0]!.row &&
    own.libertyCells[0]!.col === captured[0]!.col
  ) {
    newKoPoint = captured[0]!;
  }

  return { ok: true, board: next, captured, koPoint: newKoPoint };
}

/**
 * Chinese area scoring.
 *
 * Dead stones are removed first (the caller decides which — marking protocol
 * is M3), then each colour's area is its stones on the board plus the empty
 * regions that touch only that colour. Shared regions — including the shared
 * liberties of a seki — count for nobody, which is exactly why area scoring
 * needs no life-and-death search: a seki's stones are on the board and its
 * public liberties are neutral, and both of those facts are already true.
 *
 * Captures are display-only. They do not appear anywhere in this function,
 * and any temptation to add them is prisoner thinking from Japanese rules.
 */
export function scoreBoard(
  board: GoBoard,
  deadStones: Cell[] = [],
  komi: number = DEFAULT_KOMI,
): GoScore {
  const size = board.length;
  const work: GoBoard = board.map((line) => line.slice());
  for (const stone of deadStones) {
    if (inBounds(work, stone.row, stone.col)) {
      work[stone.row]![stone.col] = null;
    }
  }

  let blackStones = 0;
  let whiteStones = 0;
  for (const line of work) {
    for (const cell of line) {
      if (cell === 'black') {
        blackStones += 1;
      } else if (cell === 'white') {
        whiteStones += 1;
      }
    }
  }

  let blackTerritory = 0;
  let whiteTerritory = 0;
  const visited = new Set<string>();
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (work[row]![col] !== null || visited.has(keyOf(row, col))) {
        continue;
      }
      // Flood one empty region, collecting which colours border it.
      const region: Cell[] = [];
      const borders = new Set<StoneColor>();
      const stack: Cell[] = [{ row, col }];
      visited.add(keyOf(row, col));
      while (stack.length > 0) {
        const point = stack.pop()!;
        region.push(point);
        for (const n of neighbours(work, point.row, point.col)) {
          const occupant = work[n.row]![n.col]!;
          if (occupant === null) {
            const key = keyOf(n.row, n.col);
            if (!visited.has(key)) {
              visited.add(key);
              stack.push({ row: n.row, col: n.col });
            }
          } else {
            borders.add(occupant);
          }
        }
      }
      // Only an empty region touching exactly one colour is that colour's
      // territory; anything else (both colours, or a totally empty board)
      // is neutral.
      if (borders.size === 1) {
        if (borders.has('black')) {
          blackTerritory += region.length;
        } else {
          whiteTerritory += region.length;
        }
      }
    }
  }

  const blackArea = blackStones + blackTerritory;
  const whiteArea = whiteStones + whiteTerritory;
  const blackTotal = blackArea;
  const whiteTotal = whiteArea + komi;
  const margin = Math.abs(blackTotal - whiteTotal);

  return {
    blackArea,
    whiteArea,
    komi,
    blackTotal,
    whiteTotal,
    winner:
      blackTotal > whiteTotal ? 'black' : blackTotal < whiteTotal ? 'white' : 'draw',
    margin,
  };
}

/**
 * Block summaries for the agent view, most endangered first.
 *
 * Facts only — sizes, liberty counts, coordinates — never a verdict like
 * "should run" or "is dead"; that judgement is the model's job, and the
 * day this function starts making it, the two roles have merged.
 *
 * Groups are capped per colour with an explicit omitted count so a busy
 * board never silently truncates what the agent believes exists.
 */
export function summarizeGroups(board: GoBoard): GoGroupsView {
  const size = board.length;
  const summaries: Record<StoneColor, GoGroupSummary[]> = {
    black: [],
    white: [],
  };
  const visited = new Set<string>();

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const color = board[row]![col]!;
      if (color === null || visited.has(keyOf(row, col))) {
        continue;
      }
      const block = blockAt(board, row, col);
      for (const stone of block.stones) {
        visited.add(keyOf(stone.row, stone.col));
      }
      // The scan starts topmost-then-leftmost, so stones[0] is exactly the
      // representative the view contract asks for.
      const summary: GoGroupSummary = {
        color,
        stones: block.stones.length,
        representative: block.stones[0]!,
        liberties: block.liberties.size,
      };
      if (block.liberties.size <= 2) {
        summary.libertyAt = block.libertyCells;
      }
      summaries[color].push(summary);
    }
  }

  const mostEndangeredFirst = (a: GoGroupSummary, b: GoGroupSummary): number =>
    a.liberties - b.liberties ||
    b.stones - a.stones ||
    a.representative.row - b.representative.row ||
    a.representative.col - b.representative.col;

  const trimmed = (color: StoneColor): {
    groups: GoGroupSummary[];
    omitted: number;
  } => {
    const sorted = summaries[color].sort(mostEndangeredFirst);
    return {
      groups: sorted.slice(0, GROUP_SUMMARY_LIMIT),
      omitted: Math.max(0, sorted.length - GROUP_SUMMARY_LIMIT),
    };
  };

  const black = trimmed('black');
  const white = trimmed('white');

  return {
    black: black.groups,
    white: white.groups,
    omitted: { black: black.omitted, white: white.omitted },
  };
}

export interface GoBoardTextOptions {
  /** The most recent placed stone, rendered lowercase. */
  lastMove?: Cell | null;
  /** Points emptied by the most recent capture, rendered ×. */
  lastCaptured?: Cell[];
}

/**
 * Monospaced board picture: `B`/`W` stones, `.` empties, the last move in
 * lowercase, points just emptied by a capture as ×. Columns 0-8, rows 00-08,
 * all 0-based — an agent that misreads coordinates plays on the wrong
 * intersection, so the label rows are part of the contract, not decoration.
 */
export function renderGoBoardText(
  board: GoBoard,
  options: GoBoardTextOptions = {},
): string {
  const size = board.length;
  const capturedKeys = new Set(
    (options.lastCaptured ?? []).map((cell) => keyOf(cell.row, cell.col)),
  );
  const lastKey =
    options.lastMove === null || options.lastMove === undefined
      ? null
      : keyOf(options.lastMove.row, options.lastMove.col);

  // Same 3-char right-aligned grid as the gomoku boardText, so one mental
  // parser reads both games and a coordinate habit never has to unlearn.
  const header =
    '  ' +
    Array.from({ length: size }, (_, col) => String(col).padStart(3, ' ')).join(
      '',
    );

  const rows = Array.from(
    { length: size },
    (_, row) =>
      `${String(row).padStart(2, '0')}` +
      Array.from({ length: size }, (_, col) => {
        const occupant = board[row]![col]!;
        const key = keyOf(row, col);
        if (occupant === null) {
          return (capturedKeys.has(key) ? '×' : '.').padStart(3, ' ');
        }
        const glyph = occupant === 'black' ? 'B' : 'W';
        return (key === lastKey ? glyph.toLowerCase() : glyph).padStart(3, ' ');
      }).join(''),
  );

  const lines = [
    header,
    ...rows,
    `(B=黑 W=白 .=空 小写=最新落子 ×=最近提子；行号 00-${String(size - 1).padStart(2, '0')}、列号 0-${size - 1}，均 0-based)`,
  ];
  return lines.join('\n');
}
