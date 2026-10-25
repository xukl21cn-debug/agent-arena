import { useCallback, useEffect, useMemo } from 'react';
import {
  DEFAULT_ROOM_ID,
  ROOM_ID_PATTERN,
  opponentStatus,
  type RoomPhase,
  type StoneColor,
} from '@arena/shared';
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
  const phase = useRoomStore((store) => store.phase);
  const waitingSince = useRoomStore((store) => store.waitingSince);
  const resultDismissed = useRoomStore((store) => store.resultDismissed);

  const startGame = useRoomStore((store) => store.startGame);
  const setReady = useRoomStore((store) => store.setReady);
  const play = useRoomStore((store) => store.play);
  const resign = useRoomStore((store) => store.resign);
  const dismissResult = useRoomStore((store) => store.dismissResult);
  const clearError = useRoomStore((store) => store.clearError);

  useEffect(() => connect(roomId), [connect, roomId]);

  const { human: humanColor, agent: agentColor, spectator } = seatColors(state);
  const gameId = state?.gameId ?? null;

  const canPlay =
    state?.status === 'playing' &&
    humanColor !== null &&
    state.turn === humanColor &&
    !busy;

  // Whose side the commentary panel should track. In a dual-agent room there
  // is no fixed opponent: the live one is whoever is on turn.
  const onTurnSeat =
    state !== null && state.status === 'playing' ? state.turn : null;
  const trackedSeat = spectator ? onTurnSeat : agentColor;
  const opponent =
    participants.find((item) => item.seat === trackedSeat) ?? null;
  // The human side's ready flag, for the seat check and the button label.
  const yourReady =
    participants.find((item) => item.seat === humanColor)?.ready ?? false;
  // "It is the AI's turn" is not the same as "the AI can move": an agent that
  // never connected must not read as thinking, or the player waits for nobody.
  const opponentState = opponentStatus(opponent, {
    playing: state?.status === 'playing',
    isOpponentTurn: trackedSeat !== null && state?.status === 'playing',
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

  const handleReady = useCallback(
    (ready: boolean) => {
      void setReady(ready);
    },
    [setReady],
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
        spectator={spectator}
        busy={busy}
        onRematch={spectator ? undefined : rematch}
        onDismiss={dismissResult}
      />
    ) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <p className="eyebrow">Agent Arena · MCP</p>
          <h1 className="title">五子棋</h1>
          <p className="subtitle">
            {spectator
              ? '两个 AI 在对弈，你在旁边观战。'
              : '你在网页落子，AI 通过 MCP 应招。'}
          </p>
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
            spectator={spectator}
            phase={phase}
            yourReady={yourReady}
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
            spectator={spectator}
            phase={phase}
            yourReady={yourReady}
            waitingSince={waitingSince}
            busy={busy}
            onStart={handleStart}
            onReady={handleReady}
            onResign={handleResign}
          />

          <p className="rule-note">15 × 15 · 黑先 · 无禁手 · 五连获胜</p>
        </div>

        <CommentaryPanel
          commentary={visible}
          opponentState={opponentState}
          agentColor={agentColor}
          spectator={spectator}
        />
      </main>
    </div>
  );
}
