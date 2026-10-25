import type { RoomPhase } from './participant.js';
import type { ParticipantView } from './presence.js';

export type StoneColor = 'black' | 'white';
export type GameStatus = 'idle' | 'playing' | 'finished';
export type EndReason = 'five' | 'draw' | 'resign';
export type ParticipantKind = 'human' | 'agent' | 'remote';
export type Actor = 'human' | 'agent';

export type CommentaryKind =
  | 'evaluation'
  | 'position'
  | 'reaction'
  | 'result'
  | 'banter';

export type CommentaryMood =
  | 'neutral'
  | 'confident'
  | 'happy'
  | 'nervous'
  | 'surprised'
  | 'sad';

export type WaitReason =
  | 'your_turn'
  | 'game_over'
  | 'idle'
  | 'new_game'
  | 'timeout';

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_EXISTS'
  | 'INVALID_ROOM_ID'
  | 'GAME_NOT_PLAYING'
  | 'NOT_YOUR_TURN'
  | 'OUT_OF_BOUNDS'
  | 'CELL_OCCUPIED'
  | 'NO_AGENT_SEAT'
  | 'INVALID_COMMENTARY'
  | 'INVALID_REQUEST'
  | 'BACKEND_UNAVAILABLE'
  /** No participant id was supplied and the room cannot infer one. */
  | 'IDENTITY_REQUIRED'
  | 'PARTICIPANT_NOT_FOUND'
  | 'NOT_SEATED'
  /** Two participants share a kind, so `actor` cannot pick one. */
  | 'AMBIGUOUS_ACTOR'
  | 'SEAT_TAKEN'
  | 'INTERNAL_ERROR';

export interface Cell {
  row: number;
  col: number;
}

/**
 * Who occupies a seat.
 *
 * `id` is optional for backward compatibility: older persisted snapshots and
 * the engine's own defaults carry only `kind`. A seat with no id is still
 * routable by `kind`, which is how every pre-participant client behaves, but
 * two agents in one room need ids — see `participant.ts`.
 */
export interface PlayerSpec {
  /** Stable participant id; absent on legacy snapshots. */
  id?: string;
  kind: ParticipantKind;
  name?: string;
}

export interface RuleSet {
  boardSize: number;
  winLength: number;
  overlineWin: boolean;
  forbidden: 'none';
}

export interface Move extends Cell {
  color: StoneColor;
  index: number;
  at: string;
}

/** Compact move record for agents: coordinates, color and order only. */
export interface MoveRecord {
  row: number;
  col: number;
  color: StoneColor;
  index: number;
}

/**
 * What placing one stone on a cell would immediately create for that color:
 * win = five (game over, agrees with findWinLine under any RuleSet) |
 * open4 = two distinct five-points (unstoppable double threat) |
 * four = rush four (fiveAt is the single point to complete/block five) |
 * open3 = live three, incl. split shapes that grow into a four in one move
 * (reference tier: heuristic, capped, listed last).
 */
export type HotPointEffect = 'win' | 'open4' | 'four' | 'open3';

export interface HotPoint {
  row: number;
  col: number;
  effect: HotPointEffect;
  /** Empty cells that complete a five for this color (win/open4/four only). */
  fiveAt: Cell[];
  /**
   * Set when placing here creates two independent threats: four + open3, or
   * two open3s in different directions. Each threat needs its own defense, so
   * the point is a forced win unless the opponent already has a faster threat.
   * win/open4 points do not repeat their existing tier here.
   */
  double?: HotPointEffect[];
  /**
   * Extension points of the independent open3(s) counted by `double`
   * (`double` includes "open3" only). Occupying one of these ends can defuse
   * a four+open3 combo; a double-open3 point must itself be occupied (or
   * answered by a faster win), because one endpoint block leaves the other
   * live three intact.
   */
  open3At?: Cell[];
}

export interface Commentary {
  id: string;
  roomId: string;
  gameId: string;
  text: string;
  kind: CommentaryKind;
  mood: CommentaryMood;
  moveIndex: number;
  at: string;
}

export interface GameState {
  schemaVersion: 1;
  roomId: string;
  gameId: string;
  rules: RuleSet;
  board: (StoneColor | null)[][];
  turn: StoneColor;
  seats: Record<StoneColor, PlayerSpec>;
  status: GameStatus;
  winner: StoneColor | 'draw' | null;
  endReason: EndReason | null;
  winLine: Cell[] | null;
  lastMove: Move | null;
  moveCount: number;
  version: number;
  updatedAt: string;
}

export interface RoomView {
  state: GameState;
  history: Move[];
  commentary: Commentary[];
  /** Room lifecycle, independent of the game's own status. */
  phase: RoomPhase;
  /** Per-seat presence, so the UI can tell "thinking" from "not connected". */
  participants: ParticipantView[];
}

export interface RoomSummary {
  roomId: string;
  status: GameStatus;
  /** Room lifecycle, independent of the game's own status. */
  phase: RoomPhase;
  gameId: string;
  moveCount: number;
  version: number;
  updatedAt: string;
  /**
   * Compact presence line for room lists. Optional because a persisted
   * snapshot has no connection information — presence is a live-only fact.
   */
  participants?: ParticipantView[];
}
