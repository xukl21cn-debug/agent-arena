import { useEffect, useReducer, useState } from 'react';
import type { ChatMemberFrame } from '@arena/shared';
import { useChatStore, type ChatConnection } from '../../store/chat';
import { ChatComposer } from './ChatComposer';
import { authorColor, ChatTimeline } from './ChatTimeline';

const CONNECTION_LABELS: Record<ChatConnection, string> = {
  connecting: '连接中',
  online: '已连接',
  reconnecting: '重连中',
  offline: '已断开',
};

const PHASE_LABELS: Record<string, string> = {
  open: '进行中',
  paused: '已暂停',
  closed: '已结束',
};

function minutesAgo(epochMs: number): string {
  if (epochMs <= 0) {
    return '';
  }
  const minutes = Math.round((Date.now() - epochMs) / 60_000);
  if (minutes < 1) {
    return '刚刚';
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours} 小时前`;
}

/** 距最后活动的时间戳，不是在线状态——聊天室没有 presence。 */
function LastSeen({ member }: { member: ChatMemberFrame }) {
  const label = minutesAgo(member.lastSeenAt);
  return label === '' ? null : <span className="chat-member-seen">活动 {label}</span>;
}

function HopMeter({
  hop,
  maxHops,
}: {
  hop: number;
  maxHops: number;
}) {
  const ratio = maxHops > 0 ? Math.min(hop / maxHops, 1) : 0;
  const tone = ratio >= 1 ? 'full' : ratio > 0.8 ? 'warn' : 'ok';
  return (
    <div className={`chat-hop chat-hop--${tone}`}>
      <div className="chat-hop-head">
        <span>hop 预算</span>
        <span className="chat-hop-count">
          {hop} / {maxHops}
        </span>
      </div>
      <div className="chat-hop-bar">
        <i style={{ width: `${ratio * 100}%` }} />
      </div>
      {ratio >= 1 ? <p className="chat-hop-note">预算用完，房间已暂停</p> : null}
    </div>
  );
}

function MemberRow({
  member,
  onTurn,
}: {
  member: ChatMemberFrame;
  onTurn: boolean;
}) {
  return (
    <li className={`chat-member${onTurn ? ' is-turn' : ''}`}>
      {onTurn ? <span className="chat-member-turn">发言中</span> : null}
      <span
        className="chat-member-dot"
        style={{ background: authorColor(member.name) }}
        aria-hidden="true"
      />
      <span className="chat-member-name">{member.name}</span>
      <span className="chat-member-kind">
        {member.kind === 'human' ? '主持' : 'agent'}
      </span>
      <span className="chat-member-count">{member.messages} 条</span>
      <LastSeen member={member} />
    </li>
  );
}

/** Close is irreversible; it takes a second click to actually fire. */
function HostControls({
  phase,
  busy,
  onPause,
  onResume,
  onClose,
}: {
  phase: 'open' | 'paused' | 'closed';
  busy: boolean;
  onPause(): void;
  onResume(): void;
  onClose(): void;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) {
      return;
    }
    const timer = setTimeout(() => setArmed(false), 4_000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (phase === 'closed') {
    return <p className="chat-closed-note">房间已关闭，记录仍可导出。</p>;
  }

  return (
    <div className="chat-host-controls">
      {phase === 'open' ? (
        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy}
          onClick={onPause}
        >
          暂停
        </button>
      ) : (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={onResume}
        >
          恢复
        </button>
      )}
      {armed ? (
        <>
          <button
            type="button"
            className="btn btn--danger is-confirming"
            disabled={busy}
            onClick={() => {
              setArmed(false);
              onClose();
            }}
          >
            确认关闭
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setArmed(false)}
          >
            取消
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn btn--danger"
          disabled={busy}
          onClick={() => setArmed(true)}
        >
          关闭
        </button>
      )}
    </div>
  );
}

export function ChatRoomPage({ roomId }: { roomId: string }) {
  const connect = useChatStore((store) => store.connect);
  const connection = useChatStore((store) => store.connection);
  const room = useChatStore((store) => store.room);
  const messages = useChatStore((store) => store.messages);
  const busy = useChatStore((store) => store.busy);
  const error = useChatStore((store) => store.error);
  const send = useChatStore((store) => store.send);
  const pause = useChatStore((store) => store.pause);
  const resume = useChatStore((store) => store.resume);
  const closeRoom = useChatStore((store) => store.closeRoom);
  const clearError = useChatStore((store) => store.clearError);

  useEffect(() => connect(roomId), [connect, roomId]);

  // Re-render once a minute so「活动 N 分钟前」stays honest.
  const [, tick] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, []);

  const phase = room?.phase ?? 'open';
  const agents = room?.members.filter((member) => member.kind === 'agent') ?? [];

  const composerDisabled =
    busy || room === null || phase === 'paused' || phase === 'closed';
  const composerHint =
    room === null
      ? '连接中…'
      : phase === 'paused'
        ? '房间已暂停'
        : phase === 'closed'
          ? '房间已关闭'
          : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <p className="eyebrow">Agent Arena · MCP</p>
          <h1 className="title">聊天室</h1>
          <p className="subtitle">
            {room ? room.title : '…'} · 多个 agent 轮流发言，你主持。
          </p>
        </div>
        <div className="topbar-meta">
          <span className="room-chip" title="房间号">
            room / {roomId}
          </span>
          <span className={`chat-phase chat-phase--${phase}`}>
            {PHASE_LABELS[phase]}
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

      <main className="chat-arena">
        <section className="chat-main panel">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">时间线</h2>
              <p className="panel-meta">
                {room
                  ? `seq ${room.seq} · ${room.messageCount} 条`
                  : '等待连接'}
              </p>
            </div>
            <div className="chat-turn">
              {room?.turn ? `轮到 ${room.turn.name}` : '等待轮转'}
            </div>
          </div>
          <ChatTimeline messages={messages} members={room?.members ?? []} />
          <ChatComposer
            agents={agents}
            disabled={composerDisabled}
            hint={composerHint}
            busy={busy}
            onSend={send}
          />
        </section>

        <aside className="chat-side">
          <section className="panel chat-side-panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">预算与轮次</h2>
                <p className="panel-meta">relay</p>
              </div>
            </div>
            <div className="chat-side-body">
              {room ? (
                <HopMeter hop={room.hop} maxHops={room.maxHops} />
              ) : (
                <p className="chat-hint">连接中…</p>
              )}
              <HostControls
                phase={phase}
                busy={busy}
                onPause={() => void pause()}
                onResume={() => void resume()}
                onClose={() => void closeRoom()}
              />
            </div>
          </section>

          <section className="panel chat-side-panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">成员</h2>
                <p className="panel-meta">{room?.members.length ?? 0} 人</p>
              </div>
            </div>
            <ul className="chat-side-body chat-members">
              {(room?.members ?? []).map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  onTurn={room?.turn?.participantId === member.id}
                />
              ))}
            </ul>
          </section>
        </aside>
      </main>
    </div>
  );
}
