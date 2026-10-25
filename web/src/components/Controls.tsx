import { useEffect, useRef, useState } from 'react';
import type { GameState, RoomPhase, StoneColor } from '@arena/shared';

interface ControlsProps {
  state: GameState | null;
  humanColor: StoneColor | null;
  /** Both seats are agents: this bar offers nothing to click. */
  spectator: boolean;
  /** Room lifecycle: lobby/waiting swap the start buttons for a ready one. */
  phase: RoomPhase;
  yourReady: boolean;
  /** Client-side clock for the "opponent never came" hint, or null. */
  waitingSince: number | null;
  busy: boolean;
  onStart: (humanColor: StoneColor) => void;
  onReady: (ready: boolean) => void;
  onResign: () => void;
}

const CONFIRM_WINDOW_MS = 4_000;
/** How long the room may wait for the other side before naming the problem. */
const READY_HINT_AFTER_MS = 60_000;

export function Controls({
  state,
  humanColor,
  spectator,
  phase,
  yourReady,
  waitingSince,
  busy,
  onStart,
  onReady,
  onResign,
}: ControlsProps) {
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One tick per second, only while the room actually waits: it powers the
  // "the other side never showed up" hint without a permanent timer.
  useEffect(() => {
    if (phase !== 'waiting') {
      return;
    }
    const ticker = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(ticker);
  }, [phase]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setConfirming(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [state?.gameId, state?.status]);

  if (spectator) {
    // Nobody here can take a seat or resign: the buttons would either lie
    // ("执黑开局" would unseat an agent) or act on a game that is not ours.
    return (
      <div className="controls">
        <span className="spectator-chip" title="两个 AI 各执一色，人类只看">
          观战中
        </span>
      </div>
    );
  }

  if (phase === 'lobby' || phase === 'waiting') {
    // Gathering: the old "pick a color and start" buttons would answer a
    // question the room has not asked yet. One ready button instead.
    const waitedMs =
      phase === 'waiting' && waitingSince !== null ? now - waitingSince : 0;
    return (
      <div className="controls">
        <div className="control-group">
          <button
            type="button"
            className={`btn ${yourReady ? '' : 'btn--primary'}`}
            onClick={() => onReady(!yourReady)}
            disabled={busy}
          >
            {yourReady ? '取消准备' : '准备'}
          </button>
          {phase === 'lobby' ? (
            <span className="ready-note">双方都准备好后自动开局</span>
          ) : null}
        </div>
        {waitedMs >= READY_HINT_AFTER_MS ? (
          <p className="ready-hint" role="status">
            对方超过 60 秒还没准备——AI 可能还没接入，检查 MCP 配置
          </p>
        ) : null}
      </div>
    );
  }

  const resignable =
    state?.status === 'playing' && humanColor !== null && !busy;

  const askResign = (): void => {
    if (!resignable) {
      return;
    }
    if (confirming) {
      setConfirming(false);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      onResign();
      return;
    }

    setConfirming(true);
    timerRef.current = setTimeout(() => {
      setConfirming(false);
      timerRef.current = null;
    }, CONFIRM_WINDOW_MS);
  };

  return (
    <div className="controls">
      <div className="control-group">
        <button
          type="button"
          className="btn"
          onClick={() => onStart('black')}
          disabled={busy}
        >
          <i className="btn-stone btn-stone--black" aria-hidden="true" />
          执黑开局
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onStart('white')}
          disabled={busy}
        >
          <i className="btn-stone btn-stone--white" aria-hidden="true" />
          执白开局
        </button>
      </div>

      <span className="controls-spacer" />

      <button
        type="button"
        className={`btn btn--danger ${confirming ? 'is-confirming' : ''}`}
        onClick={askResign}
        disabled={!resignable}
        aria-live="polite"
      >
        {confirming ? '再点一次确认' : '认输'}
      </button>
    </div>
  );
}
