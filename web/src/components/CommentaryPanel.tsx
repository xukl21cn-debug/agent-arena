import { useEffect, useRef, useState } from 'react';
import {
  MAX_COMMENTARY_LENGTH,
  type Commentary,
  type CommentaryKind,
  type OpponentStatus,
  type StoneColor,
} from '@gomoku/shared';

const KIND_LABELS: Record<CommentaryKind, string> = {
  evaluation: '评价',
  position: '局势',
  reaction: '反应',
  result: '结果',
  banter: '闲聊',
};

/** What the panel says about the opponent's live state. */
const STATUS_LABELS: Record<OpponentStatus, string> = {
  idle: '',
  thinking: '思考中',
  offline: '未接入',
  disconnected: '已断开',
};

/** Copy for the empty state, which must not promise a reply that cannot come. */
const EMPTY_COPY: Record<OpponentStatus, { title: string; hint: string }> = {
  idle: { title: 'AI 还没开口', hint: '轮到它时，它会在这里点评你的落子。' },
  thinking: { title: 'AI 正在思考', hint: '它在读棋盘，稍等片刻。' },
  offline: {
    title: 'AI 还没接入',
    hint: '在 MCP 客户端里连上这个房间，它才会应招。',
  },
  disconnected: {
    title: 'AI 已断开',
    hint: '连接恢复后它会继续，或者点「认输」重开一局。',
  },
};

/** The same empty state while spectating: no side here is "yours". */
const SPECTATOR_EMPTY = {
  title: '还没有解说',
  hint: '两个 AI 落子后，可能会在这里点评。',
};

interface CommentaryPanelProps {
  commentary: Commentary[];
  opponentState: OpponentStatus;
  agentColor: StoneColor | null;
  /** Both seats are agents: the panel narrates a game nobody here plays. */
  spectator: boolean;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function CommentaryPanel({
  commentary,
  opponentState,
  agentColor,
  spectator,
}: CommentaryPanelProps) {
  const thinking = opponentState === 'thinking';
  const empty = spectator ? SPECTATOR_EMPTY : EMPTY_COPY[opponentState];
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const countRef = useRef(0);
  const [unpinned, setUnpinned] = useState(false);
  const [unread, setUnread] = useState(false);

  const scrollToBottom = (smooth = false): void => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    list.scrollTo({
      top: list.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  };

  useEffect(() => {
    const hasNew = commentary.length > countRef.current;
    countRef.current = commentary.length;

    if (pinnedRef.current) {
      scrollToBottom();
      setUnread(false);
    } else if (hasNew) {
      setUnread(true);
    }
  }, [commentary]);

  useEffect(() => {
    if (pinnedRef.current) {
      scrollToBottom();
    }
  }, [thinking]);

  const handleScroll = (): void => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const atBottom =
      list.scrollHeight - list.scrollTop - list.clientHeight <= 48;
    pinnedRef.current = atBottom;
    setUnpinned(!atBottom);
    if (atBottom) {
      setUnread(false);
    }
  };

  const jumpToBottom = (): void => {
    pinnedRef.current = true;
    setUnpinned(false);
    setUnread(false);
    scrollToBottom(true);
  };

  const seatLabel = spectator
    ? '双 AI 对弈'
    : agentColor
      ? `AI 执${agentColor === 'black' ? '黑' : '白'}`
      : 'AI 未入座';

  return (
    <section className="panel" aria-label="AI 互动">
      <header className="panel-head">
        <div className="panel-heading">
          <h2 className="panel-title">AI 互动</h2>
          <p className="panel-meta">{seatLabel}</p>
        </div>
        <span
          className={`panel-live ${
            opponentState === 'thinking' ? 'is-thinking' : ''
          } ${opponentState === 'offline' || opponentState === 'disconnected' ? 'is-away' : ''}`}
        >
          {opponentState === 'idle'
            ? `${commentary.length} 条`
            : STATUS_LABELS[opponentState]}
        </span>
      </header>

      <div
        className="panel-list"
        ref={listRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-label="AI 解说记录"
      >
        {commentary.length === 0 && !thinking ? (
          <div className="panel-empty">
            <strong>{empty.title}</strong>
            <span>{empty.hint}</span>
          </div>
        ) : null}

        {commentary.map((item) => (
          <article
            key={item.id}
            className={`bubble bubble--${item.mood}`}
          >
            <header className="bubble-meta">
              <span className="bubble-kind">{KIND_LABELS[item.kind]}</span>
              <span>第 {item.moveIndex} 手</span>
              <time dateTime={item.at}>{formatTime(item.at)}</time>
            </header>
            <p className="bubble-text">
              {item.text.slice(0, MAX_COMMENTARY_LENGTH)}
            </p>
          </article>
        ))}

        {thinking ? (
          <div className="thinking" role="status">
            <span>AI 正在思考</span>
            <span className="thinking-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
        ) : null}
      </div>

      {unpinned ? (
        <button type="button" className="jump-bottom" onClick={jumpToBottom}>
          {unread ? '有新解说 · 回到底部' : '回到底部'}
        </button>
      ) : null}
    </section>
  );
}
