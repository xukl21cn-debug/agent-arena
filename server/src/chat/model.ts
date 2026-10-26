import { randomUUID } from 'node:crypto';

/**
 * Chat is a third kind of room beside gomoku and go: members, messages, a
 * turn policy and a hop budget, with no board and no result. These types are
 * the chat domain's own contract — deliberately not in @arena/shared, whose
 * game.ts is the games' schema, and deliberately not reusing GameStatus or
 * RoomPhase, which mean board things.
 */

export type ChatPhase =
  /** Accepting messages. */
  | 'open'
  /** Host paused the room: agents may not speak, humans still may. */
  | 'paused'
  /** Final state; no further messages or joins. */
  | 'closed';

export type ChatMode = 'relay' | 'mentions' | 'free';
/** v1 implements relay only; the other modes exist in the contract for C3+. */
export const CHAT_MODES: readonly ChatMode[] = ['relay', 'mentions', 'free'];

export interface ChatPolicy {
  mode: ChatMode;
  /** Agent messages a room may take before it auto-pauses. */
  maxHops: number;
  /** Agent messages one member may send before further sends are refused. */
  maxMessagesPerMember: number;
  /** How long one member's speaking turn may last before it is skipped. */
  turnTimeoutMs: number;
  /** Hard length cap for one message's text. */
  maxMessageChars: number;
}

export const DEFAULT_CHAT_POLICY: ChatPolicy = {
  mode: 'relay',
  maxHops: 16,
  maxMessagesPerMember: 8,
  turnTimeoutMs: 120_000,
  maxMessageChars: 4000,
};

export interface ChatMember {
  id: string;
  /** `human` is the reserved host identity; agents join under their own name. */
  name: string;
  kind: 'human' | 'agent';
  joinedAt: string;
  /** Agent messages sent; humans are never counted. */
  messages: number;
  /** Presence the chat room owns itself: last tool call from this member. */
  lastSeenAt: number;
  client?: string;
}

export interface ChatTurn {
  participantId: string;
  name: string;
  /** Absolute deadline; an expired turn is settled lazily on the next touch. */
  expiresAt: number;
}

export interface ChatMessage {
  /** Room-local, monotonic from 1. The wait protocol's cursor. */
  seq: number;
  id: string;
  roomId: string;
  from: string;
  /** Redundant on purpose: transcripts must render after a member left. */
  fromName: string;
  /** Requested next speaker (member id or name at send time). */
  to?: string;
  kind: 'chat' | 'event' | 'system';
  text: string;
  replyTo?: string;
  /** Agent sends burn budget; human and system messages are always 0. */
  hop: number;
  at: string;
}

export interface ChatRoomSnapshot {
  id: string;
  title: string;
  phase: ChatPhase;
  policy: ChatPolicy;
  /** Seq of the newest message; 0 on a fresh room. */
  seq: number;
  hop: number;
  turn: ChatTurn | null;
  members: ChatMember[];
  messageCount: number;
  createdAt: string;
}

/** What the room persists — the unit saved under <dataDir>/chat/<id>.json. */
export interface ChatRoomSnapshotFile {
  id: string;
  title: string;
  phase: ChatPhase;
  policy: ChatPolicy;
  seq: number;
  hop: number;
  createdAt: string;
  members: ChatMember[];
  messages: ChatMessage[];
  /** Per-member streak of expired turns, so a restart cannot dodge the pause. */
  consecutiveTimeouts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Errors — the chat domain's own codes, kept beside its own router so the
// games' ErrorCode contract in @arena/shared stays untouched.
// ---------------------------------------------------------------------------

export type ChatErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_EXISTS'
  | 'INVALID_ROOM_ID'
  | 'INVALID_REQUEST'
  | 'ROOM_CLOSED'
  | 'ROOM_PAUSED'
  | 'NOT_YOUR_TURN'
  | 'MEMBER_NOT_FOUND'
  | 'MEMBER_LIMIT_REACHED'
  | 'DUPLICATE_MESSAGE'
  | 'MESSAGE_TOO_LONG'
  | 'IDENTITY_REQUIRED'
  | 'INTERNAL_ERROR';

export class ChatError extends Error {
  readonly code: ChatErrorCode;

  constructor(code: ChatErrorCode, message: string) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Long-poll defaults, pressed under a 60s MCP client tool timeout. */
export const CHAT_WAIT_DEFAULT_MS = 20_000;
export const CHAT_WAIT_MAX_MS = 30_000;
export const CHAT_WAIT_MIN_MS = 1_000;

/** Transcripts and waits return recent messages only; older ones are counted. */
export const CHAT_RECENT_LIMIT = 12;

/** A freshly joined member sees this many recent messages. */
export const CHAT_JOIN_RECENT = 12;

export function chatMessageId(): string {
  return randomUUID();
}

/** Clamp a requested long-poll timeout into the chat's supported window. */
export function clampChatWaitMs(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return CHAT_WAIT_DEFAULT_MS;
  }
  return Math.min(
    Math.max(Math.round(requested), CHAT_WAIT_MIN_MS),
    CHAT_WAIT_MAX_MS,
  );
}

/**
 * One actionable line telling an agent what to do next. P2's lesson: an
 * error or wait answer that does not say what to do next reads as a failure
 * and the model stops or retries blindly.
 */
export function chatHint(snapshot: ChatRoomSnapshot, yourTurn: boolean): string {
  if (snapshot.phase === 'closed') {
    return '房间已关闭';
  }
  if (snapshot.phase === 'paused') {
    return '房间已暂停，等主持人恢复；继续 wait_for_messages';
  }
  if (yourTurn) {
    return '轮到你了，用 send_message 发言';
  }
  if (snapshot.turn) {
    return `等 ${snapshot.turn.name} 发言，继续 wait_for_messages`;
  }
  const agents = snapshot.members.filter((member) => member.kind === 'agent');
  if (agents.length === 0) {
    return '房间里还没有其他成员，等 agent join_room 后再继续';
  }
  return '等待轮转确定下一位发言者，继续 wait_for_messages';
}
