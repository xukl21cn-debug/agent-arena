import { randomUUID } from 'node:crypto';
import {
  MAX_COMMENTARY_LENGTH,
  MAX_COMMENTARY_LOG,
  type Actor,
  type AnyGameState,
  type AnyMove,
  type Commentary,
  type CommentaryKind,
  type CommentaryMood,
  type ErrorCode,
  type GameState,
  type GoState,
  type IdentityProblem,
  type Move,
  type NewGameRequest,
  type Participant,
  type ParticipantView,
  type PlayerSpec,
  type RoomPhase,
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
} from '../engine/gomoku.js';
import { resolveRules } from '../engine/rules.js';
import {
  applyGoPass,
  applyGoPlacement,
  confirmGoScore,
  markGoDead,
  resignGoGame,
  resolveGoRules,
  resumeGoPlay,
  startGoGame,
  type GoScoringResult,
} from '../engine/go-game.js';
import { seatLabel, type PresenceSource } from './presence.js';
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

export type StateChangeCause =
  | 'new_game'
  | 'move'
  | 'resign'
  /** A scoring-phase change (dead stones, confirmations, resume). */
  | 'scoring';
export type StateListener = (state: AnyGameState, cause: StateChangeCause) => void;
export type CommentaryListener = (commentary: Commentary) => void;
export type PhaseListener = (roomId: string, phase: RoomPhase) => void;

export interface WaitResult {
  state: AnyGameState;
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
  state: AnyGameState;
}

export type MoveActionResult =
  | { ok: true; state: AnyGameState; move: AnyMove }
  | RoomActionFailure;

export type StateActionResult =
  | { ok: true; state: AnyGameState }
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

/**
 * Normalize `new_game` inputs before any side effect.
 *
 * REST and MCP share this so the same value yields the same code and message:
 * - `INVALID_REQUEST`: wrong type / enum / format, or a gomoku board size
 *   outside 3..36.
 * - `UNSUPPORTED_RULE`: well-formed values v1 does not implement (a Go board
 *   other than 9, a ko rule other than simple, Go-only parameters on gomoku).
 */
export function normalizeNewGameOptions(
  raw: NewGameRequest | Record<string, unknown> = {},
): NewGameRequest {
  const input = raw as Record<string, unknown>;
  const options: NewGameRequest = {};

  const game = input.game;
  if (game !== undefined) {
    if (game !== 'gomoku' && game !== 'go') {
      throw new RoomError('INVALID_REQUEST', 'game must be "gomoku" or "go".');
    }
    options.game = game;
  }
  const selectedGame = options.game ?? 'gomoku';

  const agentColor = input.agentColor;
  if (agentColor !== undefined) {
    if (agentColor !== 'black' && agentColor !== 'white') {
      throw new RoomError(
        'INVALID_REQUEST',
        'agentColor must be "black" or "white".',
      );
    }
    options.agentColor = agentColor;
  }

  const boardSize = input.boardSize;
  if (boardSize !== undefined) {
    if (typeof boardSize !== 'number' || !Number.isInteger(boardSize)) {
      throw new RoomError('INVALID_REQUEST', 'boardSize must be an integer.');
    }
    if (selectedGame === 'gomoku' && (boardSize < 3 || boardSize > 36)) {
      throw new RoomError(
        'INVALID_REQUEST',
        `boardSize must be an integer between 3 and 36, got ${boardSize}.`,
      );
    }
    if (selectedGame === 'go' && (boardSize < 1 || boardSize > 36)) {
      throw new RoomError(
        'INVALID_REQUEST',
        `boardSize must be an integer between 1 and 36, got ${boardSize}.`,
      );
    }
    options.boardSize = boardSize;
  }

  const komi = input.komi;
  if (komi !== undefined) {
    if (selectedGame !== 'go') {
      throw new RoomError(
        'UNSUPPORTED_RULE',
        'komi and koRule are Go-only parameters.',
      );
    }
    if (typeof komi !== 'number' || !Number.isFinite(komi)) {
      throw new RoomError('INVALID_REQUEST', 'komi must be a finite number.');
    }
    options.komi = komi;
  }

  const koRule = input.koRule;
  if (koRule !== undefined) {
    if (selectedGame !== 'go') {
      throw new RoomError(
        'UNSUPPORTED_RULE',
        'komi and koRule are Go-only parameters.',
      );
    }
    if (typeof koRule !== 'string') {
      throw new RoomError('INVALID_REQUEST', 'koRule must be a string.');
    }
    if (koRule !== 'simple') {
      throw new RoomError(
        'UNSUPPORTED_RULE',
        `v1 supports koRule "simple" only, got "${koRule}".`,
      );
    }
    options.koRule = 'simple';
  }

  return options;
}

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
  private readonly phaseListeners = new Set<PhaseListener>();
  private readonly waiters = new Set<Waiter>();
  /** Who is in this room; outlives any single game. */
  private readonly roster = new ParticipantRoster();

  private state: AnyGameState;
  private history: AnyMove[] = [];
  private commentaryLog: Commentary[] = [];
  /** Last phase listeners were told about, so repeats stay silent. */
  private lastPhase: RoomPhase = 'lobby';
  /** Set once the room is deleted; a detached room must never persist again. */
  private disposed = false;

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
    this.lastPhase = this.computePhase();
  }

  getState(): AnyGameState {
    return this.state;
  }

  getView(): RoomView {
    return {
      state: this.state,
      history: [...this.history],
      commentary: [...this.commentaryLog],
      phase: this.getPhase(),
      participants: this.getParticipants(),
    };
  }

  /**
   * The room's lifecycle phase, derived on demand so it can never drift
   * from the state it summarizes.
   *
   * A game underway or over answers for itself; while idle, one ready voice
   * anywhere in the room means the room is waiting (even if the other side
   * has not joined yet), otherwise it is just open. The legacy path —
   * new_game without any ready call — lands directly in `playing`.
   */
  getPhase(): RoomPhase {
    if (
      this.state.status === 'playing' ||
      (this.state.game === 'go' && this.state.status === 'scoring')
    ) {
      return 'playing';
    }
    if (this.state.status === 'finished') {
      return 'finished';
    }
    return this.roster.list().some((participant) => participant.ready)
      ? 'waiting'
      : 'lobby';
  }

  /**
   * Detach the room from its repository after deletion.
   *
   * A parked long poll or an in-flight request can still hold this object;
   * without the flag its next save would recreate `data/rooms/<id>.json` and
   * the room would come back on the next restart.
   */
  dispose(): void {
    this.disposed = true;
  }

  /**
   * Presence for both seats. Without a registry (pure-logic tests) every seat
   * reports `unknown`, which is the honest answer: nothing is attached.
   *
   * The roster's ready flags are merged in afterwards: presence knows about
   * connections, readiness is a room fact, and neither should own the other.
   */
  getParticipants(): ParticipantView[] {
    let views: ParticipantView[];
    if (!this.presence) {
      views = (['black', 'white'] as const).map((seat) => {
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
    } else {
      views = this.presence.snapshot({
        roomId: this.id,
        seats: this.state.seats,
        turn: this.state.turn,
        playing: this.state.status === 'playing',
      });
    }

    if (this.roster.list().length === 0) {
      return views;
    }
    return views.map((view) => {
      const seated =
        view.participantId !== undefined
          ? this.roster.get(view.participantId)
          : this.roster.bySeat(view.seat);
      return seated === undefined ? view : { ...view, ready: seated.ready };
    });
  }

  getSummary(): RoomSummary {
    return {
      roomId: this.id,
      game: this.state.game,
      status: this.state.status,
      phase: this.getPhase(),
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
    ready?: boolean;
    client?: string;
    now?: number;
  }): Participant {
    const participant = this.roster.join(request);
    if (participant.seat !== null) {
      this.syncSeat(participant.seat, participant);
    } else {
      this.clearParticipantSeat(participant.id);
    }
    // A join may carry ready=true, which is how an agent seats and arms the
    // start in one call instead of two.
    if (request.ready === true) {
      this.maybeStartWhenReady();
    }
    this.emitRoster();
    return participant;
  }

  /**
   * Set one side's ready flag.
   *
   * While a game runs or has finished the call is an idempotent no-op: the
   * room answers with the current phase instead of an error, because
   * "press ready twice" is a client hiccup, not a rule violation. Cancelling
   * is the same call with false — the derived phase falls back to
   * waiting/lobby on its own.
   */
  setReady(
    participantId: string,
    ready: boolean,
  ):
    | { ok: true; participant: Participant; phase: RoomPhase }
    | { ok: false; code: ErrorCode; message: string } {
    const participant = this.roster.get(participantId);
    if (!participant) {
      return {
        ok: false,
        code: 'PARTICIPANT_NOT_FOUND',
        message: `Participant "${participantId}" is not in room "${this.id}".`,
      };
    }

    if (this.state.status === 'idle') {
      this.roster.setReady(participantId, ready);
      this.maybeStartWhenReady();
      this.emitRoster();
    }

    return {
      ok: true,
      participant: this.roster.get(participantId)!,
      phase: this.getPhase(),
    };
  }

  /** Leave the room, freeing the seat. */
  leave(participantId: string): boolean {
    const participant = this.roster.get(participantId);
    if (!participant) {
      return false;
    }
    this.roster.leave(participantId);
    this.clearParticipantSeat(participantId);
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
        ready: false,
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
   *
   * `game` picks what is played; omitted it stays gomoku, so every existing
   * client keeps its exact behaviour. A room binds one game per game: playing
   * the other one means starting a new game. Go rule parameters outside the
   * v1 envelope (anything but 9×9 / simple ko) are rejected with
   * UNSUPPORTED_RULE instead of silently accepted.
   */
  newGame(raw: NewGameRequest | Record<string, unknown> = {}): AnyGameState {
    // Validation comes first: a rejected request must not archive the live
    // game, clear history, or otherwise mutate the room.
    const options = normalizeNewGameOptions(raw);
    const game = options.game ?? 'gomoku';
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

    const prev = this.state;

    // Resolve the rules and build the replacement state before any side
    // effect. Everything that can reject the request happens here, so the
    // archive below only records games actually being replaced.
    let next: AnyGameState;
    if (game === 'go') {
      const resolved = resolveGoRules({
        ...(options.boardSize === undefined ? {} : { boardSize: options.boardSize }),
        ...(options.komi === undefined ? {} : { komi: options.komi }),
        ...(options.koRule === undefined ? {} : { koRule: options.koRule }),
      });
      if (!resolved.ok) {
        throw new RoomError('UNSUPPORTED_RULE', resolved.message);
      }
      next = startGoGame(prev, seats, { rules: resolved.rules });
    } else {
      // Gomoku rules carry over from the previous gomoku game; a Go state has
      // none to inherit, so the defaults apply.
      const baseRules = prev.game === 'gomoku' ? prev.rules : undefined;
      let rules: RuleSet;
      try {
        rules = resolveRules({
          ...(baseRules ?? {}),
          ...(options.boardSize === undefined ? {} : { boardSize: options.boardSize }),
        });
      } catch (error) {
        // resolveRules predates RoomError; a bad board/win combination is a
        // client error, never an internal one.
        if (error instanceof RoomError) {
          throw error;
        }
        throw new RoomError(
          'INVALID_REQUEST',
          error instanceof Error ? error.message : String(error),
        );
      }
      next = startGame(
        { roomId: prev.roomId, version: prev.version },
        seats,
        { rules },
      );
    }

    // Archive the game we are leaving before anything overwrites it: from
    // here on `this.state` is the new game and `this.history` is about to be
    // cleared, so `prev` plus the still-live history is the only complete
    // copy. A side channel, never a gate: an archive failure is logged and
    // the new game proceeds. Rooms that never started (gameId '') or never
    // moved are not worth an archive slot.
    if (prev.gameId !== '' && this.history.length > 0) {
      try {
        this.repository?.archive({
          id: this.id,
          state: prev,
          history: [...this.history],
          commentary: [...this.commentaryLog],
        });
      } catch (error) {
        console.error(
          `[room] failed to archive game "${prev.gameId}" of room "${this.id}":`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    this.state = next;
    this.history = [];
    this.commentaryLog = [];

    // The legacy path starts without any ready call, so mark everyone seated
    // as ready: a game in progress must not read as "still gathering".
    for (const participant of this.roster.list()) {
      if (participant.seat !== null) {
        this.roster.setReady(participant.id, true);
      }
    }

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

  /**
   * Pass for an explicit caller. Go only: a gomoku room answers WRONG_GAME,
   * which is also what keeps the four Go-only tools distinguishable from a
   * plain mistake.
   */
  passAs(ref: ActorRef): MoveActionResult {
    const identity = this.resolve(ref);
    if (!identity.ok) {
      return this.failure(identity.code, identity.message);
    }
    return this.passAt(identity.seat);
  }

  /**
   * Toggle the whole block at (row, col) as dead. Scoring only. Any change
   * resets both confirmations, and every scoring mutation goes through
   * {@link applyGoScoring} so parked waiters re-derive their reason.
   */
  markDeadAs(ref: ActorRef, row: number, col: number): StateActionResult {
    const identity = this.resolve(ref);
    if (!identity.ok) {
      return this.failure(identity.code, identity.message);
    }
    if (this.state.game !== 'go') {
      return this.failure('WRONG_GAME', 'mark_dead is only available in Go.');
    }
    return this.applyGoScoring(markGoDead(this.state, row, col));
  }

  /** Confirm the current score as this seat. Scoring only. */
  confirmScoreAs(ref: ActorRef): StateActionResult {
    const identity = this.resolve(ref);
    if (!identity.ok) {
      return this.failure(identity.code, identity.message);
    }
    if (this.state.game !== 'go') {
      return this.failure('WRONG_GAME', 'confirm_score is only available in Go.');
    }
    return this.applyGoScoring(confirmGoScore(this.state, identity.seat));
  }

  /** Drop the marks and confirmations, and resume playing. Scoring only. */
  resumePlayAs(ref: ActorRef): StateActionResult {
    const identity = this.resolve(ref);
    if (!identity.ok) {
      return this.failure(identity.code, identity.message);
    }
    if (this.state.game !== 'go') {
      return this.failure('WRONG_GAME', 'resume_play is only available in Go.');
    }
    return this.applyGoScoring(resumeGoPlay(this.state));
  }

  /**
   * Land a scoring result: the state moves, then every parked waiter is woken
   * (or left parked) by its own reasonFor — an unconfirmed seat gets
   * 'scoring', a confirmed one keeps waiting, and both-confirmed wakes
   * everyone as game_over. This is what makes scoring parallel instead of
   * turn-based.
   */
  private applyGoScoring(result: GoScoringResult): StateActionResult {
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message: result.message,
        state: this.state,
      };
    }

    this.state = result.state;
    this.emitState('scoring');
    this.save();
    return result;
  }

  private moveAt(seat: StoneColor, row: number, col: number): MoveActionResult {
    if (this.state.game === 'go') {
      return this.moveGoAt(seat, row, col);
    }
    return this.moveGomokuAt(seat, row, col);
  }

  private moveGomokuAt(seat: StoneColor, row: number, col: number): MoveActionResult {
    const result = applyMove(this.gomoku(), seat, row, col);
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

  /**
   * Go placement: the rules (capture / ko / suicide) live in engine/go.ts and
   * this only forwards the engine's verdict and moves the bookkeeping along.
   */
  private moveGoAt(seat: StoneColor, row: number, col: number): MoveActionResult {
    const result = applyGoPlacement(this.go(), seat, row, col);
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

  private passAt(seat: StoneColor): MoveActionResult {
    if (this.state.game !== 'go') {
      return this.failure('WRONG_GAME', 'pass is only available in Go.');
    }
    const result = applyGoPass(this.state, seat);
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
    const result =
      this.state.game === 'go'
        ? resignGoGame(this.state, seat)
        : resignGame(this.gomoku(), seat);
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

  onPhase(listener: PhaseListener): () => void {
    this.phaseListeners.add(listener);
    return () => {
      this.phaseListeners.delete(listener);
    };
  }

  getHistory(): readonly AnyMove[] {
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

  /**
   * The gomoku engine entry for this room: narrows the union or fails loudly.
   * Called from paths that are gomoku-only by construction (the dispatcher
   * has already checked `state.game`), so the throw is unreachable in
   * practice — it keeps the narrowing honest without a cast.
   */
  private gomoku(): GameState {
    if (this.state.game !== 'gomoku') {
      throw new RoomError('WRONG_GAME', 'This room is not running gomoku.');
    }
    return this.state;
  }

  /** The Go counterpart of {@link gomoku}: narrows the union or fails loudly. */
  private go(): GoState {
    if (this.state.game !== 'go') {
      throw new RoomError('WRONG_GAME', 'This room is not running Go.');
    }
    return this.state;
  }

  private reasonFor(seat: StoneColor, gameId: string): WaitReason | null {
    if (this.state.status === 'idle') {
      return 'idle';
    }
    if (this.state.status === 'finished') {
      return 'game_over';
    }
    // Scoring has no turn order: an unconfirmed seat must act now, a
    // confirmed one waits for the other side. This sits BEFORE the turn
    // check on purpose — turn says nothing about who should act here.
    if (this.state.game === 'go' && this.state.status === 'scoring') {
      return this.state.scoreConfirmed[seat] ? null : 'scoring';
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

    // Every phase-relevant mutation funnels through here (moves, resigns,
    // new games, roster changes), so this is the one place a phase change
    // needs to be detected and announced.
    this.notifyPhase();
  }

  /**
   * Both seats filled and both sides ready: start the game the lobby was
   * waiting for. Seats come from the roster exactly like a manual new_game,
   * so identity and colors survive the transition.
   */
  private maybeStartWhenReady(): void {
    if (this.state.status !== 'idle') {
      return;
    }
    const black = this.roster.bySeat('black');
    const white = this.roster.bySeat('white');
    if (black && white && black.ready && white.ready) {
      this.newGame();
    }
  }

  private notifyPhase(): void {
    const phase = this.computePhase();
    if (phase === this.lastPhase) {
      return;
    }
    this.lastPhase = phase;
    for (const listener of this.phaseListeners) {
      try {
        listener(this.id, phase);
      } catch (error) {
        console.error('[room] phase listener failed', error);
      }
    }
  }

  private computePhase(): RoomPhase {
    return this.getPhase();
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

  /** Clear a participant from any seat in `seats` while retaining the seat kind. */
  private clearParticipantSeat(participantId: string): void {
    let changed = false;
    const seats = { ...this.state.seats };
    for (const color of ['black', 'white'] as const) {
      if (seats[color].id === participantId) {
        seats[color] = { kind: seats[color].kind };
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    if (this.state.game === 'go') {
      this.state = { ...this.go(), seats };
    } else {
      this.state = { ...this.gomoku(), seats };
    }
  }

  /** Mirror a seated participant into `seats` so the board agrees. */
  private syncSeat(seat: StoneColor, participant: Participant): void {
    // If the participant held the opposite seat, clear it so they don't occupy both.
    const otherSeat: StoneColor = seat === 'black' ? 'white' : 'black';
    const otherSpec = this.state.seats[otherSeat];
    const cleanedOther =
      otherSpec.id === participant.id
        ? { kind: otherSpec.kind }
        : otherSpec;

    // Either game: the seats record has the same shape on GameState and
    // GoState, and joining must work whatever the room currently runs.
    const seats = {
      ...this.state.seats,
      [otherSeat]: cleanedOther,
      [seat]: {
        id: participant.id,
        kind: participant.kind,
        name: participant.name,
      },
    };
    if (this.state.game === 'go') {
      this.state = { ...this.go(), seats };
      return;
    }
    this.state = { ...this.gomoku(), seats };
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
    if (this.disposed) {
      return;
    }
    this.repository?.save(this);
  }
}
