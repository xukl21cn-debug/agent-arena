import { randomUUID } from 'node:crypto';
import type {
  Participant,
  ParticipantKind,
  StoneColor,
} from '@arena/shared';

/** Short, readable id: `p_3f9a2c`. Room-scoped, never reused. */
function newId(): string {
  return `p_${randomUUID().replaceAll('-', '').slice(0, 6)}`;
}

/** Trim and clamp a display name so a room header stays readable. */
function normalizeName(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  return Array.from(trimmed).slice(0, 24).join('');
}

export interface SeatRequest {
  name?: string;
  kind: ParticipantKind;
  seat?: StoneColor | null;
  /** Ready-to-start flag, so a joining client can seat and ready in one step. */
  ready?: boolean;
  client?: string;
  now?: number;
}

/**
 * Who is in a room, and who holds which seat.
 *
 * The roster exists because a seat alone stopped being an identity: with two
 * agents in a room both seats say `kind: 'agent'`, so routing a move needs an
 * id, not a kind. It is deliberately separate from `GameRoom`'s game state —
 * a participant outlives a game (you keep your name and seat across rematches)
 * while `GameState` is replaced every game.
 *
 * Joining is idempotent per name: reconnecting with the same name reuses the
 * record, which is what lets an agent recover its seat after a restart.
 */
export class ParticipantRoster {
  private readonly byId = new Map<string, Participant>();

  /** Everyone in the room, in join order. */
  list(): Participant[] {
    return [...this.byId.values()];
  }

  get(id: string): Participant | undefined {
    return this.byId.get(id);
  }

  /** The participant holding a seat, if any. */
  bySeat(seat: StoneColor): Participant | undefined {
    for (const participant of this.byId.values()) {
      if (participant.seat === seat) {
        return participant;
      }
    }
    return undefined;
  }

  /** Every participant of a kind; two agents in a room make this length 2. */
  byKind(kind: ParticipantKind): Participant[] {
    return this.list().filter((participant) => participant.kind === kind);
  }

  /**
   * Join, or reconnect when the name is already present.
   *
   * A reconnect refreshes `lastSeenAt` and adopts the newly supplied client or
   * seat, so a client that reconnects with a different color moves rather than
   * fighting its old record.
   */
  join(request: SeatRequest): Participant {
    const existing = this.byName(request.name ?? '');
    if (existing) {
      existing.lastSeenAt = request.now ?? Date.now();
      if (request.client !== undefined) {
        existing.client = request.client;
      }
      if (request.seat !== undefined) {
        this.assignSeat(existing, request.seat);
      }
      if (request.ready !== undefined) {
        existing.ready = request.ready;
      }
      return existing;
    }

    const id = newId();
    const participant: Participant = {
      id,
      name: normalizeName(request.name ?? '', defaultName(request.kind, this)),
      kind: request.kind,
      seat: null,
      ready: request.ready ?? false,
      lastSeenAt: request.now ?? Date.now(),
      joinedAt: new Date(request.now ?? Date.now()).toISOString(),
      ...(request.client === undefined ? {} : { client: request.client }),
    };

    this.byId.set(id, participant);
    if (request.seat !== undefined) {
      this.assignSeat(participant, request.seat);
    }
    return participant;
  }

  /**
   * Flip a participant's ready flag. False when the id is unknown — the room
   * turns that into the participant-not-found error; the roster knows no
   * error codes.
   */
  setReady(id: string, ready: boolean): boolean {
    const participant = this.byId.get(id);
    if (!participant) {
      return false;
    }
    participant.ready = ready;
    return true;
  }

  /** Leave the room; frees the seat for somebody else. */
  leave(id: string): boolean {
    const participant = this.byId.get(id);
    if (!participant) {
      return false;
    }
    this.byId.delete(id);
    return true;
  }

  /**
   * Seat a participant, evicting whoever held that seat.
   *
   * Eviction rather than rejection is what makes "add an AI opponent" work:
   * the new participant takes the color, and the displaced one is unseated
   * (kept in the room, seatless) so it can claim the other color.
   */
  assignSeat(participant: Participant, seat: StoneColor | null): void {
    if (seat !== null) {
      const holder = this.bySeat(seat);
      if (holder && holder.id !== participant.id) {
        holder.seat = null;
      }
    }
    participant.seat = seat;
  }

  /** Names must be unique; a duplicate join is a reconnect, not a new person. */
  private byName(name: string): Participant | undefined {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    for (const participant of this.byId.values()) {
      if (participant.name === trimmed) {
        return participant;
      }
    }
    return undefined;
  }
}

/** `dsh`, `dsh-2`, … so two agents of the same client stay distinguishable. */
function defaultName(kind: ParticipantKind, roster: ParticipantRoster): string {
  const base = kind === 'agent' ? 'agent' : kind === 'human' ? 'human' : 'guest';
  let index = roster.byKind(kind).length + 1;
  let candidate = index === 1 ? base : `${base}-${index}`;
  while (roster.list().some((participant) => participant.name === candidate)) {
    index += 1;
    candidate = `${base}-${index}`;
  }
  return candidate;
}
