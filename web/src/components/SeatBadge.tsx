import type { ParticipantView, PresenceState, StoneColor } from '@arena/shared';

interface SeatBadgeProps {
  participant: ParticipantView | null;
  /** Fallback color when the seat is empty. */
  color: StoneColor | null;
  side: 'human' | 'agent';
}

/** Short label for the dot; the full sentence lives in the tooltip. */
const PRESENCE_LABELS: Record<PresenceState, string> = {
  unknown: '未连接',
  waiting: '等待中',
  thinking: '思考中',
  idle: '在线',
  disconnected: '已断开',
};

function describe(participant: ParticipantView, side: 'human' | 'agent'): string {
  const who = side === 'human' ? '你' : 'AI';
  const client = participant.client ? `（${participant.client}）` : '';
  switch (participant.presence) {
    case 'waiting':
      return `${who}${client} 正在等待下一步`;
    case 'thinking':
      return `${who}${client} 正在思考`;
    case 'idle':
      return `${who}${client} 已连接`;
    case 'disconnected':
      return `${who}${client} 已断开连接`;
    default:
      return `${who} 还没有接入`;
  }
}

/**
 * One seat: stone color, who occupies it, and whether that side is actually
 * reachable right now.
 *
 * The presence dot answers the question the old UI could not: "is the AI
 * connected, or am I waiting for nobody?" — without ever mistaking a long
 * think for a disconnect.
 */
export function SeatBadge({ participant, color, side }: SeatBadgeProps) {
  const presence = participant?.presence ?? 'unknown';
  const active = participant?.isTurn ?? false;
  const label =
    participant?.label ?? (side === 'human' ? '你' : 'AI');
  const suffix =
    color === 'black' ? ' · 黑' : color === 'white' ? ' · 白' : '';

  return (
    <span
      className={`seat seat--${presence} ${active ? 'is-active' : ''}`}
      title={participant ? describe(participant, side) : undefined}
    >
      <i className={`seat-dot seat-dot--${color ?? 'empty'}`} aria-hidden="true" />
      <span className="seat-name">
        {label}
        {suffix}
      </span>
      <span className={`presence presence--${presence}`}>
        <i className="presence-dot" aria-hidden="true" />
        {PRESENCE_LABELS[presence]}
      </span>
    </span>
  );
}
