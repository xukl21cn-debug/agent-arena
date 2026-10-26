import { useCallback, useEffect, useMemo } from 'react';
import {
  DEFAULT_ROOM_ID,
  ROOM_ID_PATTERN,
  opponentStatus,
  type RoomPhase,
  type StoneColor,
} from '@arena/shared';
import { Board } from './components/Board';
import { ChatRoomPage } from './components/chat/ChatRoomPage';
import { CommentaryPanel } from './components/CommentaryPanel';
import { Controls } from './components/Controls';
import { GoBoard } from './components/GoBoard';
import { LobbyPage } from './components/lobby/LobbyPage';
import { ReplayPage } from './components/replay/ReplayPage';
import { ResultOverlay } from './components/ResultOverlay';
import { ScoringPanel } from './components/ScoringPanel';
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

/**
 * Routing, most specific first: `?archive=` replays an archived game,
 * `?view=replay` the current one, `?kind=chat` opens the chat page — all
 * with the old default-room fallback. Bare `/` is the lobby; a URL that
 * carries `room` (valid or not — invalid still falls back to the default
 * room, as before) goes to the games, so every existing link keeps working.
 */
export default function App() {
  const params = useMemo(
    () => new URLSearchParams(window.location.search),
    [],
  );
  const roomId = useMemo(roomIdFromLocation, []);
  const archiveId = params.get('archive');
  const chatMode = params.get('kind') === 'chat';
  const replayMode = params.get('view') === 'replay';

  if (archiveId !== null) {
    return <ReplayPage key={archiveId} archiveId={archiveId} />;
  }
  if (replayMode) {
    return <ReplayPage key={`room-${roomId}`} roomId={roomId} />;
  }
  if (chatMode) {
    return <ChatRoomPage roomId={roomId} />;
  }
  if (!params.has('room')) {
    return <LobbyPage />;
  }
  return <GamePage roomId={roomId} />;
}

function GamePage({ roomId }: { roomId: string }) {
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
  const pass = useRoomStore((store) => store.pass);
  const markDead = useRoomStore((store) => store.markDead);
  const confirmScore = useRoomStore((store) => store.confirmScore);
  const resumePlay = useRoomStore((store) => store.resumePlay);
  const resign = useRoomStore((store) => store.resign);
  const dismissResult = useRoomStore((store) => store.dismissResult);
  const clearError = useRoomStore((store) => store.clearError);

  useEffect(() => connect(roomId), [connect, roomId]);

  const goState = state?.game === 'go' ? state : null;
  const gomokuState = state?.game === 'gomoku' ? state : null;
  const goScoringState = goState?.status === 'scoring' ? goState : null;

  const { human: humanColor, agent: agentColor, spectator } =
    seatColors(state);
  const gameId = state?.gameId ?? null;
  const goPlaying = goState?.status === 'playing';

  // Remount the game surfaces when a different game or a new game arrives, so
  // no cached board view survives a new_game that switched the game type.
  const viewKey = gameId !== null ? `${gameId}-${state?.game}` : 'empty';

  const canPlay =
    gomokuState?.status === 'playing' &&
    humanColor !== null &&
    gomokuState.turn === humanColor &&
    !busy;
  const goCanPlay =
    goPlaying &&
    humanColor !== null &&
    goState?.turn === humanColor &&
    !busy;

  // Whose side the commentary panel should track. In a dual-agent room there
  // is no fixed opponent: the live one is whoever is on turn. Scoring has no
  // turn, so nobody is tracked there.
  const onTurnSeat = state?.status === 'playing' ? state.turn : null;
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
      if (!canPlay && !goCanPlay) {
        return;
      }
      void play(row, col);
    },
    [canPlay, goCanPlay, play],
  );

  const handleToggleDead = useCallback(
    (row: number, col: number) => {
      if (goScoringState === null || spectator || busy) {
        return;
      }
      void markDead(row, col);
    },
    [goScoringState, spectator, busy, markDead],
  );

  const handleStart = useCallback(
    (humanSeat: StoneColor, game: 'gomoku' | 'go') => {
      void startGame(humanSeat, game);
    },
    [startGame],
  );

  const handleReady = useCallback(
    (ready: boolean) => {
      void setReady(ready);
    },
    [setReady],
  );

  const handlePass = useCallback(() => {
    if (!goPlaying) {
      return;
    }
    void pass();
  }, [goPlaying, pass]);

  const handleConfirmScore = useCallback(() => {
    if (goScoringState === null || spectator) {
      return;
    }
    void confirmScore();
  }, [goScoringState, spectator, confirmScore]);

  const handleResumePlay = useCallback(() => {
    if (goScoringState === null || spectator) {
      return;
    }
    void resumePlay();
  }, [goScoringState, spectator, resumePlay]);

  const handleResign = useCallback(() => {
    void resign();
  }, [resign]);

  const rematch = useCallback(() => {
    void startGame(humanColor ?? 'black', state?.game ?? 'gomoku');
  }, [humanColor, state?.game, startGame]);

  const overlay =
    state &&
    state.status === 'finished' &&
    !resultDismissed ? (
      <ResultOverlay
        state={state}
        humanColor={humanColor}
        spectator={spectator}
        busy={busy}
        onRematch={spectator ? undefined : rematch}
        onDismiss={dismissResult}
      />
    ) : null;

  const isGo = goState !== null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <p className="eyebrow">Agent Arena · MCP</p>
          <h1 className="title">{isGo ? '围棋' : '五子棋'}</h1>
          <p className="subtitle">
            {spectator
              ? '两个 AI 在对弈，你在旁边观战。'
              : isGo
                ? '9 路围棋：你在网页落子，AI 通过 MCP 应招。'
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

          {isGo ? (
            <div key={viewKey}>
              <GoBoard
                state={goState}
                humanColor={humanColor}
                busy={busy}
                overlay={overlay}
                onPlay={handlePlay}
                onToggleDead={handleToggleDead}
              />

              {goScoringState ? (
                <ScoringPanel
                  state={goScoringState}
                  humanColor={humanColor}
                  spectator={spectator}
                  busy={busy}
                  onConfirm={handleConfirmScore}
                  onResume={handleResumePlay}
                />
              ) : null}

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
                onPass={handlePass}
                onResign={handleResign}
              />
            </div>
          ) : (
            <div key={viewKey}>
              <Board
                state={gomokuState}
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
                onPass={handlePass}
                onResign={handleResign}
              />
            </div>
          )}

          <p className="rule-note">
            {isGo
              ? `9 × 9 · 黑先 · 贴 ${goState?.rules.komi ?? 7.5} 目（白） · 中国规则数子`
              : '15 × 15 · 黑先 · 无禁手 · 五连获胜'}
          </p>
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
