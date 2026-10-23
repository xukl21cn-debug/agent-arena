import { useEffect, useRef, useState } from 'react';
import {
  MAX_COMMENTARY_LENGTH,
  type Commentary,
  type CommentaryKind,
  type StoneColor,
} from '@gomoku/shared';

const KIND_LABELS: Record<CommentaryKind, string> = {
  evaluation: '评价',
  position: '局势',
  reaction: '反应',
  result: '结果',
  banter: '闲聊',
};

interface CommentaryPanelProps {
  commentary: Commentary[];
  thinking: boolean;
  agentColor: StoneColor | null;
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
  thinking,
  agentColor,
}: CommentaryPanelProps) {
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

  const seatLabel = agentColor
    ? `AI 执${agentColor === 'black' ? '黑' : '白'}`
    : 'AI 未入座';

  return (
    <section className="panel" aria-label="AI 互动">
      <header className="panel-head">
        <div className="panel-heading">
          <h2 className="panel-title">AI 互动</h2>
          <p className="panel-meta">{seatLabel}</p>
        </div>
        <span className={`panel-live ${thinking ? 'is-thinking' : ''}`}>
          {thinking ? '思考中' : `${commentary.length} 条`}
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
            <strong>AI 还没开口</strong>
            <span>轮到它时，它会在这里点评你的落子。</span>
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
