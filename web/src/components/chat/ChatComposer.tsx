import { useRef, useState, type KeyboardEvent } from 'react';
import type { ChatMemberFrame } from '@arena/shared';

interface MentionState {
  /** Index of the `@` in the text; the token is `@query` from there. */
  start: number;
  query: string;
  active: number;
}

interface ComposerProps {
  /** Agents only — `to` must name an agent, humans never hold a turn. */
  agents: ChatMemberFrame[];
  disabled: boolean;
  /** Why the box is disabled, e.g. 房间已暂停. */
  hint: string | null;
  busy: boolean;
  onSend(text: string, to?: string): Promise<boolean>;
}

/** The `@token` ending at the caret, if any. */
function mentionAt(text: string, caret: number): MentionState | null {
  const match = /@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!match) {
    return null;
  }
  return { start: caret - match[0].length, query: match[1]!, active: 0 };
}

/**
 * Host speech plus the relay baton pass: typing `@` opens the agent list
 * (agents only), picking one strips the `@name` from the text and sets the
 * message's `to` — a UI shortcut over the existing relay turn, not a
 * mentions mode. Without an `@`, `to` stays unset and relay rotates.
 */
export function ChatComposer({
  agents,
  disabled,
  hint,
  busy,
  onSend,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [target, setTarget] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [mention, setMention] = useState<MentionState | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const candidates =
    mention === null
      ? []
      : agents.filter((member) =>
          member.name.toLowerCase().startsWith(mention.query.toLowerCase()),
        );

  const syncMention = (nextText: string, caret: number): void => {
    const found = mentionAt(nextText, caret);
    if (!found || agents.length === 0) {
      setMention(null);
      return;
    }
    setMention((current) =>
      current && current.query === found.query ? current : found,
    );
  };

  const choose = (index: number): void => {
    const member = candidates[index];
    const state = mention;
    if (!member || !state) {
      return;
    }
    const tokenEnd = state.start + 1 + state.query.length;
    setText(text.slice(0, state.start) + text.slice(tokenEnd));
    setTarget({ id: member.id, name: member.name });
    setMention(null);
    inputRef.current?.focus();
    const caret = { start: state.start, end: state.start };
    inputRef.current?.setSelectionRange(caret.start, caret.end);
  };

  const trySend = async (): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || disabled || busy) {
      return;
    }
    const sent = await onSend(trimmed, target?.id);
    if (sent) {
      setText('');
      setTarget(null);
      setMention(null);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mention !== null && candidates.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMention({
          ...mention,
          active: (mention.active + 1) % candidates.length,
        });
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMention({
          ...mention,
          active: (mention.active - 1 + candidates.length) % candidates.length,
        });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        choose(mention.active);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void trySend();
    }
  };

  const placeholder =
    target !== null
      ? `点名 @${target.name} 接话…`
      : agents.length === 0
        ? '发言（agent 尚未加入）…'
        : '发言，输入 @ 点名某个 agent…';

  return (
    <div className="chat-composer">
      {target !== null ? (
        <div className="chat-target">
          <span>
            点名 <b>@{target.name}</b> 发言
          </span>
          <button
            type="button"
            className="chat-target-clear"
            aria-label="取消点名"
            onClick={() => setTarget(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="chat-composer-row">
        <div className="chat-input-wrap">
          <textarea
            ref={inputRef}
            rows={2}
            value={text}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(event) => {
              setText(event.target.value);
              syncMention(event.target.value, event.target.selectionStart ?? 0);
            }}
            onSelect={(event) =>
              syncMention(
                text,
                (event.target as HTMLTextAreaElement).selectionStart ?? 0,
              )
            }
            onKeyDown={handleKeyDown}
            onBlur={() => setMention(null)}
          />
          {mention !== null && candidates.length > 0 ? (
            <ul className="chat-mention" role="listbox">
              {candidates.map((member, index) => (
                <li
                  key={member.id}
                  role="option"
                  aria-selected={index === mention.active}
                  className={index === mention.active ? 'is-active' : ''}
                  // mousedown, not click: the textarea must not lose focus.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(index);
                  }}
                >
                  <span className="chat-mention-name">@{member.name}</span>
                  <span className="chat-mention-meta">
                    agent · {member.messages} 条
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button
          type="button"
          className="btn btn--primary chat-send"
          disabled={disabled || busy || text.trim().length === 0}
          onClick={() => void trySend()}
        >
          发送
        </button>
      </div>

      {hint !== null ? <p className="chat-hint">{hint}</p> : null}
    </div>
  );
}
