import type { GoState, StoneColor } from '@arena/shared';
import { previewScore } from '../scoring';

interface ScoringPanelProps {
  state: GoState;
  humanColor: StoneColor | null;
  /** Both seats are agents: show the marks and the count, offer no buttons. */
  spectator: boolean;
  busy: boolean;
  onConfirm: () => void;
  onResume: () => void;
}

export function ScoringPanel({
  state,
  humanColor,
  spectator,
  busy,
  onConfirm,
  onResume,
}: ScoringPanelProps) {
  const komi = state.rules.komi;
  const preview = previewScore(state.board, state.deadStones, komi);
  const deadCount = state.deadStones.length;

  // Scoring has no turn, so the panel never says whose move it is — both
  // sides confirm independently, and any new mark resets both confirmations.
  const mine = humanColor === null ? null : state.scoreConfirmed[humanColor];
  const theirs =
    humanColor === null ? null : state.scoreConfirmed[humanColor === 'black' ? 'white' : 'black'];
  const myLabel = humanColor === 'black' ? '黑方（你）' : '白方（你）';
  const theirLabel = humanColor === 'black' ? '白方（AI）' : '黑方（AI）';

  const leader =
    preview.winner === 'draw'
      ? '双方持平'
      : preview.winner === 'black'
        ? `黑胜 ${preview.margin} 目`
        : `白胜 ${preview.margin} 目`;

  return (
    <section className="scoring-panel" aria-label="数子面板">
      <div className="scoring-head">
        <h3 className="scoring-title">数子阶段</h3>
        <p className="scoring-hint">
          点击棋子标记或取消死子（整块生效）——双方各自确认后出分
        </p>
      </div>

      <div className="scoring-facts">
        <span className="scoring-fact">
          死子：{deadCount > 0 ? `${deadCount} 子` : '未标记'}
        </span>
        <span className="scoring-fact">
          {spectator
            ? `确认：黑方 ${state.scoreConfirmed.black ? '✓' : '—'} · 白方 ${
                state.scoreConfirmed.white ? '✓' : '—'
              }`
            : `确认：${myLabel} ${mine ? '✓' : '—'} · ${theirLabel} ${
                theirs ? '✓' : '—'
              }`}
        </span>
      </div>

      <p className="scoring-preview" aria-live="polite">
        黑 {preview.blackTotal} 目 · 白 {preview.whiteTotal} 目（含贴目 {komi}）
        → {leader}
      </p>
      <p className="scoring-note">预览随死子标记实时更新，终局分数以双方确认为准。</p>

      {!spectator ? (
        <div className="scoring-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={onConfirm}
            disabled={busy || mine === true}
          >
            {mine ? '已确认，等对方' : '确认数子'}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onResume}
            disabled={busy}
            title="回到对局继续落子，轮次保持进入数子前的那一方"
          >
            继续下棋
          </button>
        </div>
      ) : null}
    </section>
  );
}
