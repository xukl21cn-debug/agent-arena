import { useEffect, useRef, type CSSProperties } from 'react';
import type { ChatMemberFrame, ChatMessageFrame } from '@arena/shared';

/**
 * Stable author colour: hash the name, never the index — members come and
 * go, and a colour that jumps when someone joins reads as a different person.
 */
export function authorColor(name: string): string {
  let hash = 7;
  for (const ch of name) {
    hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  }
  return `hsl(${hash} 52% 68%)`;
}

function clockOf(at: string): string {
  return at.slice(11, 16);
}

interface TimelineProps {
  messages: ChatMessageFrame[];
  members: ChatMemberFrame[];
}

export function ChatTimeline({ messages, members }: TimelineProps) {
  const listRef = useRef<HTMLDivElement>(null);
  /** Only the reader decides when to stop following the tail. */
  const stickToBottom = useRef(true);

  const handleScroll = (): void => {
    const el = listRef.current;
    if (!el) {
      return;
    }
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const nameOf = (idOrName: string): string =>
    members.find((member) => member.id === idOrName)?.name ?? idOrName;

  return (
    <div
      ref={listRef}
      className="chat-lines"
      onScroll={handleScroll}
      role="log"
      aria-live="polite"
    >
      {messages.length === 0 ? (
        <div className="chat-empty">
          <strong>还没有消息</strong>
          <span>第一个发言，或等 agent 加入。</span>
        </div>
      ) : (
        messages.map((message) => {
          if (message.kind === 'system') {
            return (
              <div key={message.id} className="chat-line chat-line--system">
                <span>{message.text}</span>
                <time>{clockOf(message.at)}</time>
              </div>
            );
          }
          if (message.kind === 'event') {
            return (
              <div key={message.id} className="chat-line chat-line--event">
                <span>{message.text}</span>
                <time>{clockOf(message.at)}</time>
              </div>
            );
          }
          const own = message.from === 'human';
          return (
            <div
              key={message.id}
              className={`chat-line${own ? ' chat-line--own' : ''}`}
            >
              <div
                className="chat-bubble"
                style={{ '--author': authorColor(message.fromName) } as CSSProperties}
              >
                <div className="chat-bubble-meta">
                  <span className="chat-author">{message.fromName}</span>
                  {message.to ? (
                    <span className="chat-to">→ {nameOf(message.to)}</span>
                  ) : null}
                  <time>{clockOf(message.at)}</time>
                </div>
                <p className="chat-bubble-text">{message.text}</p>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
