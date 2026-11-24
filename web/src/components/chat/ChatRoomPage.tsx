import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useState,
  type FormEvent,
} from 'react';
import { useNavigate } from 'react-router';
import type { ChatMemberFrame } from '@arena/shared';
import { useChatStore, type ChatConnection } from '../../store/chat';
import { ChatComposer } from './ChatComposer';
import { authorColor, ChatTimeline } from './ChatTimeline';
import { usePageTitle } from '../layout/PageTitle';
import { BackLink } from '../layout/BackLink';
import { RoomChip } from '../layout/RoomChip';
import { RoomNotFound } from '../layout/RoomNotFound';
import { api, errorMessage } from '../../api';

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
      {ratio >= 1 ? (
        <p className="chat-hop-note">预算用完，房间已暂停；调高预算会自动继续</p>
      ) : null}
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
    return <p className="chat-closed-note">房间已关闭，记录仍保存在本机。</p>;
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
  usePageTitle('AI 聊天室');
  const connect = useChatStore((store) => store.connect);
  const connection = useChatStore((store) => store.connection);
  const room = useChatStore((store) => store.room);
  const messages = useChatStore((store) => store.messages);
  const busy = useChatStore((store) => store.busy);
  const error = useChatStore((store) => store.error);
  const errorCode = useChatStore((store) => store.errorCode);
  const send = useChatStore((store) => store.send);
  const pause = useChatStore((store) => store.pause);
  const resume = useChatStore((store) => store.resume);
  const closeRoom = useChatStore((store) => store.closeRoom);
  const setPolicy = useChatStore((store) => store.setPolicy);
  const clearError = useChatStore((store) => store.clearError);

  // Layout effect: connect() resets the store, and an ordinary effect would
  // paint one frame of the previous room after a route change.
  useLayoutEffect(() => connect(roomId), [connect, roomId]);

  // Re-render once a minute so「活动 N 分钟前」stays honest.
  const [, tick] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, []);

  const phase = room?.phase ?? 'open';
  const agents = room?.members.filter((member) => member.kind === 'agent') ?? [];

  // Null means "not editing": the field then mirrors the room's live budget, so
  // a socket frame or another tab changing it shows up without clobbering what
  // is being typed.
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);
  const applyBudget = (event: FormEvent): void => {
    event.preventDefault();
    if (room === null) {
      return;
    }
    const value = Number(budgetDraft ?? room.maxHops);
    if (!Number.isInteger(value)) {
      return;
    }
    void setPolicy({ maxHops: value });
    setBudgetDraft(null);
  };

  // Seconds on screen, milliseconds on the wire; the field mirrors the live
  // value until the host types, same rule as the budget above.
  const [leaseDraft, setLeaseDraft] = useState<string | null>(null);
  const applyLease = (event: FormEvent): void => {
    event.preventDefault();
    if (room === null) {
      return;
    }
    const seconds = Number(leaseDraft ?? room.turnTimeoutMs / 1000);
    if (!Number.isInteger(seconds)) {
      return;
    }
    void setPolicy({ turnTimeoutMs: seconds * 1000 });
    setLeaseDraft(null);
  };

  const navigate = useNavigate();
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Both delete and export failures surface here, so the name is the shared
  // action error, not the delete error.
  const [actionError, setActionError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // Same 4s window as the other two-step buttons: arming expires on its own.
  useEffect(() => {
    if (!deleteArmed) {
      return;
    }
    const timer = setTimeout(() => setDeleteArmed(false), 4_000);
    return () => clearTimeout(timer);
  }, [deleteArmed]);

  // Mirrors the server rule: an empty room goes at once, a room with a
  // transcript must be closed first.
  const deletable =
    room !== null && (room.messageCount === 0 || room.phase === 'closed');
  const removeRoom = async (): Promise<void> => {
    setDeleting(true);
    setActionError(null);
    try {
      await api.deleteChatRoom(roomId);
      navigate('/chats');
    } catch (caught) {
      setActionError(errorMessage(caught));
      setDeleting(false);
      setDeleteArmed(false);
    }
  };

  // The transcript endpoint returns the Markdown rendering inside JSON; turn
  // it into a real file download so the closed-room hint has a working entry.
  const exportTranscript = async (): Promise<void> => {
    setExporting(true);
    setActionError(null);
    try {
      const payload = await api.chatTranscript(
        roomId,
        Math.max(1, room?.messageCount ?? 1),
      );
      const blob = new Blob([payload.text], {
        type: 'text/markdown;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `chat-${roomId}.md`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setExporting(false);
    }
  };

  // A 1008 close with ROOM_NOT_FOUND is not a transient network failure: the
  // room is gone, so the page shows an empty state instead of "连接中…".
  if (room === null && errorCode === 'ROOM_NOT_FOUND') {
    return (
      <RoomNotFound
        title="聊天室"
        to="/chats"
        backLabel="聊天大厅"
        actionLabel="返回聊天大厅"
        body="请检查房间号，或返回聊天大厅重新选择一间聊天室。"
      />
    );
  }

  const composerDisabled = busy || room === null || phase === 'closed';
  const composerHint =
    room === null
      ? '连接中…'
      : phase === 'closed'
        ? '房间已关闭，记录仍保存在本机。'
        : phase === 'paused'
          ? '房间已暂停，agent 不会收到轮次；点上方「恢复」继续。'
          : null;
  const turnLabel =
    room === null
      ? '连接中…'
      : phase === 'paused'
        ? '房间已暂停'
        : phase === 'closed'
          ? '房间已关闭'
          : room.turn
            ? `轮到 ${room.turn.name}`
            : '等待轮转';

  return (
    <>
      <div className="page-head">
        <div>
          <BackLink to="/chats" label="聊天大厅" />
          <h2 className="page-title">聊天室</h2>
          <p className="page-subtitle">
            {room ? room.title : '…'} · 多个 agent 轮流发言，你主持。
          </p>
        </div>
        <div className="page-head-meta">
          <RoomChip roomId={roomId} />
          <span className={`chat-phase chat-phase--${phase}`}>
            {PHASE_LABELS[phase]}
          </span>
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
                ? '删除这间聊天室，记录一并删除'
                : '还有消息未关闭，先点「关闭」再删'
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

      {actionError !== null || error ? (
        <div className="error-bar" role="alert">
          <span>{actionError ?? error}</span>
          <button
            type="button"
            className="error-dismiss"
            onClick={() => {
              setActionError(null);
              clearError();
            }}
          >
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
                  ? `${room.messageCount} 条消息`
                  : '等待连接'}
              </p>
            </div>
            <div className="chat-turn">{turnLabel}</div>
          </div>
          {phase === 'paused' ? (
            <div className="chat-phase-banner chat-phase-banner--paused" role="status">
              <span>房间已暂停，agent 不会收到轮次；点「恢复」继续。</span>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => void resume()}
              >
                恢复
              </button>
            </div>
          ) : null}
          {phase === 'closed' ? (
            <div className="chat-phase-banner chat-phase-banner--closed" role="status">
              <span>房间已关闭，记录仍保存在本机。</span>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={exporting}
                onClick={() => void exportTranscript()}
              >
                {exporting ? '导出中…' : '导出记录（Markdown）'}
              </button>
            </div>
          ) : null}
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
              {room !== null && room.phase !== 'closed' ? (
                <form className="chat-hop-adjust" onSubmit={applyBudget}>
                  <label htmlFor="hop-budget">调整预算</label>
                  <input
                    id="hop-budget"
                    type="number"
                    min={1}
                    max={1000}
                    step={1}
                    required
                    disabled={busy}
                    value={budgetDraft ?? String(room.maxHops)}
                    onChange={(event) => setBudgetDraft(event.target.value)}
                  />
                  <button
                    type="submit"
                    className="btn btn--ghost"
                    disabled={busy}
                  >
                    应用
                  </button>
                </form>
              ) : null}
              {room !== null && room.phase !== 'closed' ? (
                <form className="chat-hop-adjust" onSubmit={applyLease}>
                  <label htmlFor="turn-lease">发言租约（秒）</label>
                  <input
                    id="turn-lease"
                    type="number"
                    min={1}
                    max={600}
                    step={1}
                    required
                    disabled={busy}
                    value={leaseDraft ?? String(room.turnTimeoutMs / 1000)}
                    onChange={(event) => setLeaseDraft(event.target.value)}
                  />
                  <button
                    type="submit"
                    className="btn btn--ghost"
                    disabled={busy}
                  >
                    应用
                  </button>
                </form>
              ) : null}
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
    </>
  );
}
