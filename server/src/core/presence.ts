import {
  PRESENCE_SESSION_IDLE_MS,
  PRESENCE_STALE_MS,
  computePresence,
  type ParticipantView,
  type PlayerSpec,
  type StoneColor,
} from '@gomoku/shared';

/**
 * Raw connection evidence for one seat.
 *
 * P1a keys signals by seat; P1b moves the key to participant id when seats
 * become participants.
 */
interface SeatSignals {
  /** MCP sessions currently attached to this seat, with their last activity. */
  sessions: Map<string, number>;
  /**
   * Whether an MCP session ever attached here. Once one has, its expiry is a
   * confirmed disconnect; only clients that never had a session (the stdio
   * bridge) fall back to recent-call freshness.
   */
  sessionSeen: boolean;
  /** Long-polls parked on this seat. */
  waits: number;
  /** Epoch ms of the last evidence for this seat, or null when never seen. */
  lastSeenAt: number | null;
  /** MCP clientInfo name reported by the agent, when it reported one. */
  client?: string;
}

/**
 * What the rest of the server may ask of a presence source.
 *
 * Transport layers register evidence (viewer, session, parked wait); rooms ask
 * for the rendered participant list. Tests can supply a stub implementing only
 * what they exercise.
 */
export interface PresenceSource {
  attachViewer(roomId: string): () => void;
  attachSession(roomId: string, seat: StoneColor, sessionId: string, client?: string): void;
  detachSession(sessionId: string): void;
  touch(roomId: string, seat: StoneColor, client?: string): void;
  beginWait(roomId: string, seat: StoneColor): () => void;
  clearRoom(roomId: string): void;
  snapshot(input: {
    roomId: string;
    seats: Record<StoneColor, PlayerSpec>;
    turn: StoneColor | null;
    playing: boolean;
  }): ParticipantView[];
}

export type PresenceListener = (roomId: string) => void;

/** Display label for a seat: its declared name, else 你 / AI. */
export function seatLabel(seat: StoneColor, spec: PlayerSpec): string {
  if (spec.name && spec.name.length > 0) {
    return spec.name;
  }
  if (spec.kind === 'agent') {
    return 'AI';
  }
  if (spec.kind === 'human') {
    return '你';
  }
  return seat === 'black' ? '黑方' : '白方';
}

function emptySeat(): SeatSignals {
  return { sessions: new Map(), sessionSeen: false, waits: 0, lastSeenAt: null };
}

/**
 * Tracks who is attached to each seat and turns that into presence.
 *
 * Signals are registered by the transport layers instead of being inferred
 * here, so game logic never has to guess whether a quiet player is thinking or
 * gone:
 *
 * - a browser tab watches the **room**, not a seat — the human may switch from
 *   black to white between games, and the tab keeps watching either way
 * - an MCP session binds to the seat it plays in
 * - a parked long-poll is the strongest evidence of life
 *
 * Every mutation notifies listeners; the broadcaster deduplicates by comparing
 * the rendered participant list, so a chatty `touch` costs nothing on the wire.
 */
export class PresenceRegistry implements PresenceSource {
  private readonly seats = new Map<string, SeatSignals>();
  /** Browser tabs watching each room. Room-level on purpose: see above. */
  private readonly viewers = new Map<string, number>();
  /** When each room last had a tab watching it, so a closed tab reads as seen. */
  private readonly watchedAt = new Map<string, number>();
  private readonly listeners = new Set<PresenceListener>();
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly sessionIdleMs: number;

  constructor(
    options: {
      now?: () => number;
      staleAfterMs?: number;
      sessionIdleMs?: number;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.staleAfterMs = options.staleAfterMs ?? PRESENCE_STALE_MS;
    // An MCP session is refreshed by every call it makes, including a parked
    // long-poll. One that stays silent longer than this is treated as gone:
    // the SDK's client.close() does not notify the server, so a vanished
    // client only ever shows up as silence.
    this.sessionIdleMs = options.sessionIdleMs ?? PRESENCE_SESSION_IDLE_MS;
  }

  /**
   * Register a browser tab watching this room; returns the detach function.
   *
   * Deliberately room-scoped: whoever the human plays as, the tab is watching.
   */
  attachViewer(roomId: string): () => void {
    this.viewers.set(roomId, (this.viewers.get(roomId) ?? 0) + 1);
    this.watchedAt.set(roomId, this.now());
    this.emit(roomId);

    let detached = false;
    return () => {
      if (detached) {
        return;
      }
      detached = true;
      this.watchedAt.set(roomId, this.now());
      const remaining = Math.max(0, (this.viewers.get(roomId) ?? 1) - 1);
      if (remaining === 0) {
        this.viewers.delete(roomId);
      } else {
        this.viewers.set(roomId, remaining);
      }
      this.emit(roomId);
    };
  }

  /** Register an MCP session attached to a seat. Idempotent per session id. */
  attachSession(
    roomId: string,
    seat: StoneColor,
    sessionId: string,
    client?: string,
  ): void {
    const signals = this.ensure(roomId, seat);
    const known = signals.sessions.has(sessionId);
    signals.sessions.set(sessionId, this.now());
    signals.sessionSeen = true;
    signals.lastSeenAt = this.now();
    if (client) {
      signals.client = client;
    }
    if (!known) {
      this.emit(roomId);
    }
  }

  /**
   * Remove a session from every seat it attached to.
   *
   * Only the `DELETE /mcp` path reaches here: the SDK's `client.close()` aborts
   * its own connection without telling the server, so a session that simply
   * stops calling is expired by the idle window instead.
   */
  detachSession(sessionId: string): void {
    for (const [key, signals] of this.seats) {
      if (signals.sessions.delete(sessionId)) {
        signals.lastSeenAt = this.now();
        this.emit(roomOf(key));
      }
    }
  }

  /** Record activity on a seat without changing its connection set. */
  touch(roomId: string, seat: StoneColor, client?: string): void {
    const signals = this.ensure(roomId, seat);
    signals.lastSeenAt = this.now();
    if (client) {
      signals.client = client;
    }
    this.emit(roomId);
  }

  /** Mark a long-poll as parked on a seat; returns the release function. */
  beginWait(roomId: string, seat: StoneColor): () => void {
    const signals = this.ensure(roomId, seat);
    signals.waits += 1;
    signals.lastSeenAt = this.now();
    this.emit(roomId);

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const current = this.seats.get(keyOf(roomId, seat));
      if (!current) {
        return;
      }
      current.waits = Math.max(0, current.waits - 1);
      current.lastSeenAt = this.now();
      this.emit(roomId);
    };
  }

  /** Forget every signal for a room (used when a room is deleted). */
  clearRoom(roomId: string): void {
    for (const key of [...this.seats.keys()]) {
      if (roomOf(key) === roomId) {
        this.seats.delete(key);
      }
    }
    this.viewers.delete(roomId);
    this.watchedAt.delete(roomId);
  }

  snapshot(input: {
    roomId: string;
    seats: Record<StoneColor, PlayerSpec>;
    turn: StoneColor | null;
    playing: boolean;
  }): ParticipantView[] {
    const now = this.now();
    const watchers = this.viewers.get(input.roomId) ?? 0;
    const watchedAt = this.watchedAt.get(input.roomId) ?? null;
    const views: ParticipantView[] = [];

    for (const seat of ['black', 'white'] as const) {
      const spec = input.seats[seat];
      const signals = this.seats.get(keyOf(input.roomId, seat));
      const isTurn = input.playing && input.turn === seat;
      const waiting = (signals?.waits ?? 0) > 0;

      // A human seat exists only while a browser tab is open: a REST call is
      // never proof that somebody is looking at the board. Its "last seen" is
      // therefore the last time a tab watched this room, not a call stamp.
      //
      // An agent seat is connected while a *live* MCP session is attached. A
      // session goes live again on every call, and expires once it stops
      // calling for the idle window — the SDK's client.close() never sends a
      // DELETE, so silence is the only signal a vanished client gives us.
      //
      // A client that never opened a session at all (the stdio bridge, which
      // lives in another process) falls back to recent-call freshness.
      const lastSeenAt =
        spec.kind === 'human'
          ? (watchedAt ?? signals?.lastSeenAt ?? null)
          : (signals?.lastSeenAt ?? null);

      const liveSessions = signals
        ? [...signals.sessions.values()].filter(
            (at) => now - at <= this.sessionIdleMs,
          ).length
        : 0;

      const connected =
        spec.kind === 'human'
          ? watchers > 0
          : liveSessions > 0 ||
            (!(signals?.sessionSeen ?? false) &&
              lastSeenAt !== null &&
              now - lastSeenAt <= this.staleAfterMs);

      views.push({
        seat,
        kind: spec.kind,
        label: seatLabel(seat, spec),
        presence: computePresence({
          connected,
          waiting,
          lastSeenAt,
          isTurn,
        }),
        ...(signals?.client === undefined ? {} : { client: signals.client }),
        lastSeenAt,
        waiting,
        isTurn,
      });
    }

    return views;
  }

  /** Subscribe to "presence may have changed" notifications. */
  onChange(listener: PresenceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Re-evaluate seats whose evidence aged out so the UI can flip them to
   * disconnected. Runs on a timer; never touches game logic.
   *
   * Two windows matter: a session that stopped calling expires at
   * `sessionIdleMs`, while a seat with no session at all expires at
   * `staleAfterMs`. Both only change what the UI shows.
   */
  sweep(): void {
    const now = this.now();
    const dirty = new Set<string>();

    for (const [key, signals] of this.seats) {
      const roomId = roomOf(key);
      if (signals.waits > 0) {
        continue;
      }
      if ((this.viewers.get(roomId) ?? 0) > 0) {
        continue;
      }

      // Drop sessions that have gone quiet, so they stop counting as attached.
      let expired = false;
      for (const [id, at] of signals.sessions) {
        if (now - at > this.sessionIdleMs) {
          signals.sessions.delete(id);
          expired = true;
        }
      }
      if (expired) {
        dirty.add(roomId);
        continue;
      }

      if (signals.sessions.size > 0) {
        continue;
      }
      if (signals.lastSeenAt === null) {
        continue;
      }
      if (now - signals.lastSeenAt > this.staleAfterMs) {
        dirty.add(roomId);
      }
    }

    for (const roomId of dirty) {
      this.emit(roomId);
    }
  }

  private ensure(roomId: string, seat: StoneColor): SeatSignals {
    const key = keyOf(roomId, seat);
    let signals = this.seats.get(key);
    if (!signals) {
      signals = emptySeat();
      this.seats.set(key, signals);
    }
    return signals;
  }

  private emit(roomId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(roomId);
      } catch (error) {
        console.error('[presence] listener failed', error);
      }
    }
  }
}

const SEP = '\u0000';

function keyOf(roomId: string, seat: StoneColor): string {
  return `${roomId}${SEP}${seat}`;
}

function roomOf(key: string): string {
  const index = key.indexOf(SEP);
  return index === -1 ? key : key.slice(0, index);
}
