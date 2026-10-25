import type { GameState, StoneColor } from '@gomoku/shared';

interface ResultOverlayProps {
  state: GameState;
  humanColor: StoneColor | null;
  /** Both seats are agents: report who won, offer no rematch. */
  spectator: boolean;
  busy: boolean;
  onRematch?: () => void;
  onDismiss: () => void;
}

export function ResultOverlay({
  state,
  humanColor,
  spectator,
  busy,
  onRematch,
  onDismiss,
}: ResultOverlayProps) {
  const draw = state.winner === 'draw';
  const humanWon = !spectator && state.winner === humanColor;
  // A spectator has no side, so the stamp names the winning color instead of
  // scoring a win or a loss.
  const seal = draw
    ? '和'
    : spectator
      ? state.winner === 'black'
        ? '黑'
        : '白'
      : humanWon
        ? '胜'
        : '负';
  const title = draw
    ? '和棋'
    : spectator
      ? state.winner === 'black'
        ? '黑方获胜'
        : '白方获胜'
      : humanWon
        ? '你赢了'
        : 'AI 获胜';
  const reason =
    state.endReason === 'resign'
      ? '认输'
      : state.endReason === 'draw'
        ? '棋盘下满'
        : '五连';

  return (
    <div className="result-overlay" role="dialog" aria-label="对局结果">
      <div className="result-card">
        <span className="seal" aria-hidden="true">
          {seal}
        </span>
        <h3 className="result-title">{title}</h3>
        <p className="result-detail">
          {reason} · 共 {state.moveCount} 手
        </p>
        <div className="result-actions">
          {onRematch ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={onRematch}
              disabled={busy}
            >
              再来一局
            </button>
          ) : null}
          <button type="button" className="btn btn--ghost" onClick={onDismiss}>
            看看棋盘
          </button>
        </div>
      </div>
    </div>
  );
}
