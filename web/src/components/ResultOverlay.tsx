import type { AnyGameState, StoneColor } from '@arena/shared';

interface ResultOverlayProps {
  state: AnyGameState;
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
    state.game === 'go'
      ? state.endReason === 'scored'
        ? '数子终局'
        : state.endReason === 'draw'
          ? '和棋'
          : '认输'
      : state.endReason === 'resign'
        ? '认输'
        : state.endReason === 'draw'
          ? '棋盘下满'
          : '五连';

  // Go's counted result carries the numbers: totals with komi and the margin.
  const score =
    state.game === 'go' && state.endReason === 'scored' && state.score
      ? state.score
      : null;

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
        {score ? (
          <div className="result-score">
            <span>黑 {score.blackTotal} 目</span>
            <span>白 {score.whiteTotal} 目（含贴目 {score.komi}）</span>
            <span>
              {score.winner === 'draw'
                ? '和棋'
                : `${score.winner === 'black' ? '黑' : '白'}胜 ${score.margin} 目`}
            </span>
          </div>
        ) : null}
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
