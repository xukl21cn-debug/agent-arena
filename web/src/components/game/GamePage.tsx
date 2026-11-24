import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  DEFAULT_ROOM_ID,
  ROOM_ID_PATTERN,
  opponentStatus,
  type StoneColor,
} from '@arena/shared';
import { Board } from '../Board';
import { CommentaryPanel } from '../CommentaryPanel';
import { Controls } from '../Controls';
import { GoBoard } from '../GoBoard';
import { ResultOverlay } from '../ResultOverlay';
import { ScoringPanel } from '../ScoringPanel';
import { StatusBar } from '../StatusBar';
import {
  seatColors,
  useRoomStore,
  visibleCommentary,
  type ConnectionStatus,
} from '../../store/room';
import { usePageTitle } from '../layout/PageTitle';
import { BackLink } from '../layout/BackLink';
import { RoomChip } from '../layout/RoomChip';
import { api, errorMessage } from '../../api';

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connecting: '连接中',
  online: '已连接',
  reconnecting: '重连中',
  offline: '已断开',
};

export function GamePage() {
  usePageTitle('棋局对弈');
  const params = useParams();
  const roomId =
    params.roomId !== undefined && ROOM_ID_PATTERN.test(params.roomId)
      ? params.roomId
      : DEFAULT_ROOM_ID;

  const connect = useRoomStore((store) => store.connect);
  const connection = useRoomStore((store) => store.connection);
  const state = useRoomStore((store) => store.state);
  const participants = useRoomStore((store) => store.participants);
  const commentary = useRoomStore((store) => store.commentary);
  const busy = useRoomStore((store) => store.busy);
  const error = useRoomStore((store) => store.error);
  const errorCode = useRoomStore((store) => store.errorCode);
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

  // Layout effect, not effect: connect() resets the store, and waiting for the
  // paint would show one frame of the previous room's board after a route
  // change. Running before paint keeps room switches clean.
  useLayoutEffect(() => connect(roomId), [connect, roomId]);

  const navigate = useNavigate();
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Same 4s window as the other two-step buttons: arming expires on its own.
  useEffect(() => {
    if (!deleteArmed) {
      return;
    }
    const timer = setTimeout(() => setDeleteArmed(false), 4_000);
    return () => clearTimeout(timer);
  }, [deleteArmed]);

  // The server owns the rule (waiting/playing answer ROOM_BUSY); the page only
  // mirrors it so the button explains itself before it is pressed.
  const deletable = phase === 'lobby' || phase === 'finished';
  const removeRoom = async (): Promise<void> => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteRoom(roomId);
      navigate('/games');
    } catch (caught) {
      setDeleteError(errorMessage(caught));
      setDeleting(false);
      setDeleteArmed(false);
    }
  };

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
    isOpponentTurn: state?.status === 'playing' && state.turn === trackedSeat,
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

  // A 1008 close or REST 404 saying ROOM_NOT_FOUND is not a transient network
  // failure: the room is gone, so show an empty state instead of a playable
  // board with a delete button for a room that does not exist.
  if (state === null && errorCode === 'ROOM_NOT_FOUND') {
    return (
      <>
        <div className="page-head">
          <div>
            <BackLink to="/games" label="棋局大厅" />
            <h2 className="page-title">棋局对弈</h2>
            <p className="page-subtitle">房间不存在或已删除。</p>
          </div>
        </div>
        <section className="game-not-found panel" role="status">
          <strong>房间不存在或已删除</strong>
          <p>请检查房间号，或返回棋局大厅重新选择一间房。</p>
          <Link className="btn btn--primary" to="/games">
            返回棋局大厅
          </Link>
        </section>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <BackLink to="/games" label="棋局大厅" />
          <h2 className="page-title">{isGo ? '围棋' : '五子棋'}</h2>
          <p className="page-subtitle">
            {spectator
              ? '两个 AI 在对弈，你在旁边观战。'
              : isGo
                ? '9 路围棋：你在网页落子，AI 通过 MCP 应招。'
                : '你在网页落子，AI 通过 MCP 应招。'}
          </p>
        </div>
        <div className="page-head-meta">
          <RoomChip roomId={roomId} />
          <span className={`connection connection--${connection}`}>
            <i className="connection-dot" aria-hidden="true" />
            {CONNECTION_LABELS[connection]}
          </span>
          <button
            type="button"
            className={`btn btn--danger ${deleteArmed ? 'is-confirming' : ''}`}
            disabled={deleting || !deletable}
            title={
              deletable
                ? '删除这间房；已结束的对局仍可在历史里回放'
                : '对局进行中，先结束或认输再删'
            }
            onClick={() => {
              if (deleteArmed) {
                void removeRoom();
              } else {
                setDeleteArmed(true);
              }
            }}
          >
            {deleting ? '删除中…' : deleteArmed ? '再点一次删除' : '删除房间'}
          </button>
        </div>
      </div>

      {deleteError !== null || error ? (
        <div className="error-bar" role="alert">
          <span>{deleteError ?? error}</span>
          <button
            type="button"
            className="error-dismiss"
            onClick={() => {
              setDeleteError(null);
              clearError();
            }}
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
                spectator={spectator}
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
    </>
  );
}
