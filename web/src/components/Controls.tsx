import { useEffect, useRef, useState } from 'react';
import type { GameState, StoneColor } from '@arena/shared';

interface ControlsProps {
  state: GameState | null;
  humanColor: StoneColor | null;
  /** Both seats are agents: this bar offers nothing to click. */
  spectator: boolean;
  busy: boolean;
  onStart: (humanColor: StoneColor) => void;
  onResign: () => void;
}

const CONFIRM_WINDOW_MS = 4_000;

export function Controls({
  state,
  humanColor,
  spectator,
  busy,
  onStart,
  onResign,
}: ControlsProps) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
