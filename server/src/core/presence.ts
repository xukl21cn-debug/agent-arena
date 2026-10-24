import {
  PRESENCE_STALE_MS,
  computePresence,
  type ParticipantView,
  type PlayerSpec,
  type StoneColor,
} from '@gomoku/shared';

/**
 * Raw connection evidence for one seat. Presence is derived from these, never
 * from silence alone: an attached MCP session, an open browser socket, or a
 * parked long-poll each prove the process behind a seat is alive.
 *
 * P1a keys signals by seat; P1b moves the key to participant id when seats
 * become participants.
 */
interface SeatSignals {
  /** MCP sessions currently attached to this seat. */
  sessions: Set<string>;
  /** Browser viewers currently watching this seat. */
  viewers: number;
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
  attachViewer(roomId: string, seat: StoneColor): () => void;
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
  return { sessions: new Set(), viewers: 0, waits: 0, lastSeenAt: null };
}

/**
 * Tracks who is attached to each seat and turns that into presence.
 *
 * Signals are registered by the transport layers (WS viewer, MCP session,
 * parked long-poll) instead of being inferred here, so game logic never has to
 * guess whether a quiet player is thinking or gone.
 *
 * Every mutation notifies listeners; the broadcaster deduplicates by comparing
 * the rendered participant list, so a chatty `touch` costs nothing on the wire.
 */
export class PresenceRegistry implements PresenceSource {
  private readonly seats = new Map<string, SeatSignals>();
  private readonly listeners = new Set<PresenceListener>();
  private readonly now: () => number;
  private readonly staleAfterMs: number;

  constructor(options: { now?: () => number; staleAfterMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.staleAfterMs = options.staleAfterMs ?? PRESENCE_STALE_MS;
  }

  /** Register a browser viewer of a seat; returns the detach function. */
  attachViewer(roomId: string, seat: StoneColor): () => void {
    const signals = this.ensure(roomId, seat);
    signals.viewers += 1;
    signals.lastSeenAt = this.now();
    this.emit(roomId);

    let detached = false;
    return () => {
      if (detached) {
        return;
      }
      detached = true;
      const current = this.seats.get(keyOf(roomId, seat));
      if (!current) {
        return;
      }
      current.viewers = Math.max(0, current.viewers - 1);
      current.lastSeenAt = this.now();
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
    signals.sessions.add(sessionId);
    signals.lastSeenAt = this.now();
    if (client) {
      signals.client = client;
    }
    if (!known) {
      this.emit(roomId);
    }
  }

  /** Remove a session from every seat it attached to (transport closed). */
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
  }

  snapshot(input: {
    roomId: string;
    seats: Record<StoneColor, PlayerSpec>;
    turn: StoneColor | null;
    playing: boolean;
  }): ParticipantView[] {
    const now = this.now();
    const views: ParticipantView[] = [];

    for (const seat of ['black', 'white'] as const) {
      const spec = input.seats[seat];
      const signals = this.seats.get(keyOf(input.roomId, seat));
      const isTurn = input.playing && input.turn === seat;
      const lastSeenAt = signals?.lastSeenAt ?? null;
      const waiting = (signals?.waits ?? 0) > 0;

      // A browser tab is the only client a human seat has, so a viewer is the
      // whole connection signal: no tab open means nobody is looking, even if
      // a REST call happened a minute ago.
      //
      // An agent seat has an MCP session, except over the stdio bridge, which
      // holds no session in this process — there, recent calls are the only
      // evidence that the agent is alive.
      const connected =
        spec.kind === 'human'
          ? (signals?.viewers ?? 0) > 0
          : (signals?.sessions.size ?? 0) > 0 ||
            (lastSeenAt !== null && now - lastSeenAt <= this.staleAfterMs);

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
   * Re-evaluate seats whose evidence aged out past the stale window so the UI
   * can flip them to disconnected. Runs on a timer; never touches game logic,
   * and never fires while a session, viewer, or parked wait remains.
   */
  sweep(): void {
    const now = this.now();
    const dirty = new Set<string>();

    for (const [key, signals] of this.seats) {
      if (
        signals.sessions.size > 0 ||
        signals.viewers > 0 ||
        signals.waits > 0 ||
        signals.lastSeenAt === null
      ) {
        continue;
      }
      if (now - signals.lastSeenAt > this.staleAfterMs) {
        dirty.add(roomOf(key));
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
