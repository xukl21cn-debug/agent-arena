import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArchiveSummary, RoomSummary } from '@arena/shared';
import { api, errorMessage, type ChatRoomSummaryDto } from '../../api';
import { endLabel, timeAgo } from '../../labels';

/** The lobby is a directory, not a dashboard: a slow heartbeat is enough. */
const POLL_MS = 8_000;
/** History can hold room-count × N entries; render the newest, offer the rest. */
const HISTORY_LIMIT = 20;

const GAME_PHASE_LABELS: Record<RoomSummary['phase'], string> = {
  lobby: '等待加入',
  waiting: '准备中',
  playing: '对局中',
  paused: '已暂停',
  finished: '已结束',
};

const CHAT_PHASE_LABELS: Record<ChatRoomSummaryDto['phase'], string> = {
  open: '进行中',
  paused: '已暂停',
  closed: '已结束',
};

/** Phase tone for the pill: active green, pending gold, over dim. */
function phaseTone(phase: string): string {
  if (phase === 'playing' || phase === 'open') {
    return 'active';
  }
  if (phase === 'waiting' || phase === 'paused') {
    return 'warn';
  }
  return 'done';
}

/**
 * The two list endpoints name their room differently (`roomId` vs `id`).
 * Normalization happens here, once, so no card component ever sees the
 * difference.
 */
function gameCard(summary: RoomSummary): {
  id: string;
  href: string;
  typeLabel: string;
  phaseLabel: string;
  tone: string;
  title: string;
  meta: string;
  people: string;
  updatedAt: string;
} {
  return {
    id: summary.roomId,
    href: `/?room=${encodeURIComponent(summary.roomId)}`,
    typeLabel: summary.game === 'go' ? '围棋' : '五子棋',
    phaseLabel: GAME_PHASE_LABELS[summary.phase],
    tone: phaseTone(summary.phase),
    title: summary.roomId,
    meta: `${summary.moveCount} 手`,
    people: (summary.participants ?? [])
      .map((participant) => participant.label)
      .join(' · '),
    updatedAt: summary.updatedAt,
  };
}

function chatCard(summary: ChatRoomSummaryDto) {
  // No presence here on purpose: chat rooms have none, and displaying any
  // would be invention (AGENTS §4.2). People are a count, activity is a time.
  return {
    id: summary.id,
    href: `/?room=${encodeURIComponent(summary.id)}&kind=chat`,
    typeLabel: '聊天',
    phaseLabel: CHAT_PHASE_LABELS[summary.phase],
    tone: phaseTone(summary.phase),
    title: summary.title || summary.id,
    meta: `${summary.messageCount} 条 · hop ${summary.hop}/${summary.maxHops}`,
    people: `${summary.memberCount} 人 · ${summary.agentCount} agent`,
    updatedAt: summary.updatedAt,
  };
}

interface CardProps {
  /** The list key (the normalized room id); not rendered. */
  id: string;
  href: string;
  typeLabel: string;
  phaseLabel: string;
  tone: string;
  title: string;
  meta: string;
  people: string;
  updatedAt: string;
}

function Card({
  href,
  typeLabel,
  phaseLabel,
  tone,
  title,
  meta,
  people,
  updatedAt,
}: CardProps) {
  return (
    <a className="lobby-card" href={href}>
      <div className="card-head">
        <span className="card-type">{typeLabel}</span>
        <span className={`card-phase card-phase--${tone}`}>{phaseLabel}</span>
      </div>
      <p className="card-title">{title}</p>
      <div className="card-meta">
        <span>{meta}</span>
        {people !== '' ? <span>{people}</span> : null}
        <time>{timeAgo(updatedAt)}</time>
      </div>
    </a>
  );
}

interface GroupProps {
  title: string;
  note: string;
  emptyHint: string;
  cards: CardProps[];
  loading?: boolean;
  error?: string | null;
}

function Group({
  title,
  note,
  emptyHint,
  cards,
  loading = false,
  error = null,
}: GroupProps) {
  const isInitialLoading = loading && cards.length === 0;
  const isFailed = error !== null && cards.length === 0;

  return (
    <section className="lobby-group">
      <div className="group-head">
        <h2 className="group-title">{title}</h2>
        <span className="group-note">
          {isInitialLoading
            ? '读取中…'
            : isFailed
              ? '加载失败'
              : note}
        </span>
      </div>
      {isFailed ? (
        <p className="lobby-empty">{error}</p>
      ) : isInitialLoading ? (
        <p className="lobby-empty">读取中…</p>
      ) : cards.length === 0 ? (
        <p className="lobby-empty">{emptyHint}</p>
      ) : (
        <div className="lobby-grid">
          {cards.map((card) => (
            <Card key={card.id} {...card} />
          ))}
        </div>
      )}
    </section>
  );
}

export function LobbyPage() {
  const [games, setGames] = useState<RoomSummary[] | null>(null);
  const [gamesLoading, setGamesLoading] = useState(true);
  const [gamesError, setGamesError] = useState<string | null>(null);

  const [chats, setChats] = useState<ChatRoomSummaryDto[] | null>(null);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [chatsError, setChatsError] = useState<string | null>(null);

  const [archives, setArchives] = useState<ArchiveSummary[] | null>(null);
  const [archivesLoading, setArchivesLoading] = useState(true);
  const [archivesError, setArchivesError] = useState<string | null>(null);

  const [showAllHistory, setShowAllHistory] = useState(false);
  const mountedRef = useRef(true);
  const seqRef = useRef({ rooms: 0, chats: 0, archives: 0 });

  const loadRooms = useCallback(async (): Promise<void> => {
    const seq = ++seqRef.current.rooms;
    setGamesLoading(true);
    try {
      const roomList = await api.listRooms();
      if (!mountedRef.current || seq !== seqRef.current.rooms) {
        return;
      }
      setGames(roomList);
      setGamesError(null);
    } catch (caught) {
      if (!mountedRef.current || seq !== seqRef.current.rooms) {
        return;
      }
      setGamesError(errorMessage(caught));
    } finally {
      if (mountedRef.current && seq === seqRef.current.rooms) {
        setGamesLoading(false);
      }
    }
  }, []);

  const loadChats = useCallback(async (): Promise<void> => {
    const seq = ++seqRef.current.chats;
    setChatsLoading(true);
    try {
      const chatList = await api.listChatRooms();
      if (!mountedRef.current || seq !== seqRef.current.chats) {
        return;
      }
      setChats(chatList);
      setChatsError(null);
    } catch (caught) {
      if (!mountedRef.current || seq !== seqRef.current.chats) {
        return;
      }
      setChatsError(errorMessage(caught));
    } finally {
      if (mountedRef.current && seq === seqRef.current.chats) {
        setChatsLoading(false);
      }
    }
  }, []);

  const loadArchives = useCallback(async (): Promise<void> => {
    const seq = ++seqRef.current.archives;
    setArchivesLoading(true);
    try {
      const archiveList = await api.listArchives();
      if (!mountedRef.current || seq !== seqRef.current.archives) {
        return;
      }
      if (archiveList === null) {
        setArchivesError('无法读取历史对局。');
      } else {
        setArchives(archiveList);
        setArchivesError(null);
      }
    } catch (caught) {
      if (!mountedRef.current || seq !== seqRef.current.archives) {
        return;
      }
      setArchivesError(errorMessage(caught));
    } finally {
      if (mountedRef.current && seq === seqRef.current.archives) {
        setArchivesLoading(false);
      }
    }
  }, []);

  const load = useCallback((): void => {
    void loadRooms();
    void loadChats();
    void loadArchives();
  }, [loadRooms, loadChats, loadArchives]);

  useEffect(() => {
    mountedRef.current = true;
    load();
    const timer = setInterval(() => load(), POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [load]);

  const byRecent = (list: RoomSummary[], game: 'gomoku' | 'go') =>
    list
      .filter((room) => room.game === game)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(gameCard);

  const gomoku = games !== null ? byRecent(games, 'gomoku') : [];
  const go = games !== null ? byRecent(games, 'go') : [];
  const chatCards =
    chats !== null
      ? [...chats]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map(chatCard)
      : [];

  // The server already ordered the archive list by playedAt desc; slicing
  // keeps that order, nothing re-sorts it.
  const history = archives ?? [];
  const visibleHistory = showAllHistory
    ? history
    : history.slice(0, HISTORY_LIMIT);
  const hiddenHistory = history.length - visibleHistory.length;

  const activeErrors = [
    gamesError ? `棋类房间：${gamesError}` : null,
    chatsError ? `聊天房间：${chatsError}` : null,
    archivesError ? `历史对局：${archivesError}` : null,
  ].filter(Boolean) as string[];
  const topError = activeErrors.length > 0 ? activeErrors.join('；') : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <p className="eyebrow">Agent Arena · MCP</p>
          <h1 className="title">大厅</h1>
          <p className="subtitle">三类房间与历史对局，点卡片进入。</p>
        </div>
        <div className="topbar-meta">
          <span className="room-chip">每 {POLL_MS / 1000} 秒自动刷新</span>
        </div>
      </header>

      {topError !== null ? (
        <div className="error-bar" role="alert">
          <span>{topError}</span>
          <button
            type="button"
            className="error-dismiss"
            onClick={() => load()}
          >
            重试
          </button>
        </div>
      ) : null}

      <main className="lobby">
        <Group
          title="五子棋"
          note={`${gomoku.length} 间`}
          emptyHint="暂无房间。打开 ?room=<房间名> 即可开一间。"
          cards={gomoku}
          loading={gamesLoading}
          error={gamesError}
        />
        <Group
          title="围棋"
          note={`${go.length} 间`}
          emptyHint="暂无房间。在棋类页面选围棋开局后会出现。"
          cards={go}
          loading={gamesLoading}
          error={gamesError}
        />
        <Group
          title="聊天"
          note={`${chatCards.length} 间`}
          emptyHint="暂无房间。POST /api/chat/rooms 或 MCP 建房。"
          cards={chatCards}
          loading={chatsLoading}
          error={chatsError}
        />

        <section className="lobby-group lobby-history">
          <div className="group-head">
            <h2 className="group-title">历史对局</h2>
            <span className="group-note">
              {archivesLoading && archives === null
                ? '读取中…'
                : archivesError !== null && archives === null
                  ? '加载失败'
                  : `${history.length} 局`}
            </span>
          </div>
          {archivesError !== null && archives === null ? (
            <p className="lobby-empty">{archivesError}</p>
          ) : archivesLoading && archives === null ? (
            <p className="lobby-empty">读取中…</p>
          ) : history.length === 0 ? (
            <p className="lobby-empty">
              暂无历史对局。一局下完再开新局，旧局会来到这里。
            </p>
          ) : (
            <>
              <div className="lobby-grid">
                {visibleHistory.map((entry) => {
                  const result = endLabel(
                    entry.game,
                    entry.winner,
                    entry.endReason,
                  );
                  return (
                    <a
                      key={entry.archiveId}
                      className="lobby-card lobby-card--history"
                      href={`/?archive=${encodeURIComponent(entry.archiveId)}`}
                    >
                      <div className="card-head">
                        <span className="card-type">
                          {entry.game === 'go' ? '围棋' : '五子棋'}
                        </span>
                        <span
                          className={
                            result === null
                              ? 'card-phase card-phase--done'
                              : 'card-result'
                          }
                        >
                          {result ?? '未终局'}
                        </span>
                      </div>
                      <p className="card-title">{entry.roomId}</p>
                      <div className="card-meta">
                        <span>{entry.moveCount} 手</span>
                        <time>{timeAgo(entry.playedAt)}</time>
                      </div>
                    </a>
                  );
                })}
              </div>
              {hiddenHistory > 0 ? (
                <button
                  type="button"
                  className="btn btn--ghost lobby-more"
                  onClick={() => setShowAllHistory(true)}
                >
                  查看更多（还有 {hiddenHistory} 局）
                </button>
              ) : null}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
