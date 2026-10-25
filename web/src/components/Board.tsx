import type { ReactNode } from 'react';
import {
  DEFAULT_BOARD_SIZE,
  type GameState,
  type StoneColor,
} from '@arena/shared';
import { Stone } from './Stone';

interface BoardProps {
  state: GameState | null;
  humanColor: StoneColor | null;
  busy: boolean;
  overlay?: ReactNode;
  onPlay: (row: number, col: number) => void;
}

function starPoints(size: number): ReadonlyArray<{ row: number; col: number }> {
  if (size < 13) {
    return [];
  }
  const low = 3;
  const high = size - 4;
  const middle = Math.floor(size / 2);
  return [
    { row: low, col: low },
    { row: low, col: high },
    { row: middle, col: middle },
    { row: high, col: low },
    { row: high, col: high },
  ];
}

function cellLabel(
  row: number,
  col: number,
  color: StoneColor | null,
  playable: boolean,
): string {
  const position = `第 ${row} 行第 ${col} 列`;
  if (color === 'black') {
    return `${position}，黑子`;
  }
  if (color === 'white') {
    return `${position}，白子`;
  }
  return playable ? `${position}，落子` : `${position}，空位`;
}

export function Board({
  state,
  humanColor,
  busy,
  overlay,
  onPlay,
}: BoardProps) {
  const size = state?.rules.boardSize ?? DEFAULT_BOARD_SIZE;
  const indexes = Array.from({ length: size }, (_, index) => index);
  const stars = starPoints(size);
  const winCells = new Set(
    (state?.winLine ?? []).map((cell) => `${cell.row}-${cell.col}`),
  );
  const lastMove = state?.lastMove ?? null;
  const canPlay =
    state?.status === 'playing' &&
    humanColor !== null &&
    state.turn === humanColor &&
    !busy;

  return (
    <div className="board-frame">
      <div className="board-corner" aria-hidden="true" />
      <div
        className="board-cols"
        aria-hidden="true"
        style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}
      >
        {indexes.map((col) => (
          <span key={col}>{col}</span>
        ))}
      </div>
      <div
        className="board-rows"
        aria-hidden="true"
        style={{ gridTemplateRows: `repeat(${size}, 1fr)` }}
      >
        {indexes.map((row) => (
          <span key={row}>{row}</span>
        ))}
      </div>

      <div className="board-wrap">
        <div className="board">
          {/*
            Gomoku is played on intersections: the 15 lines each way pass
            through the centres of the 15×15 hit cells, leaving a half-cell
            wood margin around the grid.
          */}
          <svg
            className="board-grid"
            viewBox={`0 0 ${size} ${size}`}
            aria-hidden="true"
            focusable="false"
          >
            <g>
              {indexes.map((index) => (
                <line
                  key={`v-${index}`}
                  x1={index + 0.5}
                  y1={0.5}
                  x2={index + 0.5}
                  y2={size - 0.5}
                />
              ))}
              {indexes.map((index) => (
                <line
                  key={`h-${index}`}
                  x1={0.5}
                  y1={index + 0.5}
                  x2={size - 0.5}
                  y2={index + 0.5}
                />
              ))}
              {/*
                Star points live in the same coordinate system as the lines:
                SVG circles scale uniformly, unlike tiny HTML boxes which
                Chrome can snap into ovals at fractional positions.
              */}
              {stars.map(({ row, col }) => (
                <circle
                  key={`star-${row}-${col}`}
                  cx={col + 0.5}
                  cy={row + 0.5}
                  r={0.1}
                />
              ))}
            </g>
          </svg>

          <div
            className="board-cells"
            role="group"
            aria-label={`五子棋棋盘，${size} 乘 ${size}`}
            style={{
              gridTemplateColumns: `repeat(${size}, 1fr)`,
              gridTemplateRows: `repeat(${size}, 1fr)`,
            }}
          >
            {indexes.map((row) =>
              indexes.map((col) => {
                const color = state?.board[row]?.[col] ?? null;
                const playable = canPlay && color === null;
                const isLast =
                  lastMove?.row === row && lastMove?.col === col;
                const isWin = winCells.has(`${row}-${col}`);

                const classes = ['cell'];
                if (playable) {
                  classes.push('cell--playable');
                }
                if (isWin) {
                  classes.push('cell--win');
                }

                return (
                  <button
                    key={`${row}-${col}`}
                    type="button"
                    className={classes.join(' ')}
                    disabled={!playable}
                    aria-label={cellLabel(row, col, color, playable)}
                    onClick={() => onPlay(row, col)}
                  >
                    {color ? (
                      <Stone color={color} last={isLast} />
                    ) : null}
                    {playable && humanColor ? (
                      <Stone color={humanColor} preview />
                    ) : null}
                  </button>
                );
              }),
            )}
          </div>
        </div>
        {overlay}
      </div>
    </div>
  );
}
