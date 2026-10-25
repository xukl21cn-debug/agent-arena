import { describe, expect, it } from 'vitest';
import type { Cell, StoneColor } from '@arena/shared';
import {
  DEFAULT_KOMI,
  GO_BOARD_SIZE,
  blockAt,
  createGoBoard,
  libertiesAt,
  playMove,
  renderGoBoardText,
  scoreBoard,
  summarizeGroups,
  type GoBoard,
} from '../src/core/go';

function place(
  board: GoBoard,
  cells: Array<[number, number]>,
  color: StoneColor,
): GoBoard {
  const next = board.map((line) => line.slice());
  for (const [row, col] of cells) {
    next[row][col] = color;
  }
  return next;
}

function clone(board: GoBoard): GoBoard {
  return board.map((line) => line.slice());
}

function countStones(board: GoBoard): { black: number; white: number } {
  const counts = { black: 0, white: 0 };
  for (const line of board) {
    for (const cell of line) {
      if (cell === 'black' || cell === 'white') {
        counts[cell] += 1;
      }
    }
  }
  return counts;
}

function keys(cells: Cell[]): string[] {
  return cells.map((c) => `${c.row},${c.col}`).sort();
}

describe('createGoBoard', () => {
  it('creates an empty 9x9 board by default', () => {
    const board = createGoBoard();
    expect(board).toHaveLength(GO_BOARD_SIZE);
    expect(board.every((line) => line.length === GO_BOARD_SIZE)).toBe(true);
    expect(board.every((line) => line.every((cell) => cell === null))).toBe(true);
  });

  it('rejects non-positive or fractional sizes', () => {
    expect(() => createGoBoard(0)).toThrow();
    expect(() => createGoBoard(4.5)).toThrow();
  });
});

describe('blockAt / libertiesAt', () => {
  it('counts liberties of the whole block once, not per stone (G-dedup)', () => {
    // L-shape: (1,1) is a shared liberty of (0,1) and (1,0). Per-stone
    // counting reports 4; the block only has 3.
    let board = createGoBoard();
    board = place(board, [[0, 0], [0, 1], [1, 0]], 'black');
    expect(libertiesAt(board, 0, 0)).toBe(3);
    expect(libertiesAt(board, 0, 0)).toBe(
      blockAt(board, 0, 0).libertyCells.length,
    );
    expect(keys(blockAt(board, 0, 0).stones)).toEqual(['0,0', '0,1', '1,0']);
  });

  it('reports one liberty for a nearly-dead block', () => {
    let board = createGoBoard();
    board = place(board, [[1, 1]], 'white');
    board = place(board, [[0, 1], [1, 0], [1, 2], [2, 0], [2, 2], [3, 1]], 'black');
    const block = blockAt(board, 1, 1);
    expect(block.stones).toHaveLength(1);
    expect(keys(block.libertyCells)).toEqual(['2,1']);
    expect(libertiesAt(board, 1, 1)).toBe(1);
  });
});

describe('playMove validation', () => {
  it('rejects off-board points and occupied points', () => {
    let board = createGoBoard();
    board = place(board, [[4, 4]], 'black');
    expect(playMove(board, 'white', -1, 0)).toMatchObject({
      ok: false,
      code: 'OUT_OF_BOUNDS',
    });
    expect(playMove(board, 'white', 0, 9)).toMatchObject({
      ok: false,
      code: 'OUT_OF_BOUNDS',
    });
    expect(playMove(board, 'white', 4, 4)).toMatchObject({
      ok: false,
      code: 'CELL_OCCUPIED',
    });
  });

  it('never mutates the input board, even on capture', () => {
    let board = createGoBoard();
    board = place(board, [[2, 2]], 'black');
    board = place(board, [[2, 1], [1, 2], [3, 2]], 'white');
    const before = clone(board);
    const result = playMove(board, 'white', 2, 3);
    expect(result.ok).toBe(true);
    expect(board).toEqual(before);
  });
});

describe('G1 single-stone capture', () => {
  it('captures a lone stone cut to zero liberties', () => {
    let board = createGoBoard();
    board = place(board, [[2, 2]], 'black');
    board = place(board, [[2, 1], [1, 2], [3, 2]], 'white');

    const result = playMove(board, 'white', 2, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.captured).toEqual([{ row: 2, col: 2 }]);
    expect(result.board[2]![2]).toBeNull();
    // Four liberties after the capture: a plain capture, not a ko.
    expect(result.koPoint).toBeNull();
  });
});

describe('G2 multi-stone capture', () => {
  it('captures a connected pair in one move', () => {
    let board = createGoBoard();
    board = place(board, [[4, 4], [4, 5]], 'black');
    board = place(board, [[3, 4], [3, 5], [4, 3], [5, 4], [5, 5]], 'white');

    const result = playMove(board, 'white', 4, 6);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(keys(result.captured)).toEqual(['4,4', '4,5']);
    expect(result.board[4]![4]).toBeNull();
    expect(result.board[4]![5]).toBeNull();
    expect(result.koPoint).toBeNull();
  });
});

describe('G3 suicide', () => {
  it('rejects a move that leaves the own block without liberties', () => {
    let board = createGoBoard();
    board = place(board, [[0, 1], [1, 0], [1, 1]], 'white');
    const before = clone(board);

    const result = playMove(board, 'black', 0, 0);
    expect(result).toMatchObject({ ok: false, code: 'SUICIDE' });
    expect(board).toEqual(before);
  });

  it('allows capturing your way out of zero liberties (order matters)', () => {
    // Black (0,0) touches only enemy stones: before captures resolve, the
    // played stone has zero liberties. White (0,1) is capturable (its only
    // liberty is (0,0) itself), white (1,0) is not (it keeps (2,0)). An
    // engine that judges suicide before captures rejects this legal move.
    let board = createGoBoard();
    board = place(board, [[0, 2], [1, 1]], 'black');
    board = place(board, [[0, 1], [1, 0]], 'white');

    const result = playMove(board, 'black', 0, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(keys(result.captured)).toEqual(['0,1']);
    expect(result.board[0]![0]).toBe('black');
    expect(result.board[0]![1]).toBeNull();
  });
});

describe('G4 simple ko', () => {
  function koBoard(): GoBoard {
    // . B W .      black: (4,4) in atari, (3,5),(5,5),(4,6) around white's eye
    // B . B W      white: (3,4),(5,4),(4,3); white to play (4,5) takes the ko
    let board = createGoBoard();
    board = place(board, [[4, 4], [3, 5], [5, 5], [4, 6]], 'black');
    board = place(board, [[3, 4], [5, 4], [4, 3]], 'white');
    return board;
  }

  it('sets koPoint only when a lone stone captures exactly one stone', () => {
    const board = koBoard();
    const take = playMove(board, 'white', 4, 5);
    expect(take.ok).toBe(true);
    if (!take.ok) {
      return;
    }
    expect(take.captured).toEqual([{ row: 4, col: 4 }]);
    // The played stone is lone and its only liberty is the captured point.
    expect(take.koPoint).toEqual({ row: 4, col: 4 });
  });

  it('forbids the immediate recapture', () => {
    const board = koBoard();
    const take = playMove(board, 'white', 4, 5);
    if (!take.ok) {
      throw new Error('setup failed');
    }
    const retake = playMove(take.board, 'black', 4, 4, take.koPoint);
    expect(retake).toMatchObject({ ok: false, code: 'KO' });
  });

  it('allows the recapture after a ko threat elsewhere', () => {
    const board = koBoard();
    const take = playMove(board, 'white', 4, 5);
    if (!take.ok) {
      throw new Error('setup failed');
    }
    // Black plays a threat; the ko point clears for that move.
    const threat = playMove(take.board, 'black', 0, 0, take.koPoint);
    expect(threat.ok).toBe(true);
    if (!threat.ok) {
      return;
    }
    expect(threat.koPoint).toBeNull();
    // White answers; black may now take the ko back.
    const answer = playMove(threat.board, 'white', 0, 1);
    expect(answer.ok).toBe(true);
    if (!answer.ok) {
      return;
    }
    const retake = playMove(answer.board, 'black', 4, 4);
    expect(retake.ok).toBe(true);
    if (retake.ok) {
      expect(keys(retake.captured)).toEqual(['4,5']);
      // The retake itself creates the next ko.
      expect(retake.koPoint).toEqual({ row: 4, col: 5 });
    }
  });
});

describe('G12 ko clears on an unrelated move', () => {
  it('recomputes koPoint per move, so a former ko point is playable', () => {
    let board = createGoBoard();
    board = place(board, [[4, 4], [3, 5], [5, 5], [4, 6]], 'black');
    board = place(board, [[3, 4], [5, 4], [4, 3]], 'white');
    const take = playMove(board, 'white', 4, 5);
    if (!take.ok) {
      throw new Error('setup failed');
    }
    const elsewhere = playMove(take.board, 'black', 8, 8, take.koPoint);
    expect(elsewhere.ok).toBe(true);
    if (!elsewhere.ok) {
      return;
    }
    expect(elsewhere.koPoint).toBeNull();
    // No koPoint in play anymore: the former forbidden point is just a point.
    const retake = playMove(elsewhere.board, 'white', 4, 4);
    expect(retake.ok).toBe(true);
  });
});

describe('G13 multi-block capture', () => {
  it('captures two independent blocks with one move', () => {
    let board = createGoBoard();
    board = place(board, [[4, 4], [4, 6]], 'black');
    board = place(
      board,
      [[3, 4], [5, 4], [4, 3], [3, 6], [5, 6], [4, 7]],
      'white',
    );

    const result = playMove(board, 'white', 4, 5);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(keys(result.captured)).toEqual(['4,4', '4,6']);
    expect(result.board[4]![4]).toBeNull();
    expect(result.board[4]![6]).toBeNull();
    // Two stones captured: never a simple ko.
    expect(result.koPoint).toBeNull();
  });
});

describe('G5 territory', () => {
  it('splits the edges and leaves the middle neutral', () => {
    let board = createGoBoard();
    board = place(
      board,
      Array.from({ length: 9 }, (_, row) => [row, 0] as [number, number]),
      'black',
    );
    board = place(
      board,
      Array.from({ length: 9 }, (_, row) => [row, 8] as [number, number]),
      'white',
    );

    const score = scoreBoard(board, [], DEFAULT_KOMI);
    expect(score.blackArea).toBe(9);
    expect(score.whiteArea).toBe(9);
    expect(score.winner).toBe('white');
    expect(score.margin).toBe(DEFAULT_KOMI);
  });
});

describe('G6 dead stones and scoring', () => {
  // The proposal's own G6 board: a lone white stone whose only liberty is
  // (2,1). G5's board would NOT work here — (1,1) there is never enclosed.
  function board(): GoBoard {
    let b = createGoBoard();
    b = place(b, [[1, 1]], 'white');
    b = place(b, [[0, 1], [1, 0], [1, 2], [2, 0], [2, 2], [3, 1]], 'black');
    return b;
  }

  it('with the white stone alive, the big region is black and the eye is neutral', () => {
    const score = scoreBoard(board(), [], DEFAULT_KOMI);
    // The lone white stone is an island: the big empty region only ever
    // touches black, so it is all black territory. The stone's own liberty
    // (2,1) touches black on three sides and is NOT white territory —
    // area scoring gives it to nobody while the stone lives.
    expect(score.blackArea).toBe(6 + 73);
    expect(score.whiteArea).toBe(1); // the stone only
    expect(score.winner).toBe('black');
  });

  it('marked dead, the stone vanishes and everything turns black', () => {
    const score = scoreBoard(board(), [{ row: 1, col: 1 }], DEFAULT_KOMI);
    expect(score.whiteArea).toBe(0);
    expect(score.blackArea).toBe(81);
    expect(score.winner).toBe('black');
    expect(score.whiteTotal).toBe(DEFAULT_KOMI); // komi is all white has left
  });
});

describe('G9 seki', () => {
  it('counts both sides alive and shared liberties neutral', () => {
    // Two facing three-stone walls, edges left and top, right and bottom
    // capped by enemy stones: the three shared points are each wall's only
    // liberties, and neither side can fill one without dying first.
    let board = createGoBoard();
    board = place(
      board,
      [[0, 0], [1, 0], [2, 0], [0, 3], [1, 3], [2, 3], [3, 1], [3, 2]],
      'black',
    );
    board = place(board, [[0, 2], [1, 2], [2, 2], [3, 0]], 'white');

    expect(libertiesAt(board, 0, 0)).toBe(3);
    expect(libertiesAt(board, 0, 2)).toBe(3);

    // Area scoring just counts what is there: the shared column and the
    // outer region both touch two colours, so nobody gets territory.
    const score = scoreBoard(board, [], DEFAULT_KOMI);
    expect(score.blackArea).toBe(8);
    expect(score.whiteArea).toBe(4);
    expect(score.winner).toBe('white');
    expect(score.margin).toBe(3.5);
  });
});

describe('G16 scoring, komi and margins', () => {
  // black: rows 0-4 x cols 0-7 = 40; white: col 8 rows 0-3, rows 5-8 x
  // cols 0-6, (5,7),(6,7),(7,7) = 35; six empty points touch both colours.
  function board(): GoBoard {
    let b = createGoBoard();
    const blackCells: Array<[number, number]> = [];
    for (let row = 0; row <= 4; row += 1) {
      for (let col = 0; col <= 7; col += 1) {
        blackCells.push([row, col]);
      }
    }
    b = place(b, blackCells, 'black');
    const whiteCells: Array<[number, number]> = [
      [0, 8], [1, 8], [2, 8], [3, 8],
      [5, 7], [6, 7], [7, 7],
    ];
    for (let row = 5; row <= 8; row += 1) {
      for (let col = 0; col <= 6; col += 1) {
        whiteCells.push([row, col]);
      }
    }
    b = place(b, whiteCells, 'white');
    return b;
  }

  it('gives white the game at komi 7.5 (40 vs 35+7.5)', () => {
    const score = scoreBoard(board(), [], 7.5);
    expect(score.blackTotal).toBe(40);
    expect(score.whiteTotal).toBe(42.5);
    expect(score.winner).toBe('white');
    expect(score.margin).toBe(2.5);
  });

  it('is a draw at komi 5 and black by half a point at komi 4.5', () => {
    expect(scoreBoard(board(), [], 5).winner).toBe('draw');
    const half = scoreBoard(board(), [], 4.5);
    expect(half.winner).toBe('black');
    expect(half.margin).toBe(0.5);
  });
});

describe('G11 engine invariant (random self-play)', () => {
  // Deterministic PRNG: a flaky invariant test would be worse than none.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function selfPlay(
    seed: number,
  ): {
    board: GoBoard;
    places: { black: number; white: number };
    prisoners: { black: number; white: number };
  } {
    const random = mulberry32(seed);
    let board = createGoBoard();
    let koPoint: Cell | null = null;
    let color: StoneColor = 'black';
    // places counts stones actually placed — NOT moves. The day M3 adds
    // pass, moves and places diverge; this invariant must not notice.
    const places = { black: 0, white: 0 };
    // prisoners.black = black stones taken off the board by white.
    const prisoners = { black: 0, white: 0 };

    for (let guard = 0; guard < 10_000; guard += 1) {
      const blocked = new Set<string>();
      for (;;) {
        const empties: Cell[] = [];
        for (let row = 0; row < 9; row += 1) {
          for (let col = 0; col < 9; col += 1) {
            if (board[row]![col] !== null) {
              continue;
            }
            if (koPoint && koPoint.row === row && koPoint.col === col) {
              continue;
            }
            if (blocked.has(`${row},${col}`)) {
              continue;
            }
            empties.push({ row, col });
          }
        }
        if (empties.length === 0) {
          return { board, places, prisoners };
        }
        const pick = empties[Math.floor(random() * empties.length)]!;
        const result = playMove(board, color, pick.row, pick.col, koPoint);
        if (result.ok) {
          board = result.board;
          koPoint = result.koPoint;
          places[color] += 1;
          prisoners[color === 'black' ? 'white' : 'black'] +=
            result.captured.length;
          color = color === 'black' ? 'white' : 'black';
          break;
        }
        blocked.add(`${pick.row},${pick.col}`);
      }
    }
    return { board, places, prisoners };
  }

  it('conserves stones: placed = on board + taken by opponent', () => {
    for (const seed of [1, 7, 42]) {
      const { board, places, prisoners } = selfPlay(seed);
      const onBoard = countStones(board);
      // A black stone, once placed, is either still standing or was removed
      // by white; nothing else can happen to it.
      expect(places.black).toBe(onBoard.black + prisoners.black);
      expect(places.white).toBe(onBoard.white + prisoners.white);
      // A random game fills most of the board; a no-op loop would "pass"
      // this invariant with zero stones, so pin some activity.
      expect(places.black + places.white).toBeGreaterThan(60);
    }
  });
});

describe('summarizeGroups', () => {
  it('orders by danger and includes liberty coordinates only at 1-2 libs', () => {
    let board = createGoBoard();
    board = place(board, [[0, 0]], 'white');
    board = place(board, [[0, 1]], 'black');
    board = place(board, [[8, 8]], 'white');
    board = place(board, [[5, 5], [5, 6]], 'white');

    const view = summarizeGroups(board);
    expect(view.omitted).toEqual({ black: 0, white: 0 });
    const whites = view.white;
    expect(whites).toHaveLength(3);
    expect(whites[0]).toMatchObject({
      stones: 1,
      representative: { row: 0, col: 0 },
      liberties: 1,
    });
    expect(keys(whites[0]!.libertyAt ?? [])).toEqual(['1,0']);
    expect(whites[1]!.liberties).toBe(2);
    expect(whites[1]!.libertyAt).toBeDefined();
    // A six-liberty pair has no libertyAt and keeps its top-left representative.
    expect(whites[2]!.libertyAt).toBeUndefined();
    expect(whites[2]!.representative).toEqual({ row: 5, col: 5 });
  });

  it('caps groups per colour and reports the omitted counts', () => {
    let board = createGoBoard();
    // Checkerboard rows 0-6: 32 white singles, 31 black singles, none
    // adjacent — every stone is its own group.
    for (let row = 0; row <= 6; row += 1) {
      for (let col = 0; col < 9; col += 1) {
        board[row]![col] = (row + col) % 2 === 0 ? 'white' : 'black';
      }
    }
    const view = summarizeGroups(board);
    expect(view.white).toHaveLength(12);
    expect(view.black).toHaveLength(12);
    expect(view.omitted).toEqual({ black: 31 - 12, white: 32 - 12 });
  });
});

describe('renderGoBoardText', () => {
  it('marks the last move lowercase and captured points with ×', () => {
    // (3,4) is empty: a white stone there was just captured, and the board
    // picture shows the fresh hole, not a stone.
    let board = createGoBoard();
    board = place(board, [[4, 4]], 'black');
    const text = renderGoBoardText(board, {
      lastMove: { row: 4, col: 4 },
      lastCaptured: [{ row: 3, col: 4 }],
    });
    const lines = text.split('\n');
    expect(lines[5]).toContain('b');
    expect(lines[4]).toContain('×');
    expect(lines[10]).toContain('B=黑');
  });

  it('keeps a 60-stone board well inside the agent view budget (G18)', () => {
    let board = createGoBoard();
    let placed = 0;
    for (let row = 0; row <= 6 && placed < 60; row += 1) {
      for (let col = 0; col < 9 && placed < 60; col += 1) {
        board[row]![col] = (row + col) % 2 === 0 ? 'black' : 'white';
        placed += 1;
      }
    }
    expect(countStones(board).black + countStones(board).white).toBe(60);

    const text = renderGoBoardText(board, { lastMove: { row: 6, col: 5 } });
    const groups = JSON.stringify(summarizeGroups(board));
    // M2's whole AgentStateView budget is 4000 chars; the board picture and
    // the groups table are its two big items, so bound them together here.
    expect(text.length + groups.length).toBeLessThan(4000);
    expect(text.split('\n')).toHaveLength(11); // header + 9 rows + legend
  });
});
