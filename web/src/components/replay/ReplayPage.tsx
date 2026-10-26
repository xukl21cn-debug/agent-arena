import { useCallback, useEffect, useState } from 'react';
import type { AnyGameState, ReplayResponse } from '@arena/shared';
import { api, errorMessage } from '../../api';
import { endLabel } from '../../labels';
import { Board } from '../Board';
import { GoBoard } from '../GoBoard';

function clockOf(at: string): string {
  return at.slice(11, 16);
}

/**
 * The endgame label reads the persisted final state, never the replayed
 * frames: resign and scoring happen off-board and leave no trace in the
 * history, so the frames cannot express them. Wording lives in labels.ts,
 * which the lobby's history cards share.
 */
function endLabelOf(final: AnyGameState): string | null {
  if (final.status !== 'finished') {
    return null;
  }
  return endLabel(final.game, final.winner, final.endReason);
}

function moveLabelOf(move: ReplayResponse['frames'][number]['move']): string {
  if (move === null) {
    return '开局';
  }
  const color = move.color === 'black' ? '黑' : '白';
  const clock = clockOf(move.at);
  // `'kind' in move` is the discriminator: placements carry no kind field.
  if ('kind' in move) {
    return `${color} pass · ${clock}`;
  }
  return `${color} (${move.row}, ${move.col}) · ${clock}`;
}

interface ReplayPageProps {
  /** The room whose current game is replayed. */
  roomId?: string;
  /** The archived game to replay; wins over roomId when both are present. */
  archiveId?: string;
}

/**
 * 棋谱回放：all frames arrive in one payload, so stepping — buttons, the
 * progress bar, the keyboard — is pure memory; the server is not asked
 * again. The boards are the live components in read-only mode: star points,
 * coordinates and capture marks stay maintained in one place.
 */
export function ReplayPage({ roomId, archiveId }: ReplayPageProps) {
  const [replay, setReplay] = useState<ReplayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load =
      archiveId !== undefined
        ? api.getArchiveReplay(archiveId)
        : roomId !== undefined
          ? api.getRoomReplay(roomId)
          : null;
    if (load === null) {
      setError('缺少 room 或 archive 参数。');
      return () => undefined;
    }
    load
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setReplay(payload);
        // Open on the final position: the result is what a review starts from.
        setIndex(payload.frames.length - 1);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(errorMessage(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, archiveId]);

  const last = replay ? replay.frames.length - 1 : 0;
  const clamp = useCallback(
    (next: number) => {
      setIndex(Math.min(Math.max(next, 0), last));
    },
    [last],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // The progress bar handles its own arrows; handling them again here
      // would double-step.
      if (
        event.target instanceof HTMLInputElement &&
        event.target.type === 'range'
      ) {
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        clamp(index - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        clamp(index + 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        clamp(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        clamp(last);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clamp, index, last]);

  if (error !== null) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <p className="eyebrow">Agent Arena · MCP</p>
            <h1 className="title">棋谱回放</h1>
            <p className="subtitle">历史对局，逐手重放。</p>
          </div>
        </header>
        <div className="error-bar" role="alert">
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (replay === null) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <p className="eyebrow">Agent Arena · MCP</p>
            <h1 className="title">棋谱回放</h1>
            <p className="subtitle">读取中…</p>
          </div>
        </header>
      </div>
    );
  }

  const frame = replay.frames[index] ?? replay.frames[0]!;
  const endLabel = endLabelOf(replay.final);
  const atFinal = index === replay.frames.length - 1;
  const goScoring =
    frame.state.game === 'go' && frame.state.status === 'scoring';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <p className="eyebrow">Agent Arena · MCP</p>
          <h1 className="title">棋谱回放</h1>
          <p className="subtitle">
            {replay.game === 'go'
              ? `围棋 · ${replay.frames.length - 1} 手`
              : `五子棋 · ${replay.frames.length - 1} 手`}
            {endLabel !== null ? ` · ${endLabel}` : ''}
          </p>
        </div>
        <div className="topbar-meta">
          {replay.archiveId !== null ? (
            <span className="room-chip" title="归档">
              archive / {replay.archiveId}
            </span>
          ) : null}
          <span className="room-chip" title="房间号">
            room / {replay.roomId}
          </span>
          {endLabel !== null ? (
            <span className="replay-result">{endLabel}</span>
          ) : null}
        </div>
      </header>

      <main className="replay-main">
        <div className="board-column">
          <div key={replay.gameId}>
            {frame.state.game === 'go' ? (
              <GoBoard
                state={frame.state}
                humanColor={null}
                busy={false}
                readOnly
                onPlay={() => undefined}
                onToggleDead={() => undefined}
              />
            ) : (
              <Board
                state={frame.state}
                humanColor={null}
                busy={false}
                readOnly
                onPlay={() => undefined}
              />
            )}
          </div>

          <div className="replay-controls">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={index === 0}
              onClick={() => clamp(0)}
              aria-label="跳到开局"
            >
              ⏮
            </button>
            <button
              type="button"
              className="btn"
              disabled={index === 0}
              onClick={() => clamp(index - 1)}
              aria-label="上一手"
            >
              ◀
            </button>
            <span className="replay-count">
              第 {index} / {replay.frames.length - 1} 手
            </span>
            <button
              type="button"
              className="btn"
              disabled={atFinal}
              onClick={() => clamp(index + 1)}
              aria-label="下一手"
            >
              ▶
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={atFinal}
              onClick={() => clamp(last)}
              aria-label="跳到最后"
            >
              ⏭
            </button>
            <input
              className="replay-range"
              type="range"
              min={0}
              max={replay.frames.length - 1}
              value={index}
              aria-label="回放进度"
              onChange={(event) => clamp(Number(event.target.value))}
            />
          </div>

          <p className="replay-move">
            {moveLabelOf(frame.move)}
            {goScoring ? <span className="replay-scoring">进入数子</span> : null}
          </p>

          {atFinal && endLabel !== null ? (
            <p className="replay-final">{endLabel}</p>
          ) : null}

          <p className="rule-note">回放只重演落子，不含认输与数子</p>
        </div>
      </main>
    </div>
  );
}
