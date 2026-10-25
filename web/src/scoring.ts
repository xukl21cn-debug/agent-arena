import type { Cell, GoBoard, GoScore, StoneColor } from '@arena/shared';

/**
 * Chinese-area scoring as a display-only preview for the web's scoring panel.
 *
 * The room's GoState carries no preview — the authoritative number is
 * GoState.score, produced by the engine's scoreBoard once both sides
 * confirmed. This function mirrors that algorithm so the panel can show
 * where the count stands while the marks are still moving:
 * dead stones leave the board, stones + one-colour-bordered empty regions
 * make the area, white adds komi. If this ever disagrees with the engine,
 * the engine wins and this copy is the bug.
 */
export function previewScore(
  board: GoBoard,
  deadStones: Cell[],
  komi: number,
): GoScore {
  const size = board.length;
  const work: GoBoard = board.map((line) => line.slice());
  for (const stone of deadStones) {
    if (stone.row >= 0 && stone.row < size && stone.col >= 0 && stone.col < size) {
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

  const neighbours = (row: number, col: number): Cell[] => {
    const list: Cell[] = [];
    if (row > 0) list.push({ row: row - 1, col });
    if (row < size - 1) list.push({ row: row + 1, col });
    if (col > 0) list.push({ row, col: col - 1 });
    if (col < size - 1) list.push({ row, col: col + 1 });
    return list;
  };

  let blackTerritory = 0;
  let whiteTerritory = 0;
  const visited = new Set<string>();
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (work[row]![col] !== null || visited.has(`${row}-${col}`)) {
        continue;
      }
      // Flood one empty region, collecting which colours border it.
      const region: Cell[] = [];
      const borders = new Set<StoneColor>();
      const stack: Cell[] = [{ row, col }];
      visited.add(`${row}-${col}`);
      while (stack.length > 0) {
        const point = stack.pop()!;
        region.push(point);
        for (const n of neighbours(point.row, point.col)) {
          const occupant = work[n.row]![n.col]!;
          if (occupant === null) {
            const key = `${n.row}-${n.col}`;
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
      blackTotal > whiteTotal
        ? 'black'
        : blackTotal < whiteTotal
          ? 'white'
          : 'draw',
    margin,
  };
}
