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
  type Move,
  type ParticipantView,
  type PlayerSpec,
  type RoomSummary,
  type RoomView,
  type RuleSet,
  type StoneColor,
  type WaitReason,
} from '@gomoku/shared';
import {
  applyMove,
  createInitialState,
  opposite,
  resignGame,
  startGame,
} from '../core/engine.js';
import { seatLabel, type PresenceSource } from '../core/presence.js';
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

function cloneSeats(
  seats: Record<StoneColor, PlayerSpec>,
): Record<StoneColor, PlayerSpec> {
  return {
    black: { ...seats.black },
    white: { ...seats.white },
  };
}

/**
 * A single Gomoku room: owns the one authoritative GameState, serializes all
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
      return (['black', 'white'] as const).map((seat) => ({
        seat,
        kind: this.state.seats[seat].kind,
        label: seatLabel(seat, this.state.seats[seat]),
        presence: 'unknown' as const,
        lastSeenAt: null,
        waiting: false,
        isTurn: false,
      }));
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

  /**
   * Start a fresh game. The agent seat is taken by `agentColor` (defaults to
   * the current agent seat, then white); the other color becomes the human.
   */
  newGame(options: { agentColor?: StoneColor } = {}): GameState {
    const agentColor = options.agentColor ?? this.getAgentSeat() ?? 'white';
    const humanColor = opposite(agentColor);

    const seats: Record<StoneColor, PlayerSpec> = {
      black: { kind: agentColor === 'black' ? 'agent' : 'human' },
      white: { kind: agentColor === 'white' ? 'agent' : 'human' },
    };

    this.state = startGame(this.state, seats, { rules: this.state.rules });
    this.history = [];
    this.commentaryLog = [];

    this.emitState('new_game');
    this.save();
    return this.state;
  }

  moveBy(actor: Actor, row: number, col: number): MoveActionResult {
    const seat = this.getSeatFor(actor);
    if (!seat) {
      return this.failure('NO_AGENT_SEAT', `Room "${this.id}" has no ${actor} seat.`);
    }

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

  private save(): void {
    this.repository?.save(this);
  }
}
