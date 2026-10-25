import { useEffect, useRef, useState } from 'react';
import type { AnyGameState, RoomPhase, StoneColor } from '@arena/shared';

type GameChoice = 'gomoku' | 'go';

interface ControlsProps {
  state: AnyGameState | null;
  humanColor: StoneColor | null;
  /** Both seats are agents: this bar offers nothing to click. */
  spectator: boolean;
  /** Room lifecycle: lobby/waiting swap the start buttons for a ready one. */
  phase: RoomPhase;
  yourReady: boolean;
  /** Client-side clock for the "opponent never came" hint, or null. */
  waitingSince: number | null;
  busy: boolean;
  onStart: (humanColor: StoneColor, game: GameChoice) => void;
  onReady: (ready: boolean) => void;
  /** Go only: forgo this move. */
  onPass: () => void;
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
  onPass,
  onResign,
}: ControlsProps) {
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [game, setGame] = useState<GameChoice>(state?.game ?? 'gomoku');
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
    // A started game decides what the toggle shows next: it follows whatever
    // actually began, so a game opened from elsewhere resets the picker.
    setGame(state?.game ?? 'gomoku');
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [state?.gameId, state?.game]);

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

  const gathering = phase === 'lobby' || phase === 'waiting';
  const playing = state?.status === 'playing';
  const goScoring = state?.game === 'go' && state.status === 'scoring';

  // Resigning keeps working through Go's scoring phase (the server allows
  // either side out of marking); a finished game cannot be resigned.
  const resignable =
    humanColor !== null && !busy && (playing || goScoring);

  // Go only: passing is a move, so it needs the turn; scoring has none.
  const goPlaying = state?.game === 'go' && playing;
  const passable = goPlaying && humanColor !== null && state.turn === humanColor;
  const passWarning =
    goPlaying &&
    state.consecutivePasses >= 1 &&
    state.lastMove !== null &&
    'kind' in state.lastMove
      ? state.lastMove.color === 'black'
        ? '黑方已停一手——再停一手双方就进入数子阶段'
        : '白方已停一手——再停一手双方就进入数子阶段'
      : null;

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
      {gathering ? (
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
            <span className="ready-note">双方都准备好后自动开局五子棋</span>
          ) : null}
        </div>
      ) : null}
      {gathering && waitingSince !== null && now - waitingSince >= READY_HINT_AFTER_MS ? (
        <p className="ready-hint" role="status">
          对方超过 60 秒还没准备——AI 可能还没接入，检查 MCP 配置
        </p>
      ) : null}

      <div className="control-group control-group--game" role="group" aria-label="选择游戏">
        <button
          type="button"
          className={`btn btn--toggle ${game === 'gomoku' ? 'is-active' : ''}`}
          aria-pressed={game === 'gomoku'}
          onClick={() => setGame('gomoku')}
          disabled={busy}
        >
          五子棋
        </button>
        <button
          type="button"
          className={`btn btn--toggle ${game === 'go' ? 'is-active' : ''}`}
          aria-pressed={game === 'go'}
          onClick={() => setGame('go')}
          disabled={busy}
        >
          围棋
        </button>
      </div>

      <div className="control-group">
        <button
          type="button"
          className="btn"
          onClick={() => onStart('black', game)}
          disabled={busy}
        >
          <i className="btn-stone btn-stone--black" aria-hidden="true" />
          执黑开局
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onStart('white', game)}
          disabled={busy}
        >
          <i className="btn-stone btn-stone--white" aria-hidden="true" />
          执白开局
        </button>
        {goPlaying ? (
          <button
            type="button"
            className="btn"
            onClick={onPass}
            disabled={!passable}
          >
            停一手（pass）
          </button>
        ) : null}
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

      {passWarning ? (
        <p className="ready-hint" role="status">
          {passWarning}
        </p>
      ) : null}
    </div>
  );
}
