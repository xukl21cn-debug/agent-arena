import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_ROOM_ID,
  MAX_COMMENTARY_LOG,
  ROOM_ID_PATTERN,
  type GameState,
  type PlayerSpec,
  type StoneColor,
} from '@gomoku/shared';
import { ApiError, api, errorMessage } from './api';
import { Board } from './components/Board';
import { CommentaryPanel } from './components/CommentaryPanel';
import { Controls } from './components/Controls';
import { ResultOverlay } from './components/ResultOverlay';
import { StatusBar } from './components/StatusBar';
import { useRoomSocket, type ConnectionStatus } from './useRoomSocket';

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connecting: '连接中',
  online: '已连接',
  reconnecting: '重连中',
  offline: '已断开',
};

function roomIdFromLocation(): string {
  const candidate = new URLSearchParams(window.location.search).get('room');
  return candidate && ROOM_ID_PATTERN.test(candidate)
    ? candidate
    : DEFAULT_ROOM_ID;
}

function seatFor(
  state: GameState | null,
  kind: PlayerSpec['kind'],
): StoneColor | null {
  if (!state) {
    return null;
  }
  if (state.seats.black.kind === kind) {
    return 'black';
  }
  if (state.seats.white.kind === kind) {
    return 'white';
  }
  return null;
}

/** REST responses can be newer than the last WS frame; keep the latest one. */
function pickLatest(
  fromSocket: GameState | null,
  fromRest: GameState | null,
): GameState | null {
  if (!fromSocket) {
    return fromRest;
  }
  if (!fromRest) {
    return fromSocket;
  }
  return fromRest.version >= fromSocket.version ? fromRest : fromSocket;
}

export default function App() {
  const roomId = useMemo(roomIdFromLocation, []);
  const {
    state: socketState,
    commentary,
    participants,
    status: connection,
  } = useRoomSocket(roomId);

  const [restState, setRestState] = useState<GameState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultDismissed, setResultDismissed] = useState(false);

  const state = pickLatest(socketState, restState);
  const humanColor = seatFor(state, 'human');
  const agentColor = seatFor(state, 'agent');
  const gameId = state?.gameId ?? null;

  useEffect(() => {
    setResultDismissed(false);
  }, [gameId]);

  const canPlay =
    state?.status === 'playing' &&
    humanColor !== null &&
    state.turn === humanColor &&
    !busy;
  const thinking =
    state?.status === 'playing' && state.turn === agentColor;

  const visibleCommentary = useMemo(
    () =>
      commentary
        .filter((item) => item.gameId === gameId)
        .slice(-MAX_COMMENTARY_LOG),
    [commentary, gameId],
  );

  const applyError = useCallback((caught: unknown) => {
    if (caught instanceof ApiError && caught.state) {
      setRestState(caught.state);
    }
    setError(errorMessage(caught));
  }, []);

  const startGame = useCallback(
    async (humanSeat: StoneColor) => {
      setBusy(true);
      setError(null);
      try {
        const agentSeat: StoneColor =
          humanSeat === 'black' ? 'white' : 'black';
        setRestState(await api.newGame(roomId, agentSeat));
      } catch (caught) {
        applyError(caught);
      } finally {
        setBusy(false);
      }
    },
    [applyError, roomId],
  );

  const play = useCallback(
    async (row: number, col: number) => {
      if (!canPlay) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        setRestState(await api.move(roomId, row, col));
      } catch (caught) {
        applyError(caught);
      } finally {
        setBusy(false);
      }
    },
    [applyError, canPlay, roomId],
  );

  const resign = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setRestState(await api.resign(roomId));
    } catch (caught) {
      applyError(caught);
    } finally {
      setBusy(false);
    }
  }, [applyError, roomId]);

  const rematch = useCallback(() => {
    void startGame(humanColor ?? 'black');
  }, [humanColor, startGame]);

  const overlay =
    state && state.status === 'finished' && !resultDismissed ? (
      <ResultOverlay
        state={state}
        humanColor={humanColor}
        busy={busy}
        onRematch={rematch}
        onDismiss={() => setResultDismissed(true)}
      />
    ) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <p className="eyebrow">Gomoku · MCP</p>
          <h1 className="title">五子棋</h1>
          <p className="subtitle">你在网页落子，AI 通过 MCP 应招。</p>
        </div>

        <div className="topbar-meta">
          <span className="room-chip" title="房间号">
            room / {roomId}
          </span>
          <span className={`connection connection--${connection}`}>
            <i className="connection-dot" aria-hidden="true" />
            {CONNECTION_LABELS[connection]}
          </span>
        </div>
      </header>

      {error ? (
        <div className="error-bar" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="error-dismiss"
            onClick={() => setError(null)}
          >
            知道了
          </button>
        </div>
      ) : null}

      <main className="arena">
        <div className="board-column">
          <StatusBar
            state={state}
            humanColor={humanColor}
            agentColor={agentColor}
            participants={participants}
          />

          <Board
            state={state}
            humanColor={humanColor}
            busy={busy}
            overlay={overlay}
            onPlay={play}
          />

          <Controls
            state={state}
            humanColor={humanColor}
            busy={busy}
            onStart={startGame}
            onResign={resign}
          />

          <p className="rule-note">15 × 15 · 黑先 · 无禁手 · 五连获胜</p>
        </div>

        <CommentaryPanel
          commentary={visibleCommentary}
          thinking={thinking}
          agentColor={agentColor}
        />
      </main>
    </div>
  );
}
