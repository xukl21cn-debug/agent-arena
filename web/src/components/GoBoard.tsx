import type { GoState, StoneColor } from '@arena/shared';
import { Stone } from './Stone';

interface GoBoardProps {
  state: GoState | null;
  humanColor: StoneColor | null;
  busy: boolean;
  overlay?: React.ReactNode;
  /** Place a stone; only called on a legal human placement. */
  onPlay: (row: number, col: number) => void;
  /** Toggle the whole block at a stone as dead; only during scoring. */
  onToggleDead: (row: number, col: number) => void;
  /** Replay view: render the position, accept no input — not even dead-marking. */
  readOnly?: boolean;
}

/** The five hoshi points of a 9×9 board, fixed by the proposal. */
const STAR_POINTS: ReadonlyArray<{ row: number; col: number }> = [
  { row: 2, col: 2 },
  { row: 2, col: 6 },
  { row: 4, col: 4 },
  { row: 6, col: 2 },
  { row: 6, col: 6 },
];

function cellLabel(
  row: number,
  col: number,
  color: StoneColor | null,
  dead: boolean,
  playable: boolean,
  markable: boolean,
): string {
  const position = `第 ${row} 行第 ${col} 列`;
  if (color === 'black') {
    return dead
      ? `${position}，黑子，已标死子，点击取消`
      : markable
        ? `${position}，黑子，点击标记死子`
        : `${position}，黑子`;
  }
  if (color === 'white') {
    return dead
      ? `${position}，白子，已标死子，点击取消`
      : markable
        ? `${position}，白子，点击标记死子`
        : `${position}，白子`;
  }
  if (playable) {
    return `${position}，落子`;
  }
  return `${position}，空位`;
}

export function GoBoard({
  state,
  humanColor,
  busy,
  overlay,
  onPlay,
  onToggleDead,
  readOnly = false,
}: GoBoardProps) {
  const size = state?.rules.boardSize ?? 9;
  const indexes = Array.from({ length: size }, (_, index) => index);

  // Scoring has no turns: every stone becomes markable and nothing is
  // playable. Playing keeps the gomoku placement gate.
  const scoring = state?.status === 'scoring';
  const canPlay =
    !readOnly &&
    state?.status === 'playing' &&
    humanColor !== null &&
    state.turn === humanColor &&
    !busy;
  const canMark = !readOnly && scoring && !busy;

  const dead = new Set(
    (scoring ? (state?.deadStones ?? []) : []).map(
      (cell) => `${cell.row}-${cell.col}`,
    ),
  );
  const captured = new Set(
    (state?.lastCaptured ?? []).map((cell) => `${cell.row}-${cell.col}`),
  );
  const lastMove =
    state?.lastMove && !('kind' in state.lastMove) ? state.lastMove : null;

  const handleCell = (row: number, col: number, color: StoneColor | null) => {
    if (canMark && color !== null) {
      onToggleDead(row, col);
      return;
    }
    if (canPlay && color === null) {
      onPlay(row, col);
    }
  };

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
          {/* Same intersection model as the gomoku board: the 9 lines each
              way pass through the centres of the 9×9 hit cells. */}
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
              {STAR_POINTS.map(({ row, col }) => (
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
            aria-label={`围棋棋盘，${size} 乘 ${size}`}
            style={{
              gridTemplateColumns: `repeat(${size}, 1fr)`,
              gridTemplateRows: `repeat(${size}, 1fr)`,
            }}
          >
            {indexes.map((row) =>
              indexes.map((col) => {
                const color = state?.board[row]?.[col] ?? null;
                const isDead = dead.has(`${row}-${col}`);
                const isCaptured = captured.has(`${row}-${col}`);
                const playable = canPlay && color === null;
                // A clickable cell is either an empty point on turn or a
                // stone while marking; everything else is inert.
                const clickable = playable || (canMark && color !== null);
                const isLast = lastMove?.row === row && lastMove?.col === col;

                const classes = ['cell'];
                if (clickable) {
                  classes.push('cell--playable');
                }
                if (isCaptured && color === null) {
                  classes.push('cell--captured');
                }

                return (
                  <button
                    key={`${row}-${col}`}
                    type="button"
                    className={classes.join(' ')}
                    disabled={!clickable}
                    aria-label={cellLabel(
                      row,
                      col,
                      color,
                      isDead,
                      playable,
                      canMark,
                    )}
                    onClick={() => handleCell(row, col, color)}
                  >
                    {color ? (
                      <Stone color={color} last={isLast} dead={isDead} />
                    ) : null}
                    {isCaptured && color === null ? (
                      <span className="cap-mark" aria-hidden="true">
                        ×
                      </span>
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
