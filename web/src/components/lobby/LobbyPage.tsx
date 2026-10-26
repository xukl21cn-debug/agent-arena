import { useCallback, useEffect, useState } from 'react';
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
}

function Group({ title, note, emptyHint, cards }: GroupProps) {
  return (
    <section className="lobby-group">
      <div className="group-head">
        <h2 className="group-title">{title}</h2>
        <span className="group-note">{note}</span>
      </div>
      {cards.length === 0 ? (
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
  const [chats, setChats] = useState<ChatRoomSummaryDto[] | null>(null);
  const [archives, setArchives] = useState<ArchiveSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [roomList, chatList] = await Promise.all([
        api.listRooms(),
        api.listChatRooms(),
      ]);
      setGames(roomList);
      setChats(chatList);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
    // Absent or failing archive surface degrades to null: the rest of the
    // lobby stays standing.
    setArchives(await api.listArchives());
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
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

  const loading = games === null || chats === null;

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

      {error !== null ? (
        <div className="error-bar" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="error-dismiss"
            onClick={() => void load()}
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
        />
        <Group
          title="围棋"
          note={`${go.length} 间`}
          emptyHint="暂无房间。在棋类页面选围棋开局后会出现。"
          cards={go}
        />
        <Group
          title="聊天"
          note={`${chatCards.length} 间`}
          emptyHint="暂无房间。POST /api/chat/rooms 或 MCP 建房。"
          cards={chatCards}
        />

        <section className="lobby-group lobby-history">
          <div className="group-head">
            <h2 className="group-title">历史对局</h2>
            <span className="group-note">
              {loading ? '读取中…' : `${history.length} 局`}
            </span>
          </div>
          {history.length === 0 ? (
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
