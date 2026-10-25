import type { ParticipantKind, StoneColor } from './game.js';

/**
 * Where a room is in its lifecycle, independent of the game inside it.
 *
 * A room holds many games over its life; the phase says whether people are
 * still gathering or a game is underway. It deliberately does NOT extend
 * GameStatus: GameStatus is the MCP contract read by every existing client
 * and test, and a room that never uses the lobby starts straight at
 * `playing` — the old "new_game and move" flow keeps its meaning unchanged.
 */
export type RoomPhase =
  /** Seats are not settled or not filled; joining and switching are free. */
  | 'lobby'
  /** At least one side is ready; the room waits for the other. */
  | 'waiting'
  /** A game is underway (GameState.status === 'playing'). */
  | 'playing'
  /** Connection dropped mid-game; reserved for a future milestone. */
  | 'paused'
  /** The game is over; the room is read-only until the next one starts. */
  | 'finished';

/**
 * A stable identity for whoever occupies a seat.
 *
 * P1a keyed everything by seat color, which worked while a room held exactly
 * one human and one agent. Two agents in one room break that: both seats say
 * `kind: 'agent'`, so `moveBy('agent')` cannot tell which one is asking, and
 * presence cannot tell which of the two went quiet.
 *
 * A participant id fixes the addressing problem without changing what a seat
 * *is*. The id is stable for the life of a room, so a client that reconnects
 * keeps its seat and its history.
 */
export interface Participant {
  /** Room-scoped stable id, e.g. `p_7f3a`. Never reused within a room. */
  id: string;
  /** Display name, unique within the room. */
  name: string;
  kind: ParticipantKind;
  /** Seat held, or null before seating (lobby) and after leaving. */
  seat: StoneColor | null;
  /**
   * Whether this side has said it is ready to start. Room-level state: a
   * game that starts without the lobby marks everyone ready, so "ready"
   * never gates the legacy path.
   */
  ready: boolean;
  /** MCP clientInfo name or `web`, when known. */
  client?: string;
  /** Epoch ms when this participant last did anything. */
  lastSeenAt: number;
  joinedAt: string;
}

/**
 * What `GameState.seats` stores: enough to render and route a seat without
 * carrying the whole participant record into every game snapshot.
 *
 * `kind` and `name` stay because they are what existing readers use; `id` is
 * what new code routes by.
 */
export interface ParticipantRef {
  id: string;
  kind: ParticipantKind;
  name: string;
}

/** Why an identity could not be resolved to exactly one seat. */
export type IdentityProblem =
  /** No participant id was supplied and the room cannot infer one. */
  | 'IDENTITY_REQUIRED'
  /** The supplied id is not in this room. */
  | 'PARTICIPANT_NOT_FOUND'
  /** The participant exists but holds no seat. */
  | 'NOT_SEATED'
  /** An actor kind matches two participants, so routing is ambiguous. */
  | 'AMBIGUOUS_ACTOR';
