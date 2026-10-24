import { useCallback, useEffect, useMemo } from 'react';
import {
  DEFAULT_ROOM_ID,
  ROOM_ID_PATTERN,
  opponentStatus,
  type StoneColor,
} from '@gomoku/shared';
import { Board } from './components/Board';
import { CommentaryPanel } from './components/CommentaryPanel';
import { Controls } from './components/Controls';
import { ResultOverlay } from './components/ResultOverlay';
import { StatusBar } from './components/StatusBar';
import {
  seatColors,
  useRoomStore,
  visibleCommentary,
  type ConnectionStatus,
} from './store/room';

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

export default function App() {
  const roomId = useMemo(roomIdFromLocation, []);
  const connect = useRoomStore((store) => store.connect);
  const connection = useRoomStore((store) => store.connection);
  const state = useRoomStore((store) => store.state);
  const participants = useRoomStore((store) => store.participants);
  const commentary = useRoomStore((store) => store.commentary);
  const busy = useRoomStore((store) => store.busy);
  const error = useRoomStore((store) => store.error);
  const resultDismissed = useRoomStore((store) => store.resultDismissed);

  const startGame = useRoomStore((store) => store.startGame);
  const play = useRoomStore((store) => store.play);
  const resign = useRoomStore((store) => store.resign);
  const dismissResult = useRoomStore((store) => store.dismissResult);
  const clearError = useRoomStore((store) => store.clearError);

  useEffect(() => connect(roomId), [connect, roomId]);

  const { human: humanColor, agent: agentColor } = seatColors(state);
  const gameId = state?.gameId ?? null;

  const canPlay =
    state?.status === 'playing' &&
    humanColor !== null &&
    state.turn === humanColor &&
    !busy;

  const opponent = participants.find((item) => item.seat === agentColor) ?? null;
  // "It is the AI's turn" is not the same as "the AI can move": an agent that
  // never connected must not read as thinking, or the player waits for nobody.
  const opponentState = opponentStatus(opponent, {
    playing: state?.status === 'playing',
    isOpponentTurn:
      state?.status === 'playing' && state.turn === agentColor,
  });

  const visible = useMemo(
    () => visibleCommentary(commentary, gameId),
    [commentary, gameId],
  );

  const handlePlay = useCallback(
    (row: number, col: number) => {
      if (!canPlay) {
        return;
      }
      void play(row, col);
    },
    [canPlay, play],
  );

  const handleStart = useCallback(
    (humanSeat: StoneColor) => {
      void startGame(humanSeat);
    },
    [startGame],
  );

  const handleResign = useCallback(() => {
    void resign();
  }, [resign]);

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
        onDismiss={dismissResult}
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
          <button type="button" className="error-dismiss" onClick={clearError}>
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
            onPlay={handlePlay}
          />

          <Controls
            state={state}
            humanColor={humanColor}
            busy={busy}
            onStart={handleStart}
            onResign={handleResign}
          />

          <p className="rule-note">15 × 15 · 黑先 · 无禁手 · 五连获胜</p>
        </div>

        <CommentaryPanel
          commentary={visible}
          opponentState={opponentState}
          agentColor={agentColor}
        />
      </main>
    </div>
  );
}
