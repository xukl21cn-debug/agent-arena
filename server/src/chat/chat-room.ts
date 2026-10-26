import {
  type ChatMember,
  type ChatMessage,
  type ChatPhase,
  type ChatPolicy,
  type ChatRoomSnapshot,
  type ChatRoomSnapshotFile,
  type ChatTurn,
  chatMessageId,
} from './model.js';
import { ChatError } from './model.js';

/** The reserved host identity humans speak through (REST posts as `human`). */
export const HUMAN_MEMBER_ID = 'human';

interface Waiter {
  participantId: string;
  afterSeq: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (timedOut: boolean) => void;
}

export interface WaitOutcome {
  timedOut: boolean;
}

/**
 * One chat room: members, a monotonic message log, a relay turn and a hop
 * budget. A pure domain object — no I/O; the manager owns persistence and
 * receives `onChange` after every mutation worth saving.
 *
 * Relay turn rules (the v1 policy):
 *  - an agent may speak only when the turn is unset or points at it;
 *  - a speaker names the next member with `to`, else the turn rotates to the
 *    next agent in join order (humans never hold a turn — they can always
 *    speak and would deadlock a rotation aimed at an absent typist);
 *  - the human host may interject at any moment without spending the budget;
 *    without an explicit `to` an interjection leaves a live turn untouched
 *    (that is what "interject" means) and only seeds a turn when none exists;
 *  - an expired turn is settled lazily on the next touch: a system message
 *    skips to the next member, two consecutive timeouts pause the room.
 */
export class ChatRoom {
  readonly id: string;
  title: string;
  phase: ChatPhase = 'open';
  readonly policy: ChatPolicy;
  seq = 0;
  hop = 0;
  readonly createdAt: string;
  turn: ChatTurn | null = null;

  /** Insertion order is the rotation order. */
  readonly members = new Map<string, ChatMember>();
  readonly messages: ChatMessage[] = [];
  private readonly consecutiveTimeouts = new Map<string, number>();
  /** Last chat text per member, for the duplicate-message rule. */
  private readonly lastText = new Map<string, string>();
  private readonly waiters = new Set<Waiter>();

  constructor(
    id: string,
    title: string,
    policy: ChatPolicy,
    createdAt = new Date().toISOString(),
  ) {
    this.id = id;
    this.title = title;
    this.policy = policy;
    this.createdAt = createdAt;
  }

  /** Called by the manager after any mutation that must reach the disk. */
  onChange: (() => void) | null = null;

  // -- membership -----------------------------------------------------------

  /**
   * Join as an agent. A name already seated is a reconnect: the same member
   * record comes back (P1b's same-name rule), so a restarted client keeps
   * its history in the rotation.
   */
  join(name: string, client: string | undefined, now: number): ChatMember {
    if (this.phase === 'closed') {
      throw new ChatError('ROOM_CLOSED', `Chat room "${this.id}" is closed.`);
    }
    const existing = [...this.members.values()].find(
      (member) => member.kind === 'agent' && member.name === name,
    );
    if (existing) {
      existing.lastSeenAt = now;
      if (client !== undefined) {
        existing.client = client;
      }
      this.onChange?.();
      return existing;
    }

    const member: ChatMember = {
      id: `p_${chatMessageId().slice(0, 8)}`,
      name,
      kind: 'agent',
      joinedAt: new Date(now).toISOString(),
      messages: 0,
      lastSeenAt: now,
      ...(client === undefined ? {} : { client }),
    };
    this.members.set(member.id, member);
    this.onChange?.();
    return member;
  }

  /** The reserved human member, present from the moment the room is created. */
  humanMember(): ChatMember {
    let member = this.members.get(HUMAN_MEMBER_ID);
    if (!member) {
      member = {
        id: HUMAN_MEMBER_ID,
        name: 'human',
        kind: 'human',
        joinedAt: this.createdAt,
        messages: 0,
        lastSeenAt: 0,
      };
      this.members.set(HUMAN_MEMBER_ID, member);
    }
    return member;
  }

  leave(participantId: string): boolean {
    const removed = this.members.delete(participantId);
    if (removed && this.turn?.participantId === participantId) {
      this.turn = this.makeTurn(this.nextSpeakerAfter(participantId), Date.now());
    }
    if (removed) {
      this.onChange?.();
    }
    return removed;
  }

  touch(participantId: string, now: number): void {
    const member = this.members.get(participantId);
    if (member) {
      member.lastSeenAt = now;
    }
  }

  // -- messaging ------------------------------------------------------------

  /**
   * A member speaks. All gate checks happen before anything mutates, so a
   * refused send leaves neither message, hop, nor turn behind.
   */
  sendMessage(
    member: ChatMember,
    text: string,
    options: { to?: string; replyTo?: string } = {},
    now: number,
  ): ChatMessage {
    if (this.phase === 'closed') {
      throw new ChatError('ROOM_CLOSED', `Chat room "${this.id}" is closed.`);
    }
    if (this.phase === 'paused' && member.kind === 'agent') {
      throw new ChatError(
        'ROOM_PAUSED',
        'The room is paused; wait for the host to resume it.',
      );
    }

    this.settleExpiredTurn(now);

    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new ChatError('INVALID_REQUEST', 'Message text must not be empty.');
    }
    if (trimmed.length > this.policy.maxMessageChars) {
      throw new ChatError(
        'MESSAGE_TOO_LONG',
        `Message is ${trimmed.length} characters; the limit is ${this.policy.maxMessageChars}.`,
      );
    }

    // An explicit `to` must name a seated agent — humans never hold turns.
    let target: ChatMember | null = null;
    if (options.to !== undefined) {
      target = this.resolveTarget(options.to);
      if (target.kind !== 'agent') {
        throw new ChatError(
          'INVALID_REQUEST',
          `"to" must name an agent member; "${target.name}" does not hold turns.`,
        );
      }
    }

    if (member.kind === 'agent') {
      if (
        this.turn !== null &&
        this.turn.participantId !== member.id
      ) {
        throw new ChatError(
          'NOT_YOUR_TURN',
          `It is ${this.turn.name}'s turn; wait_for_messages until you are asked.`,
        );
      }
      if (member.messages >= this.policy.maxMessagesPerMember) {
        // Refused, and the room moves on: the stuck member is skipped so the
        // rotation does not park on someone who cannot speak any more.
        this.postSystemMessage(
          `${member.name} 已到个人发言上限（${this.policy.maxMessagesPerMember} 条），跳过`,
          now,
        );
        this.turn = this.makeTurn(this.nextSpeakerAfter(member.id), now);
        this.onChange?.();
        this.wakeAll();
        throw new ChatError(
          'MEMBER_LIMIT_REACHED',
          `You have sent ${member.messages} messages, the per-member limit is ${this.policy.maxMessagesPerMember}. The turn moved on.`,
        );
      }
      if (this.lastText.get(member.id) === trimmed) {
        throw new ChatError(
          'DUPLICATE_MESSAGE',
          'Your last message is identical; rephrase instead of repeating.',
        );
      }
    }

    // Gates passed — the message becomes permanent.
    this.seq += 1;
    const message: ChatMessage = {
      seq: this.seq,
      id: chatMessageId(),
      roomId: this.id,
      from: member.id,
      fromName: member.name,
      ...(options.to === undefined ? {} : { to: options.to }),
      kind: 'chat',
      text: trimmed,
      ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
      hop: member.kind === 'agent' ? this.hop + 1 : 0,
      at: new Date(now).toISOString(),
    };
    this.messages.push(message);

    if (member.kind === 'agent') {
      this.hop += 1;
      member.messages += 1;
      this.consecutiveTimeouts.delete(member.id);
      this.lastText.set(member.id, trimmed);

      if (this.hop >= this.policy.maxHops) {
        this.postSystemMessage(
          `hop 预算已用完（${this.hop}/${this.policy.maxHops}），房间暂停，等主持人恢复`,
          now,
        );
        this.phase = 'paused';
        this.turn = null;
      } else {
        this.turn = this.makeTurn(
          target ?? this.nextSpeakerAfter(member.id),
          now,
        );
      }
    } else {
      // The host interjected. An explicit `to` redirects the conversation;
      // otherwise a live turn keeps running and an idle room gets its first
      // speaker — the least surprising reading of "interrupt". Speaking into
      // a paused room delivers the message to parked waiters but agents stay
      // gated until resume.
      if (target) {
        this.turn = this.makeTurn(target, now);
      } else if (this.turn === null) {
        this.turn = this.makeTurn(this.nextSpeakerAfter(), now);
      }
    }

    this.onChange?.();
    this.wakeAll();
    return message;
  }

  /** Host control. Idempotent while the phase already matches. */
  pause(now: number): void {
    if (this.phase === 'closed') {
      throw new ChatError('ROOM_CLOSED', `Chat room "${this.id}" is closed.`);
    }
    if (this.phase === 'paused') {
      return;
    }
    this.phase = 'paused';
    this.turn = null;
    this.postSystemMessage('房间已暂停', now);
    this.onChange?.();
    this.wakeAll();
  }

  resume(now: number): void {
    if (this.phase === 'closed') {
      throw new ChatError('ROOM_CLOSED', `Chat room "${this.id}" is closed.`);
    }
    if (this.phase === 'open') {
      return;
    }
    this.phase = 'open';
    // Rotation restarts from the top: whatever lease was interrupted is gone.
    this.turn = null;
    this.postSystemMessage('房间已恢复', now);
    this.onChange?.();
    this.wakeAll();
  }

  close(now: number): void {
    if (this.phase === 'closed') {
      return;
    }
    this.phase = 'closed';
    this.turn = null;
    this.postSystemMessage('房间已关闭', now);
    this.onChange?.();
    this.wakeAll();
  }

  // -- waiting (the long-poll) ----------------------------------------------

  /**
   * Park until a message arrives, the turn reaches this member, the phase
   * moves, or the timeout elapses. Really parked — a Set of waiters resolved
   * by mutations, the same shape as the game rooms' wait_for_seat. MCP has
   * no push, so an agent that is not parked here is simply not reachable.
   */
  wait(
    participantId: string,
    afterSeq: number,
    timeoutMs: number,
    now: number,
  ): Promise<WaitOutcome> {
    const member = this.members.get(participantId);
    if (!member) {
      throw new ChatError(
        'MEMBER_NOT_FOUND',
        'You are not a member of this room; join_room first.',
      );
    }
    this.touch(participantId, now);
    this.settleExpiredTurn(now);

    if (this.hasWakeup(participantId, afterSeq)) {
      return Promise.resolve({ timedOut: false });
    }
    if (this.phase === 'closed') {
      return Promise.resolve({ timedOut: false });
    }

    return new Promise<WaitOutcome>((resolve) => {
      const waiter: Waiter = {
        participantId,
        afterSeq,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve({ timedOut: true });
        }, timeoutMs),
        resolve: (timedOut) => {
          clearTimeout(waiter.timer);
          resolve({ timedOut });
        },
      };
      this.waiters.add(waiter);
    });
  }

  /** Would a wait with this cursor return immediately? */
  private hasWakeup(participantId: string, afterSeq: number): boolean {
    if (this.seq > afterSeq) {
      return true;
    }
    if (this.phase !== 'open') {
      return true;
    }
    return this.turn?.participantId === participantId;
  }

  private wakeAll(): void {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter.resolve(false);
    }
  }

  // -- turn helpers -----------------------------------------------------------

  /**
   * Expired leases settle on the next touch (send / wait), not on a timer:
   * the room has no background clock, and snapshot() stays a pure read. A
   * waiter parked across the deadline wakes at its own poll timeout and
   * settles on the next call.
   */
  settleExpiredTurn(now: number): void {
    if (this.phase !== 'open' || this.turn === null) {
      return;
    }
    if (this.turn.expiresAt > now) {
      return;
    }

    const expired = this.turn;
    const member = this.members.get(expired.participantId);
    const name = member?.name ?? expired.name;
    const streak = (this.consecutiveTimeouts.get(expired.participantId) ?? 0) + 1;
    this.consecutiveTimeouts.set(expired.participantId, streak);

    if (streak >= 2) {
      this.postSystemMessage(
        `${name} 连续第 ${streak} 次超时，房间暂停，等主持人恢复`,
        now,
      );
      this.phase = 'paused';
      this.turn = null;
      this.onChange?.();
      this.wakeAll();
      return;
    }

    this.postSystemMessage(`${name} 超时，跳过`, now);
    this.turn = this.makeTurn(this.nextSpeakerAfter(expired.participantId), now);
    this.onChange?.();
    this.wakeAll();
  }

  /** Agents only, in join order. `after` the given member, wrapping around. */
  nextSpeakerAfter(after?: string): ChatMember | null {
    const agents = [...this.members.values()].filter(
      (member) => member.kind === 'agent',
    );
    if (agents.length === 0) {
      return null;
    }
    if (after === undefined) {
      return agents[0]!;
    }
    const index = agents.findIndex((member) => member.id === after);
    if (index === -1) {
      return agents[0]!;
    }
    return agents[(index + 1) % agents.length]!;
  }

  private makeTurn(member: ChatMember | null, now: number): ChatTurn | null {
    if (!member) {
      return null;
    }
    return {
      participantId: member.id,
      name: member.name,
      expiresAt: now + this.policy.turnTimeoutMs,
    };
  }

  private resolveTarget(to: string): ChatMember {
    const byId = this.members.get(to);
    if (byId) {
      return byId;
    }
    const byName = [...this.members.values()].find(
      (member) => member.name === to,
    );
    if (byName) {
      return byName;
    }
    throw new ChatError(
      'MEMBER_NOT_FOUND',
      `No member "${to}" in this room; check the member list in the snapshot.`,
    );
  }

  private postSystemMessage(text: string, now: number): void {
    this.seq += 1;
    this.messages.push({
      seq: this.seq,
      id: chatMessageId(),
      roomId: this.id,
      from: 'system',
      fromName: 'system',
      kind: 'system',
      text,
      hop: 0,
      at: new Date(now).toISOString(),
    });
  }

  // -- views ----------------------------------------------------------------

  snapshot(): ChatRoomSnapshot {
    return {
      id: this.id,
      title: this.title,
      phase: this.phase,
      policy: { ...this.policy },
      seq: this.seq,
      hop: this.hop,
      turn: this.turn ? { ...this.turn } : null,
      members: [...this.members.values()].map((member) => ({ ...member })),
      messageCount: this.messages.length,
      createdAt: this.createdAt,
    };
  }

  recentMessages(limit: number): ChatMessage[] {
    return this.messages.slice(-limit).map(cloneMessage);
  }

  messagesAfter(afterSeq: number, limit: number): ChatMessage[] {
    return this.messages
      .filter((message) => message.seq > afterSeq)
      .slice(-limit)
      .map(cloneMessage);
  }

  /**
   * A transcript slice. Everything before `afterSeq` (or before the kept
   * window) is counted, not returned — the caller renders the omission.
   */
  transcript(options: { limit?: number; afterSeq?: number } = {}): {
    messages: ChatMessage[];
    omitted: number;
  } {
    const pool =
      options.afterSeq === undefined
        ? this.messages
        : this.messages.filter((message) => message.seq > options.afterSeq!);
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const kept = pool.slice(-limit);
    return {
      messages: kept.map(cloneMessage),
      omitted: pool.length - kept.length,
    };
  }

  toSnapshotFile(): ChatRoomSnapshotFile {
    const timeouts: Record<string, number> = {};
    for (const [id, count] of this.consecutiveTimeouts) {
      timeouts[id] = count;
    }
    return {
      id: this.id,
      title: this.title,
      phase: this.phase,
      policy: { ...this.policy },
      seq: this.seq,
      hop: this.hop,
      createdAt: this.createdAt,
      members: [...this.members.values()].map((member) => ({ ...member })),
      messages: this.messages.map(cloneMessage),
      consecutiveTimeouts: timeouts,
    };
  }

  /** Rebuild from a persisted file. Turn leases never survive a restart. */
  static fromSnapshotFile(file: ChatRoomSnapshotFile): ChatRoom {
    const room = new ChatRoom(file.id, file.title, file.policy, file.createdAt);
    room.phase = file.phase;
    room.seq = file.seq;
    room.hop = file.hop;
    for (const member of file.members) {
      room.members.set(member.id, { ...member });
    }
    for (const message of file.messages) {
      room.messages.push(cloneMessage(message));
      if (message.kind === 'chat') {
        room.lastText.set(message.from, message.text);
      }
    }
    for (const [id, count] of Object.entries(file.consecutiveTimeouts ?? {})) {
      room.consecutiveTimeouts.set(id, count);
    }
    return room;
  }
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return { ...message };
}
