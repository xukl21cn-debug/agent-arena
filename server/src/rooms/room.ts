import { randomUUID } from 'node:crypto';
import {
  MAX_COMMENTARY_LENGTH,
  MAX_COMMENTARY_LOG,
  type Actor,
  type Commentary,
  type CommentaryKind,
  type CommentaryMood,
  type ErrorCode,
  type GameState,
  type IdentityProblem,
  type Move,
  type Participant,
  type ParticipantView,
  type PlayerSpec,
  type RoomSummary,
  type RoomView,
  type RuleSet,
  type StoneColor,
  type WaitReason,
} from '@arena/shared';
import {
  applyMove,
  createInitialState,
  opposite,
  resignGame,
  startGame,
} from '../core/engine.js';
import { seatLabel, type PresenceSource } from '../core/presence.js';
import { ParticipantRoster } from './participant-roster.js';
import type { PersistedRoom, RoomRepository } from './repository.js';

export class RoomError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

export type StateChangeCause = 'new_game' | 'move' | 'resign';
export type StateListener = (state: GameState, cause: StateChangeCause) => void;
export type CommentaryListener = (commentary: Commentary) => void;

export interface WaitResult {
  state: GameState;
  reason: WaitReason;
}

export interface RoomConfig {
  seats?: Record<StoneColor, PlayerSpec>;
  rules?: Partial<RuleSet>;
}

/** Failure that still carries the current state so callers can recover. */
export interface RoomActionFailure {
  ok: false;
  code: ErrorCode;
  message: string;
  state: GameState;
}

export type MoveActionResult =
  | { ok: true; state: GameState; move: Move }
  | RoomActionFailure;

export type StateActionResult =
  | { ok: true; state: GameState }
  | RoomActionFailure;

interface Waiter {
  seat: StoneColor;
  gameId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: WaitResult) => void;
}

/** How a caller identifies itself when acting in a room. */
export type ActorRef =
  /** Preferred: the participant id, which is unique even with two agents. */
  | { participantId: string }
  /** Legacy: routed by kind, and only while exactly one seat has that kind. */
  | { actor: Actor };

/** Failure to resolve an identity to exactly one seated participant. */
export interface IdentityFailure {
  ok: false;
  code: IdentityProblem;
  message: string;
}

export type IdentityResult =
  | { ok: true; participant: Participant; seat: StoneColor }
  | IdentityFailure;

interface GameRoomOptions extends RoomConfig {
  repository?: RoomRepository;
  /** Presence source for `participants`; omitted in pure-logic tests. */
  presence?: PresenceSource;
}

function defaultSeats(): Record<StoneColor, PlayerSpec> {
  return {
    black: { kind: 'human' },
    white: { kind: 'agent' },
  };
}

/**
 * The seat spec for a new game.
 *
 * A seated participant keeps its identity; an empty seat falls back to the
 * legacy kind so a room without a roster still starts a game.
 */
function seatSpecOf(
  participant: Participant | undefined,
  fallbackKind: Participant['kind'],
): PlayerSpec {
  if (!participant) {
    return { kind: fallbackKind };
  }
  return {
    id: participant.id,
    kind: participant.kind,
    name: participant.name,
  };
}

function cloneSeats(
  seats: Record<StoneColor, PlayerSpec>,
): Record<StoneColor, PlayerSpec> {
  return {
    black: { ...seats.black },
    white: { ...seats.white },
  };
}

/**
 * A single game room: owns the one authoritative GameState, serializes all
 * mutations, and fans state / commentary changes out to listeners (WS, tests).
 *
 * The room knows nothing about HTTP, WebSocket or MCP.
 */
export class GameRoom {
  readonly id: string;

  private readonly repository: RoomRepository | undefined;
  private readonly presence: PresenceSource | undefined;
  private readonly stateListeners = new Set<StateListener>();
  private readonly commentaryListeners = new Set<CommentaryListener>();
  private readonly waiters = new Set<Waiter>();
  /** Who is in this room; outlives any single game. */
  private readonly roster = new ParticipantRoster();

  private state: GameState;
  private history: Move[] = [];
  private commentaryLog: Commentary[] = [];

  constructor(id: string, options: GameRoomOptions = {}) {
    this.id = id;
    this.repository = options.repository;
    this.presence = options.presence;

    const initial = createInitialState(id, options.rules);
    this.state = {
      ...initial,
      seats: options.seats ? cloneSeats(options.seats) : defaultSeats(),
    };

    const persisted = this.repository?.load(id) ?? null;
    if (persisted) {
      this.restore(persisted);
    }
  }

  getState(): GameState {
    return this.state;
  }

  getView(): RoomView {
    return {
      state: this.state,
      history: [...this.history],
      commentary: [...this.commentaryLog],
      participants: this.getParticipants(),
    };
  }

  /**
   * Presence for both seats. Without a registry (pure-logic tests) every seat
   * reports `unknown`, which is the honest answer: nothing is attached.
   */
  getParticipants(): ParticipantView[] {
    if (!this.presence) {
      return (['black', 'white'] as const).map((seat) => {
        const spec = this.state.seats[seat];
        return {
          seat,
          ...(spec.id === undefined ? {} : { participantId: spec.id }),
          kind: spec.kind,
          label: seatLabel(seat, spec),
          presence: 'unknown' as const,
          lastSeenAt: null,
          waiting: false,
          isTurn: false,
        };
      });
    }

    return this.presence.snapshot({
      roomId: this.id,
      seats: this.state.seats,
      turn: this.state.turn,
      playing: this.state.status === 'playing',
    });
  }

  getSummary(): RoomSummary {
    return {
      roomId: this.id,
      status: this.state.status,
      gameId: this.state.gameId,
      moveCount: this.state.moveCount,
      version: this.state.version,
      updatedAt: this.state.updatedAt,
      participants: this.getParticipants(),
    };
  }

  getSeatFor(actor: Actor): StoneColor | null {
    for (const color of ['black', 'white'] as const) {
      if (this.state.seats[color].kind === actor) {
        return color;
      }
    }
    return null;
  }

  getAgentSeat(): StoneColor | null {
    return this.getSeatFor('agent');
  }

  getHumanSeat(): StoneColor | null {
    return this.getSeatFor('human');
  }

  // ---------------------------------------------------------------- roster

  /** Everyone currently in this room. */
  getRoster(): Participant[] {
    return this.roster.list();
  }

  /**
   * Join the room, or reconnect if this name is already here.
   *
   * Seating is optional: a participant may join before choosing a color, which
   * is what the lobby phase (P1c) needs.
   */
  join(request: {
    name?: string;
    kind: Participant['kind'];
    seat?: StoneColor | null;
    client?: string;
    now?: number;
  }): Participant {
    const participant = this.roster.join(request);
    if (participant.seat !== null) {
      this.syncSeat(participant.seat, participant);
    }
    this.emitRoster();
    return participant;
  }

  /** Leave the room, freeing the seat. */
  leave(participantId: string): boolean {
    const participant = this.roster.get(participantId);
    if (!participant) {
      return false;
    }
    const seat = participant.seat;
    this.roster.leave(participantId);
    if (seat !== null) {
      // The seat stays on the board but is no longer anyone's; keep the kind so
      // the UI can still label it.
      this.state = {
        ...this.state,
        seats: {
          ...this.state.seats,
          [seat]: { kind: this.state.seats[seat].kind },
        },
      };
    }
    this.emitRoster();
    return true;
  }

  /**
   * Resolve a caller to exactly one seated participant.
   *
   * Ids win because they are unambiguous. The legacy `actor` form still works
   * while a room holds one participant of that kind — which is every existing
   * client — and fails loudly with `AMBIGUOUS_ACTOR` once two agents share a
   * room, instead of silently moving the wrong color.
   */
  resolve(ref: ActorRef): IdentityResult {
    if ('participantId' in ref) {
      const participant = this.roster.get(ref.participantId);
      if (!participant) {
        return {
          ok: false,
          code: 'PARTICIPANT_NOT_FOUND',
          message: `Participant "${ref.participantId}" is not in room "${this.id}".`,
        };
      }
      if (participant.seat === null) {
        return {
          ok: false,
          code: 'NOT_SEATED',
          message: `Participant "${participant.name}" holds no seat in room "${this.id}".`,
        };
      }
      return { ok: true, participant, seat: participant.seat };
    }

    const seated = this.roster
      .byKind(ref.actor)
      .filter((participant) => participant.seat !== null);

    if (seated.length === 1) {
      const participant = seated[0]!;
      return { ok: true, participant, seat: participant.seat! };
    }
    if (seated.length > 1) {
      return {
        ok: false,
        code: 'AMBIGUOUS_ACTOR',
        message: `Room "${this.id}" has ${seated.length} seated ${ref.actor} participants; identify the caller by participantId.`,
      };
    }

    // No roster entry: fall back to the legacy seat lookup so a room created
    // before participants existed still answers.
    const seat = this.getSeatFor(ref.actor);
    if (seat === null) {
      return {
        ok: false,
        code: 'IDENTITY_REQUIRED',
        message: `Room "${this.id}" has no ${ref.actor} seat.`,
      };
    }
    return {
      ok: true,
      participant: {
        id: `legacy:${ref.actor}`,
        name: ref.actor,
        kind: ref.actor,
        seat,
        lastSeenAt: Date.now(),
        joinedAt: new Date().toISOString(),
      },
      seat,
    };
  }

  /**
   * Start a fresh game.
   *
   * Seats come from the roster first: whoever already joined keeps their seat
   * and identity across rematches, which is what lets a connected agent simply
   * keep playing instead of re-joining every game. `agentColor` seeds the
   * seats only when the roster has nobody seated — the pre-participant path.
   */
  newGame(options: { agentColor?: StoneColor } = {}): GameState {
    const agentColor = options.agentColor ?? this.getAgentSeat() ?? 'white';
    const humanColor = opposite(agentColor);

    const seated = {
      black: this.roster.bySeat('black'),
      white: this.roster.bySeat('white'),
    };

    const seats: Record<StoneColor, PlayerSpec> = {
      black: seatSpecOf(seated.black, agentColor === 'black' ? 'agent' : 'human'),
      white: seatSpecOf(seated.white, agentColor === 'white' ? 'agent' : 'human'),
    };

    this.state = startGame(this.state, seats, { rules: this.state.rules });
    this.history = [];
    this.commentaryLog = [];

    // Seats change hands between games, and presence is keyed by seat: the
    // human's activity from the previous game must not make this game's agent
    // seat look connected. Clear the slate before announcing the new game.
    this.presence?.rebindSeats(this.id, agentColor);

    this.emitState('new_game');
    this.save();
    return this.state;
  }

  moveBy(actor: Actor, row: number, col: number): MoveActionResult {
    const seat = this.getSeatFor(actor);
    if (!seat) {
      return this.failure('NO_AGENT_SEAT', `Room "${this.id}" has no ${actor} seat.`);
    }

    return this.moveAt(seat, row, col);
  }

  /**
   * Place a stone for an explicit caller.
   *
   * This is the participant-aware entry point: the identity is resolved first,
   * so two agents in one room each move their own color. The legacy
   * `moveBy(actor, …)` above delegates here after resolving by kind.
   */
  moveAs(ref: ActorRef, row: number, col: number): MoveActionResult {
    const identity = this.resolve(ref);
    if (!identity.ok) {
      return this.failure(identity.code, identity.message);
    }
    return this.moveAt(identity.seat, row, col);
  }

  private moveAt(seat: StoneColor, row: number, col: number): MoveActionResult {
    const result = applyMove(this.state, seat, row, col);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message: result.message,
        state: this.state,
      };
    }

    this.state = result.state;
    this.history.push(result.move);

    this.emitState('move');
    this.save();
    return result;
  }

  resignBy(actor: Actor): StateActionResult {
    const seat = this.getSeatFor(actor);
    if (!seat) {
      return this.failure('NO_AGENT_SEAT', `Room "${this.id}" has no ${actor} seat.`);
    }

    return this.resignAt(seat);
  }

  /** Resign for an explicit caller; see {@link moveAs}. */
  resignAs(ref: ActorRef): StateActionResult {
    const identity = this.resolve(ref);
    if (!identity.ok) {
      return this.failure(identity.code, identity.message);
    }
    return this.resignAt(identity.seat);
  }

  private resignAt(seat: StoneColor): StateActionResult {
    const result = resignGame(this.state, seat);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message: result.message,
        state: this.state,
      };
    }

    this.state = result.state;
    this.emitState('resign');
    this.save();
    return result;
  }

  /**
   * Long-poll until `seat` may act, the game leaves `playing`, a new game
   * starts, or the timeout elapses. Timeouts are a normal result, not an error.
   */
  waitForSeat(seat: StoneColor, timeoutMs: number): Promise<WaitResult> {
    const immediate = this.reasonFor(seat, this.state.gameId);
    if (immediate) {
      return Promise.resolve({ state: this.state, reason: immediate });
    }

    return new Promise<WaitResult>((resolve) => {
      const waiter: Waiter = {
        seat,
        gameId: this.state.gameId,
        timer: setTimeout(() => this.settle(waiter, 'timeout'), timeoutMs),
        resolve,
      };
      this.waiters.add(waiter);
    });
  }

  say(
    text: string,
    kind: CommentaryKind = 'reaction',
    mood: CommentaryMood = 'neutral',
  ): Commentary {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (trimmed.length < 1) {
      throw new RoomError(
        'INVALID_COMMENTARY',
        'Commentary text must not be empty.',
      );
    }

    // Slice by code point so surrogate pairs are never split.
    const characters = Array.from(trimmed);
    const finalText =
      characters.length > MAX_COMMENTARY_LENGTH
        ? characters.slice(0, MAX_COMMENTARY_LENGTH).join('')
        : trimmed;

    const commentary: Commentary = {
      id: randomUUID(),
      roomId: this.id,
      gameId: this.state.gameId,
      text: finalText,
      kind,
      mood,
      moveIndex: this.state.moveCount,
      at: new Date().toISOString(),
    };

    this.commentaryLog.push(commentary);
    if (this.commentaryLog.length > MAX_COMMENTARY_LOG) {
      this.commentaryLog = this.commentaryLog.slice(-MAX_COMMENTARY_LOG);
    }

    this.emitCommentary(commentary);
    this.save();
    return commentary;
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  onCommentary(listener: CommentaryListener): () => void {
    this.commentaryListeners.add(listener);
    return () => {
      this.commentaryListeners.delete(listener);
    };
  }

  getHistory(): readonly Move[] {
    return this.history;
  }

  toSnapshot(): PersistedRoom {
    return {
      id: this.id,
      state: this.state,
      history: [...this.history],
      commentary: [...this.commentaryLog],
    };
  }

  private restore(persisted: PersistedRoom): void {
    this.state = persisted.state;
    this.history = [...persisted.history];
    this.commentaryLog = [...persisted.commentary].slice(
      -MAX_COMMENTARY_LOG,
    );
  }

  private failure(code: ErrorCode, message: string): RoomActionFailure {
    return { ok: false, code, message, state: this.state };
  }

  private reasonFor(seat: StoneColor, gameId: string): WaitReason | null {
    if (this.state.status === 'idle') {
      return 'idle';
    }
    if (this.state.status === 'finished') {
      return 'game_over';
    }
    // Prefer the actionable answer: a new game where it is already the
    // agent's turn should wake it as `your_turn`, not just `new_game`.
    if (this.state.turn === seat) {
      return 'your_turn';
    }
    if (this.state.gameId !== gameId) {
      return 'new_game';
    }
    return null;
  }

  private settle(waiter: Waiter, reason: WaitReason): void {
    if (!this.waiters.delete(waiter)) {
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve({ state: this.state, reason });
  }

  private emitState(cause: StateChangeCause): void {
    const state = this.state;

    for (const waiter of [...this.waiters]) {
      const reason = this.reasonFor(waiter.seat, waiter.gameId);
      if (reason) {
        this.settle(waiter, reason);
      }
    }

    for (const listener of this.stateListeners) {
      try {
        listener(state, cause);
      } catch (error) {
        console.error('[room] state listener failed', error);
      }
    }
  }

  private emitCommentary(commentary: Commentary): void {
    for (const listener of this.commentaryListeners) {
      try {
        listener(commentary);
      } catch (error) {
        console.error('[room] commentary listener failed', error);
      }
    }
  }

  /** Mirror a seated participant into `GameState.seats` so the board agrees. */
  private syncSeat(seat: StoneColor, participant: Participant): void {
    this.state = {
      ...this.state,
      seats: {
        ...this.state.seats,
        [seat]: {
          id: participant.id,
          kind: participant.kind,
          name: participant.name,
        },
      },
    };
  }

  /**
   * Tell listeners the roster changed.
   *
   * Routed through the state listeners so the web client refreshes presence
   * and seats from one event, instead of needing a second subscription.
   */
  private emitRoster(): void {
    this.emitState('new_game');
    this.save();
  }

  private save(): void {
    this.repository?.save(this);
  }
}
