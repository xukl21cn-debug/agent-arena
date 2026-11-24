import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { ArchiveSummary, RoomSummary } from '@arena/shared';
import { api, errorMessage, type ChatRoomSummaryDto } from '../../api';
import { endLabel, timeAgo } from '../../labels';
import { usePageTitle } from '../layout/PageTitle';

/** The lobby is a directory, not a dashboard: a slow heartbeat is enough. */
const POLL_MS = 8_000;
/** One page of cards; history can be much larger than a room list. */
const PAGE_SIZE = 12;

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

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'pending', label: '待开始' },
  { key: 'paused', label: '已暂停' },
  { key: 'done', label: '已结束' },
] as const;

type FilterKey = (typeof FILTERS)[number]['key'];

/** Phase tone for the pill: active green, waiting/paused dim, over faint. */
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
 * Which filter a room belongs to. Deliberately not the same function as
 * `phaseTone`: a room in the `lobby` phase is grey on its pill but has not
 * started yet, so it belongs under 待开始; a paused room is neither pending nor
 * over, so it gets its own bucket.
 */
function phaseBucket(phase: string): FilterKey {
  if (phase === 'playing' || phase === 'open') {
    return 'active';
  }
  if (phase === 'waiting' || phase === 'lobby') {
    return 'pending';
  }
  if (phase === 'paused') {
    return 'paused';
  }
  return 'done';
}

/**
 * Page and filter survive leaving the lobby and coming back, so the browser's
 * back button lands on the page the user left. Keyed by list rather than by
 * route because `/` shows several lists at once.
 */
const listMemory = new Map<string, { filter: FilterKey; page: number }>();

/**
 * Page, filter and sub-tab are remembered per history entry, not per list.
 * A single map keyed by the list would make every earlier lobby entry show the
 * position of the newest one; the router's `location.key` is unique per entry
 * and comes back when the user goes back to it.
 */
function entryKey(locationKey: string, listKey: string): string {
  return `${locationKey}:${listKey}`;
}

/** The entry the last render belonged to, for the replace carry-over below. */
let previousEntry: { key: string; pathname: string } | null = null;

/**
 * Clicking the tab you are already on is a REPLACE: the browser keeps the same
 * history position but the router hands out a new key, which would orphan the
 * remembered tab/filter/page. Carry them over. A REPLACE that lands on another
 * route starts fresh, and a PUSH or POP always keeps its own memory.
 */
export function noteLobbyEntry(
  key: string,
  pathname: string,
  navigationType: string,
): void {
  const sameRoute = previousEntry !== null && previousEntry.pathname === pathname;
  if (navigationType === 'REPLACE' && sameRoute && previousEntry !== null && previousEntry.key !== key) {
    const from = previousEntry.key;
    for (const [memoryKey, value] of [...listMemory]) {
      if (memoryKey.startsWith(`${from}:`)) {
        listMemory.set(`${key}${memoryKey.slice(from.length)}`, value);
      }
    }
    const tab = gameTabMemory.get(from);
    if (tab !== undefined) {
      gameTabMemory.set(key, tab);
    }
  }
  previousEntry = { key, pathname };
}

/**
 * The two list endpoints name their room differently (`roomId` vs `id`).
 * Normalization happens here, once, so no card component ever sees the
 * difference.
 */
function gameCard(summary: RoomSummary): {
  id: string;
  to: string;
  typeLabel: string;
  phaseLabel: string;
  tone: string;
  bucket: FilterKey;
  title: string;
  meta: string;
  people: string;
  updatedAt: string;
} {
  return {
    id: summary.roomId,
    to: `/games/${encodeURIComponent(summary.roomId)}`,
    typeLabel: summary.game === 'go' ? '围棋' : '五子棋',
    phaseLabel: GAME_PHASE_LABELS[summary.phase],
    tone: phaseTone(summary.phase),
    bucket: phaseBucket(summary.phase),
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
    to: `/chats/${encodeURIComponent(summary.id)}`,
    typeLabel: '聊天',
    phaseLabel: CHAT_PHASE_LABELS[summary.phase],
    tone: phaseTone(summary.phase),
    bucket: phaseBucket(summary.phase),
    title: summary.title || summary.id,
    // The name is a label; the id is the address. Show both when they differ,
    // or the lobby hides the one string you need to hand to an agent.
    meta: `${summary.title !== summary.id ? `${summary.id} · ` : ''}${summary.messageCount} 条 · hop ${summary.hop}/${summary.maxHops}`,
    people: `${summary.memberCount} 人 · ${summary.agentCount} agent`,
    updatedAt: summary.updatedAt,
  };
}

interface CardProps {
  /** The list key (the normalized room id); not rendered. */
  id: string;
  to: string;
  typeLabel: string;
  phaseLabel: string;
  tone: string;
  /** Which status filter this card answers to. */
  bucket: FilterKey;
  title: string;
  meta: string;
  people: string;
  updatedAt: string;
}

function Card({
  to,
  typeLabel,
  phaseLabel,
  tone,
  title,
  meta,
  people,
  updatedAt,
}: CardProps) {
  return (
    <Link className="lobby-card" to={to}>
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
    </Link>
  );
}

function Pager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) {
    return null;
  }
  return (
    <nav className="pager" aria-label="分页">
      <button
        type="button"
        className="btn btn--ghost pager-step"
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
      >
        上一页
      </button>
      {Array.from({ length: pageCount }, (_, index) => (
        <button
          key={index}
          type="button"
          className={index === page ? 'pager-page is-current' : 'pager-page'}
          aria-current={index === page ? 'page' : undefined}
          onClick={() => onPage(index)}
        >
          {index + 1}
        </button>
      ))}
      <button
        type="button"
        className="btn btn--ghost pager-step"
        disabled={page >= pageCount - 1}
        onClick={() => onPage(page + 1)}
      >
        下一页
      </button>
    </nav>
  );
}

interface GroupProps {
  title: string;
  /** Stable identity for the page/filter memory; defaults to the title. */
  listKey?: string;
  /** Unit for the count in the group head, e.g. 间 or 局. */
  unit: string;
  emptyHint: string;
  cards: CardProps[];
  loading?: boolean;
  error?: string | null;
  filterable?: boolean;
}

function Group({
  title,
  listKey = title,
  unit,
  emptyHint,
  cards,
  loading = false,
  error = null,
  filterable = false,
}: GroupProps) {
  const memoryKey = entryKey(useLocation().key, listKey);
  const remembered = listMemory.get(memoryKey);
  const [filter, setFilter] = useState<FilterKey>(remembered?.filter ?? 'all');
  const [page, setPage] = useState(remembered?.page ?? 0);

  const applyFilter = (next: FilterKey) => {
    setFilter(next);
    setPage(0);
    listMemory.set(memoryKey, { filter: next, page: 0 });
  };

  const applyPage = (next: number) => {
    setPage(next);
    listMemory.set(memoryKey, { filter, page: next });
  };

  const filtered =
    filter === 'all' ? cards : cards.filter((card) => card.bucket === filter);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const visible = filtered.slice(
    current * PAGE_SIZE,
    current * PAGE_SIZE + PAGE_SIZE,
  );

  const isInitialLoading = loading && cards.length === 0;
  const isFailed = error !== null && cards.length === 0;

  const headNote = isInitialLoading
    ? '读取中…'
    : isFailed
      ? '加载失败'
      : `${filtered.length} ${unit}`;

  return (
    <section className="lobby-group">
      <div className="group-head">
        <h2 className="group-title">{title}</h2>
        <span className="group-note">{headNote}</span>
      </div>

      {filterable && cards.length > 0 ? (
        <div className="lobby-filters" role="group" aria-label="按状态筛选">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={
                item.key === filter ? 'filter-chip is-active' : 'filter-chip'
              }
              aria-pressed={item.key === filter}
              onClick={() => applyFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      {isFailed ? (
        <p className="lobby-empty">{error}</p>
      ) : isInitialLoading ? (
        <p className="lobby-empty">读取中…</p>
      ) : cards.length === 0 ? (
        <p className="lobby-empty">{emptyHint}</p>
      ) : visible.length === 0 ? (
        <p className="lobby-empty">这个状态下没有房间。</p>
      ) : (
        <div className="lobby-grid">
          {visible.map((card) => (
            <Card key={card.id} {...card} />
          ))}
        </div>
      )}

      <Pager page={current} pageCount={pageCount} onPage={applyPage} />
    </section>
  );
}

/**
 * The archive surface answers "absent or failing" with null; the lobby words
 * that as its own category error instead of an empty list, so it throws here
 * and all three lists share one loader.
 */
async function fetchArchives(): Promise<ArchiveSummary[]> {
  const list = await api.listArchives();
  if (list === null) {
    throw new Error('无法读取历史对局。');
  }
  return list;
}

/**
 * One lobby list: data, loading, error, and its own race control.
 *
 * A response may apply only when it is newer than the last applied OUTCOME,
 * not merely the newest request sent. When the API is slower than the poll
 * interval, "newest request" invalidates every response on arrival and the
 * list can never leave the loading state; comparing against applied outcomes
 * lets slow responses land while a late older snapshot still cannot
 * overwrite newer data. Failures count as outcomes too, so a fast 503 keeps
 * a slower success behind it from silently clearing the error.
 */
function useLobbyList<T>(fetchList: () => Promise<T[]>) {
  const [data, setData] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const seqRef = useRef(0);
  const appliedRef = useRef(0);
  const mountedRef = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const list = await fetchList();
      if (!mountedRef.current || seq <= appliedRef.current) {
        return;
      }
      appliedRef.current = seq;
      setData(list);
      setError(null);
      setLoading(false);
    } catch (caught) {
      if (!mountedRef.current || seq <= appliedRef.current) {
        return;
      }
      appliedRef.current = seq;
      setError(errorMessage(caught));
      setLoading(false);
    }
  }, [fetchList]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return { data, loading, error, load };
}

function HistorySection({
  archives,
  loading,
  error,
}: {
  archives: ArchiveSummary[] | null;
  loading: boolean;
  error: string | null;
}) {
  const memoryKey = entryKey(useLocation().key, 'history');
  const remembered = listMemory.get(memoryKey);
  const [page, setPage] = useState(remembered?.page ?? 0);
  const applyPage = (next: number) => {
    setPage(next);
    listMemory.set(memoryKey, { filter: 'all', page: next });
  };
  const history = archives ?? [];
  const pageCount = Math.max(1, Math.ceil(history.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const visible = history.slice(
    current * PAGE_SIZE,
    current * PAGE_SIZE + PAGE_SIZE,
  );

  return (
    <section className="lobby-group lobby-history">
      <div className="group-head">
        <h2 className="group-title">历史对局</h2>
        <span className="group-note">
          {loading && archives === null
            ? '读取中…'
            : error !== null && archives === null
              ? '加载失败'
              : `${history.length} 局`}
        </span>
      </div>
      {error !== null && archives === null ? (
        <p className="lobby-empty">{error}</p>
      ) : loading && archives === null ? (
        <p className="lobby-empty">读取中…</p>
      ) : history.length === 0 ? (
        <p className="lobby-empty">
          暂无历史对局。一局下完再开新局，旧局会来到这里。
        </p>
      ) : (
        <>
          <div className="lobby-grid">
            {visible.map((entry) => {
              const result = endLabel(
                entry.game,
                entry.winner,
                entry.endReason,
              );
              return (
                <Link
                  key={entry.archiveId}
                  className="lobby-card lobby-card--history"
                  to={`/replay/${encodeURIComponent(entry.archiveId)}`}
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
                </Link>
              );
            })}
          </div>
          <Pager page={current} pageCount={pageCount} onPage={applyPage} />
        </>
      )}
    </section>
  );
}

/** `/` shows every domain; the domain routes show one slice of the same data. */
type LobbyDomain = 'games' | 'chats';
type GameTab = 'gomoku' | 'go' | 'history';

const GAME_TABS: Array<{ key: GameTab; label: string }> = [
  { key: 'gomoku', label: '五子棋' },
  { key: 'go', label: '围棋' },
  { key: 'history', label: '历史对局' },
];

/** The game lobby's sub-tab survives leaving and coming back, like the pages do. */
const gameTabMemory = new Map<string, GameTab>();

export function LobbyPage({ domain }: { domain?: LobbyDomain } = {}) {
  usePageTitle(
    domain === 'games' ? '棋局对弈' : domain === 'chats' ? 'AI 聊天室' : '大厅',
  );
  const {
    data: games,
    loading: gamesLoading,
    error: gamesError,
    load: loadRooms,
  } = useLobbyList(api.listRooms);

  const {
    data: chats,
    loading: chatsLoading,
    error: chatsError,
    load: loadChats,
  } = useLobbyList(api.listChatRooms);

  const {
    data: archives,
    loading: archivesLoading,
    error: archivesError,
    load: loadArchives,
  } = useLobbyList(fetchArchives);

  const entry = useLocation().key;
  const navigate = useNavigate();
  const [gameTab, setGameTab] = useState<GameTab>(() => gameTabMemory.get(entry) ?? 'gomoku');
  const selectTab = (next: GameTab): void => {
    gameTabMemory.set(entry, next);
    setGameTab(next);
  };

  // The id comes back from the server, so a failed creation is the only way to
  // stay on this page — surface its message instead of a silent no-op.
  const [creating, setCreating] = useState<'game' | 'chat' | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // A chat room takes a name and two caps, so it gets a form instead of being
  // created on the spot. The defaults mirror DEFAULT_CHAT_POLICY on the server.
  const [chatForm, setChatForm] = useState<{
    title: string;
    maxHops: string;
    perMember: string;
    lease: string;
  } | null>(null);

  const createGame = async (): Promise<void> => {
    if (creating !== null) {
      return;
    }
    setCreating('game');
    setCreateError(null);
    try {
      const roomId = await api.createRoom();
      navigate(`/games/${encodeURIComponent(roomId)}`);
    } catch (caught) {
      setCreateError(errorMessage(caught));
      setCreating(null);
    }
  };

  const createChat = async (): Promise<void> => {
    if (creating !== null || chatForm === null) {
      return;
    }
    setCreating('chat');
    setCreateError(null);
    try {
      const roomId = await api.createChatRoom({
        title: chatForm.title,
        maxHops: Number(chatForm.maxHops),
        maxMessagesPerMember: Number(chatForm.perMember),
        turnTimeoutMs: Number(chatForm.lease) * 1000,
      });
      navigate(`/chats/${encodeURIComponent(roomId)}`);
    } catch (caught) {
      setCreateError(errorMessage(caught));
      setCreating(null);
    }
  };

  // A single-domain lobby only talks to its own endpoints; the overview loads
  // all three. Polling a domain the page does not render wastes requests and
  // surfaces its failures for no reason.
  const showsGames = domain !== 'chats';
  const showsChats = domain !== 'games';

  const load = useCallback((): void => {
    if (showsGames) {
      void loadRooms();
      void loadArchives();
    }
    if (showsChats) {
      void loadChats();
    }
  }, [loadRooms, loadChats, loadArchives, showsGames, showsChats]);

  useEffect(() => {
    load();
    const timer = setInterval(() => load(), POLL_MS);
    return () => {
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

  const activeErrors = [
    showsGames && gamesError ? `棋类房间：${gamesError}` : null,
    showsChats && chatsError ? `聊天房间：${chatsError}` : null,
    showsGames && archivesError ? `历史对局：${archivesError}` : null,
  ].filter(Boolean) as string[];
  const topError = activeErrors.length > 0 ? activeErrors.join('；') : null;

  const title =
    domain === 'games' ? '棋局' : domain === 'chats' ? '聊天室' : '大厅';
  const subtitle =
    domain === 'games'
      ? '五子棋与围棋的房间，点卡片进入。'
      : domain === 'chats'
        ? '多个 agent 轮流发言的聊天室。'
        : '三类房间与历史对局，点卡片进入。';

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">{title}</h2>
          <p className="page-subtitle">{subtitle}</p>
        </div>
        <div className="page-head-meta">
          {showsGames ? (
            <button
              type="button"
              className="btn"
              disabled={creating !== null}
              onClick={() => void createGame()}
            >
              {creating === 'game' ? '创建中…' : '+ 新建对局'}
            </button>
          ) : null}
          {showsChats ? (
            <button
              type="button"
              className="btn"
              disabled={creating !== null}
              onClick={() =>
                setChatForm({
                  title: '',
                  maxHops: '16',
                  perMember: '8',
                  lease: '300',
                })
              }
            >
              + 新建聊天室
            </button>
          ) : null}
          <span className="room-chip">每 {POLL_MS / 1000} 秒自动刷新</span>
        </div>
      </div>

      {chatForm !== null ? (
        <form
          className="lobby-create"
          onSubmit={(event) => {
            event.preventDefault();
            void createChat();
          }}
        >
          <label>
            名称
            <input
              value={chatForm.title}
              maxLength={40}
              placeholder="留空则用房间号"
              onChange={(event) =>
                setChatForm({ ...chatForm, title: event.target.value })
              }
            />
          </label>
          <label>
            hop 预算
            <input
              type="number"
              min={1}
              max={1000}
              step={1}
              required
              value={chatForm.maxHops}
              onChange={(event) =>
                setChatForm({ ...chatForm, maxHops: event.target.value })
              }
            />
          </label>
          <label>
            每人发言上限
            <input
              type="number"
              min={1}
              max={1000}
              step={1}
              required
              value={chatForm.perMember}
              onChange={(event) =>
                setChatForm({ ...chatForm, perMember: event.target.value })
              }
            />
          </label>
          <label>
            发言租约（秒）
            <input
              type="number"
              min={1}
              max={600}
              step={1}
              required
              value={chatForm.lease}
              onChange={(event) =>
                setChatForm({ ...chatForm, lease: event.target.value })
              }
            />
          </label>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={creating !== null}
          >
            {creating === 'chat' ? '创建中…' : '创建聊天室'}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setChatForm(null)}
          >
            取消
          </button>
        </form>
      ) : null}

      {createError !== null ? (
        <div className="error-bar" role="alert">
          <span>{createError}</span>
          <button
            type="button"
            className="error-dismiss"
            onClick={() => setCreateError(null)}
          >
            知道了
          </button>
        </div>
      ) : null}

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
        {domain === 'games' ? (
          <>
            <div className="lobby-tabs" role="tablist" aria-label="棋类分区">
              {GAME_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={gameTab === tab.key}
                  className={
                    gameTab === tab.key ? 'lobby-tab is-active' : 'lobby-tab'
                  }
                  onClick={() => selectTab(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {gameTab === 'gomoku' ? (
              <Group
                title="五子棋"
                unit="间"
                emptyHint="暂无房间。点右上角「新建对局」，或让 agent 用房间号加入。"
                cards={gomoku}
                loading={gamesLoading}
                error={gamesError}
                filterable
              />
            ) : null}
            {gameTab === 'go' ? (
              <Group
                title="围棋"
                unit="间"
                emptyHint="暂无围棋房间。进一间房选围棋开局后会出现。"
                cards={go}
                loading={gamesLoading}
                error={gamesError}
                filterable
              />
            ) : null}
            {gameTab === 'history' ? (
              <HistorySection
                archives={archives}
                loading={archivesLoading}
                error={archivesError}
              />
            ) : null}
          </>
        ) : null}

        {domain === 'chats' ? (
          <Group
            title="聊天"
            unit="间"
            emptyHint="暂无聊天室。点右上角「新建聊天室」。"
            cards={chatCards}
            loading={chatsLoading}
            error={chatsError}
            filterable
          />
        ) : null}

        {domain === undefined ? (
          <>
            <Group
              title="五子棋"
              unit="间"
              emptyHint="暂无房间。点右上角「新建对局」，或让 agent 用房间号加入。"
              cards={gomoku}
              loading={gamesLoading}
              error={gamesError}
              filterable
            />
            <Group
              title="围棋"
              unit="间"
              emptyHint="暂无围棋房间。进一间房选围棋开局后会出现。"
              cards={go}
              loading={gamesLoading}
              error={gamesError}
              filterable
            />
            <Group
              title="聊天"
              unit="间"
              emptyHint="暂无聊天室。点右上角「新建聊天室」。"
              cards={chatCards}
              loading={chatsLoading}
              error={chatsError}
              filterable
            />
            <HistorySection
              archives={archives}
              loading={archivesLoading}
              error={archivesError}
            />
          </>
        ) : null}
      </main>
    </>
  );
}
