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

/**
 * How many yields in a row, with no message in between, pause the room.
 *
 * `pass_turn` costs no hop, resets the passer's timeout streak and posts only a
 * system line, so two agents that both think the host should speak would
 * otherwise trade the turn forever. Six yields is three full rounds for a
 * two-agent room — long enough that a polite hand-off is never punished.
 */
const PASS_PAUSE_THRESHOLD = 6;

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
 * learns about mutations through {@link ChatRoom.subscribe | subscribe}.
 *
 * Relay turn rules (the v1 policy):
 *  - an agent may speak only when the turn is unset or points at it;
 *  - an agent on turn may pass instead of speaking: the turn moves on the
 *    same way, without burning a hop, leaving a system trace behind; passing
 *    with `to: "human"` (or as the only agent) hands control back to the host,
 *    and six yields in a row with no message pause the room;
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
  /** Mutable through setPolicy; read through the getter below. */
  private policyValue: ChatPolicy;
  seq = 0;
  hop = 0;
  readonly createdAt: string;
  turn: ChatTurn | null = null;

  get policy(): ChatPolicy {
    return this.policyValue;
  }

  /** Insertion order is the rotation order. */
  readonly members = new Map<string, ChatMember>();
  readonly messages: ChatMessage[] = [];
  private readonly consecutiveTimeouts = new Map<string, number>();
  /** Yields in a row with no chat message between them; see passTurn. */
  private consecutivePasses = 0;
  /** Last chat text per member, for the duplicate-message rule. */
  private readonly lastText = new Map<string, string>();
  private readonly waiters = new Set<Waiter>();
  /**
   * Members whose session dropped and has not come back. A gone member is
   * skipped by rotation and never assigned a turn — a turn parked on an
   * exited member can only burn lease timeouts. Any tool call (touch) or a
   * fresh join revives the member; this is session state, never persisted.
   */
  private readonly goneMembers = new Set<string>();

  constructor(
    id: string,
    title: string,
    policy: ChatPolicy,
    createdAt = new Date().toISOString(),
  ) {
    this.id = id;
    this.title = title;
    this.policyValue = policy;
    this.createdAt = createdAt;
  }

  /**
   * Mutation listeners — the manager persists through one, /ws broadcasts
   * through another. This is a set on purpose: the single-slot `onChange` it
   * replaced was silently overwritten when a second owner subscribed, and
   * persistence died without any test noticing.
   */
  private readonly changeListeners = new Set<() => void>();

  /** Register a mutation listener; the returned fn detaches it again. */
  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private emitChange(): void {
    for (const listener of [...this.changeListeners]) {
      listener();
    }
  }

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
      // A fresh join is a fresh session: the member is drivable again.
      this.goneMembers.delete(existing.id);
      if (client !== undefined) {
        existing.client = client;
      }
      this.emitChange();
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
    this.emitChange();
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
      this.emitChange();
    }
    return removed;
  }

  touch(participantId: string, now: number): void {
    const member = this.members.get(participantId);
    if (member) {
      member.lastSeenAt = now;
      // Any call proves a live session behind the member again.
      this.goneMembers.delete(participantId);
    }
  }

  /**
   * The live member record, not a detached copy — callers that go on to
   * mutate the member (sendMessage's counters) must hold this one. A
   * snapshot member is a clone, and writes to it are silently lost.
   */
  memberRef(participantId: string): ChatMember | undefined {
    return this.members.get(participantId);
  }

  /**
   * A member's session dropped: nobody can drive it any more. The record
   * stays (a reconnect reclaims it via join), but the member leaves the
   * rotation and — if the turn is parked on it — hands it back at once: to
   * the next member still around, or to the host. Without this the turn
   * burns a full lease per dead member before the pause kicks in.
   */
  memberGone(participantId: string, now: number): void {
    const member = this.members.get(participantId);
    if (!member || member.kind !== 'agent') {
      return;
    }
    this.goneMembers.add(participantId);
    this.consecutiveTimeouts.delete(participantId);
    if (this.turn?.participantId !== participantId) {
      return;
    }
    const next = this.nextSpeakerAfter(participantId);
    if (next === null) {
      this.postSystemMessage(`${member.name} 的轮次已交还给主持人`, now);
      this.turn = null;
    } else {
      this.postSystemMessage(`${member.name} 的轮次已交给 ${next.name}`, now);
      this.turn = this.makeTurn(next, now);
    }
    this.emitChange();
    this.wakeAll();
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
    let goneTargetName: string | undefined;
    if (options.to !== undefined) {
      const resolved = this.resolveTarget(options.to);
      if (resolved.kind !== 'agent') {
        throw new ChatError(
          'INVALID_REQUEST',
          `"to" must name an agent member; "${resolved.name}" does not hold turns.`,
        );
      }
      if (this.goneMembers.has(resolved.id)) {
        // Skip a member whose session dropped instead of silently turning
        // the room idle; the line below explains why the target was skipped.
        goneTargetName = resolved.name;
      } else {
        target = resolved;
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
      // Acting proves a live session behind the member (revives after a gone
      // mark); `touch` records it and clears the flag in one place.
      this.touch(member.id, now);
      if (member.messages >= this.policy.maxMessagesPerMember) {
        // Refused, and the room moves on: the stuck member is skipped so the
        // rotation does not park on someone who cannot speak any more.
        this.postSystemMessage(
          `${member.name} 已到个人发言上限（${this.policy.maxMessagesPerMember} 条），跳过`,
          now,
        );
        this.turn = this.makeTurn(this.nextSpeakerAfter(member.id), now);
        this.emitChange();
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
    // Somebody actually said something: the pass-loop guard starts over.
    this.consecutivePasses = 0;
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

    if (goneTargetName !== undefined) {
      this.postSystemMessage(`${goneTargetName} 当前无法接轮，跳过`, now);
    }

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

    this.emitChange();
    this.wakeAll();
    return message;
  }

  /**
   * Yield the speaking turn without speaking. The rotation moves on, a
   * system message records why, and the passer's timeout streak resets —
   * an agent awake enough to yield is not timing out. Nothing else moves:
   * no hop, no chat message, no member counter.
   *
   * Unlike sendMessage, a room with no live turn is refused outright: a
   * turn is claimed by speaking, and there is nothing to yield.
   */
  passTurn(member: ChatMember, to: string | undefined, now: number): ChatTurn | null {
    if (this.phase === 'closed') {
      throw new ChatError('ROOM_CLOSED', `Chat room "${this.id}" is closed.`);
    }
    if (this.phase === 'paused') {
      throw new ChatError(
        'ROOM_PAUSED',
        'The room is paused; wait for the host to resume it.',
      );
    }

    this.settleExpiredTurn(now);

    if (this.turn === null) {
      throw new ChatError(
        'INVALID_REQUEST',
        'There is no live turn to yield; speak with send_message to claim one.',
      );
    }

    let target: ChatMember | null = null;
    if (to !== undefined) {
      target = this.resolveTarget(to);
      // Handing the turn back to the host is how an agent says "you decide
      // next". Without it, two agents that both wait for the human can only
      // push the turn at each other.
      if (target.kind !== 'agent' && target.id !== HUMAN_MEMBER_ID) {
        throw new ChatError(
          'INVALID_REQUEST',
          `"to" must name an agent member or the host; "${target.name}" does not hold turns.`,
        );
      }
      if (target.id === member.id) {
        throw new ChatError(
          'INVALID_REQUEST',
          '"to" must name another member; yielding to yourself changes nothing.',
        );
      }
    }

    if (this.turn.participantId !== member.id) {
      throw new ChatError(
        'NOT_YOUR_TURN',
        `It is ${this.turn.name}'s turn; wait_for_messages until you are asked.`,
      );
    }

    this.consecutiveTimeouts.delete(member.id);

    // Guard against A→B→A→B yields: nothing was said, so nothing earned a hop,
    // and the transcript would fill with system lines while the room spins.
    this.consecutivePasses += 1;
    if (this.consecutivePasses >= PASS_PAUSE_THRESHOLD) {
      this.postSystemMessage(
        `连续 ${this.consecutivePasses} 次让出轮次都没人发言，房间暂停，等主持人安排`,
        now,
      );
      this.phase = 'paused';
      this.turn = null;
      this.emitChange();
      this.wakeAll();
      return null;
    }

    if (target?.kind === 'human') {
      this.postSystemMessage(`${member.name} 把轮次交还给主持人`, now);
      this.turn = null;
    } else if (target && this.goneMembers.has(target.id)) {
      // Naming a member whose session dropped cannot park the turn there.
      this.postSystemMessage(
        `${target.name} 当前无法接轮，${member.name} 把轮次交还给主持人`,
        now,
      );
      this.turn = null;
    } else {
      const next = target ?? this.nextSpeakerAfter(member.id);
      if (next === null || next.id === member.id) {
        // The only agent in the room yielding: wait for the host instead of
        // handing the lease straight back to itself (which did nothing but
        // post a line and reset the clock).
        this.postSystemMessage(`${member.name} 让出轮次，等主持人`, now);
        this.turn = null;
      } else {
        this.postSystemMessage(
          target
            ? `${member.name} 把轮次交给 ${next.name}`
            : `${member.name} 让出轮次`,
          now,
        );
        this.turn = this.makeTurn(next, now);
      }
    }
    this.emitChange();
    this.wakeAll();
    return this.turn;
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
    this.emitChange();
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
    // A manual resume is the host saying "start over". Keeping the streak makes
    // the pause sticky: with a congested provider the next single timeout would
    // be strike three and pause the room again on one strike.
    this.consecutiveTimeouts.clear();
    this.consecutivePasses = 0;
    this.postSystemMessage('房间已恢复', now);
    this.emitChange();
    this.wakeAll();
  }

  close(now: number): void {
    if (this.phase === 'closed') {
      return;
    }
    this.phase = 'closed';
    this.turn = null;
    this.postSystemMessage('房间已关闭', now);
    this.emitChange();
    this.wakeAll();
  }

  /**
   * Host tuning of the caps that stop a room.
   *
   * Raising `maxHops` above the consumed hop is the only way out of a
   * budget-paused room: `resume()` alone would pause again on the very next
   * message, because the budget is still spent. So exactly that case resumes by
   * itself, and a room the host paused by hand stays paused.
   *
   * Lowering a cap under what was already consumed is refused rather than
   * accepted-then-immediately-violated.
   */
  setPolicy(patch: Partial<ChatPolicy>, now: number): void {
    if (this.phase === 'closed') {
      throw new ChatError('ROOM_CLOSED', `Chat room "${this.id}" is closed.`);
    }

    const next: ChatPolicy = { ...this.policyValue, ...patch };
    if (next.maxHops < this.hop) {
      throw new ChatError(
        'INVALID_REQUEST',
        `maxHops 不能低于已用 hop（${this.hop}）。`,
      );
    }
    const busiest = Math.max(
      0,
      ...[...this.members.values()].map((member) => member.messages),
    );
    if (next.maxMessagesPerMember < busiest) {
      throw new ChatError(
        'INVALID_REQUEST',
        `maxMessagesPerMember 不能低于已有成员发言数（${busiest}）。`,
      );
    }

    // Only a pause that the spent budget caused is lifted here; a manual pause
    // is the host's decision and survives a budget change.
    const wasBudgetPaused =
      this.phase === 'paused' && this.hop >= this.policyValue.maxHops;

    const changes: string[] = [];
    if (next.maxHops !== this.policyValue.maxHops) {
      changes.push(`hop 预算 ${this.policyValue.maxHops} → ${next.maxHops}`);
    }
    if (next.maxMessagesPerMember !== this.policyValue.maxMessagesPerMember) {
      changes.push(
        `每人发言上限 ${this.policyValue.maxMessagesPerMember} → ${next.maxMessagesPerMember}`,
      );
    }
    this.policyValue = next;

    if (changes.length > 0) {
      this.postSystemMessage(`主持人调整：${changes.join('，')}`, now);
    }
    if (wasBudgetPaused && this.hop < next.maxHops) {
      this.phase = 'open';
      this.turn = null;
      this.postSystemMessage('预算已调高，房间继续', now);
    }

    this.emitChange();
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
      this.emitChange();
      this.wakeAll();
      return;
    }

    this.postSystemMessage(`${name} 超时，跳过`, now);
    this.turn = this.makeTurn(this.nextSpeakerAfter(expired.participantId), now);
    this.emitChange();
    this.wakeAll();
  }

  /** Agents only, in join order. `after` the given member, wrapping around. */
  nextSpeakerAfter(after?: string): ChatMember | null {
    const agents = [...this.members.values()].filter(
      (member) => member.kind === 'agent',
    );
    const live = agents.filter((member) => !this.goneMembers.has(member.id));
    if (live.length === 0) {
      return null;
    }
    if (after === undefined) {
      return live[0]!;
    }
    const index = agents.findIndex((member) => member.id === after);
    if (index === -1) {
      return live[0]!;
    }
    // Walk forward from `after`, skipping members whose session is gone: the
    // turn must never park on a member nobody can drive any more.
    for (let step = 1; step <= agents.length; step++) {
      const candidate = agents[(index + step) % agents.length]!;
      if (!this.goneMembers.has(candidate.id)) {
        return candidate;
      }
    }
    return null;
  }

  private makeTurn(member: ChatMember | null, now: number): ChatTurn | null {
    if (!member || this.goneMembers.has(member.id)) {
      // A gone member cannot hold a turn — waiting for the host beats
      // parking a lease on somebody who will never answer.
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

  /**
   * The room's own clock for listings: the newest message's time, falling
   * back to creation. Deliberately not member `lastSeenAt` — that says who
   * peeked, not that the room changed, and a lobby sorts by room activity.
   */
  lastActivityAt(): string {
    const last = this.messages[this.messages.length - 1];
    if (!last) {
      return this.createdAt;
    }
    // The larger of the two, so a restored file with odd data cannot make
    // a room look older than it is.
    return last.at > this.createdAt ? last.at : this.createdAt;
  }

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

  /**
   * The incremental read for wait_for_messages: unread messages oldest
   * first, capped at `limit`, plus how many unread stay behind the cap.
   * The cap keeps the head of the unread range — a catching-up client
   * advances its cursor forward, so dropping the oldest messages (the tail
   * slice a transcript wants) would lose exactly the ones it never saw.
   */
  unreadAfter(
    afterSeq: number,
    limit: number,
  ): { messages: ChatMessage[]; omitted: number } {
    const pool = this.messages.filter((message) => message.seq > afterSeq);
    const kept = pool.slice(0, limit);
    return {
      messages: kept.map(cloneMessage),
      omitted: pool.length - kept.length,
    };
  }

  /**
   * A transcript slice. Everything before `afterSeq` (or before the kept
   * window) is counted, not returned — the caller renders the omission.
   */
  transcript(options: { limit?: number; afterSeq?: number } = {}): {
    messages: ChatMessage[];
    omitted: number;
  } {
    const requested = options.limit;
    // `slice(-0)` is `slice(0)` in JS and would silently return the whole
    // history; refuse non-positive limits instead of leaking all messages.
    // An omitted limit still means "everything" for internal callers.
    if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) {
      throw new ChatError('INVALID_REQUEST', 'limit must be a positive integer.');
    }
    const limit = requested ?? Number.POSITIVE_INFINITY;
    const pool =
      options.afterSeq === undefined
        ? this.messages
        : this.messages.filter((message) => message.seq > options.afterSeq!);
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
      consecutivePasses: this.consecutivePasses,
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
    // MCP sessions never survive a server restart. Keep the member records so
    // a same-name join can reclaim its place, but keep every agent out of the
    // rotation until that join (or a tool call) proves a live session again.
    for (const member of room.members.values()) {
      if (member.kind === 'agent') {
        room.goneMembers.add(member.id);
      }
    }
    for (const saved of file.messages) {
      const { timelineOrder: _legacy, ...message } = saved as ChatMessage & { timelineOrder?: number };
      room.messages.push(cloneMessage(message));
      if (message.kind === 'chat') {
        room.lastText.set(message.from, message.text);
      }
    }
    for (const [id, count] of Object.entries(file.consecutiveTimeouts ?? {})) {
      room.consecutiveTimeouts.set(id, count);
    }
    room.consecutivePasses = file.consecutivePasses ?? 0;
    return room;
  }
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return { ...message };
}
