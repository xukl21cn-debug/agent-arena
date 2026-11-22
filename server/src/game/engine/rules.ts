import {
  DEFAULT_RULES,
  type Cell,
  type RuleSet,
  type StoneColor,
} from '@arena/shared';

const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
] as const;

export function resolveRules(partial?: Partial<RuleSet>): RuleSet {
  const rules: RuleSet = { ...DEFAULT_RULES, ...partial };

  if (!Number.isInteger(rules.boardSize) || rules.boardSize < 3) {
    throw new Error(`boardSize must be an integer >= 3, got ${rules.boardSize}`);
  }

  if (!Number.isInteger(rules.winLength) || rules.winLength < 3) {
    throw new Error(`winLength must be an integer >= 3, got ${rules.winLength}`);
  }

  if (rules.winLength > rules.boardSize) {
    throw new Error(
      `winLength (${rules.winLength}) cannot exceed boardSize (${rules.boardSize})`,
    );
  }

  if (rules.forbidden !== 'none') {
    throw new Error(`Unsupported forbidden rule: ${String(rules.forbidden)}`);
  }

  return rules;
}

export function createBoard(size: number): (StoneColor | null)[][] {
  return Array.from({ length: size }, () =>
    Array<StoneColor | null>(size).fill(null),
  );
}

export function isInside(
  board: ReadonlyArray<ReadonlyArray<unknown>>,
  row: number,
  col: number,
): boolean {
  if (!Number.isInteger(row) || !Number.isInteger(col)) {
    return false;
  }

  if (row < 0 || col < 0) {
    return false;
  }

  const width = board[0]?.length ?? 0;
  return row < board.length && col < width;
}

export function isBoardFull(
  board: ReadonlyArray<ReadonlyArray<unknown>>,
): boolean {
  return (
    board.length > 0 &&
    board.every((row) => row.every((cell) => cell !== null))
  );
}

export function findWinLine(
  board: ReadonlyArray<ReadonlyArray<StoneColor | null>>,
  row: number,
  col: number,
  rules: RuleSet,
): Cell[] | null {
  const color = board[row]?.[col];
  if (!color) {
    return null;
  }

  for (const [dr, dc] of DIRECTIONS) {
    const line: Cell[] = [{ row, col }];

    let r = row - dr;
    let c = col - dc;
    while (isInside(board, r, c) && board[r]?.[c] === color) {
      line.unshift({ row: r, col: c });
      r -= dr;
      c -= dc;
    }

    r = row + dr;
    c = col + dc;
    while (isInside(board, r, c) && board[r]?.[c] === color) {
      line.push({ row: r, col: c });
      r += dr;
      c += dc;
    }

    const wins = rules.overlineWin
      ? line.length >= rules.winLength
      : line.length === rules.winLength;

    if (wins) {
      return line;
    }
  }

  return null;
}
