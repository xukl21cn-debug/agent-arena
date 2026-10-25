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
  | 'timeout'
  /** Go only: the game paused for dead-stone marking and score confirmation. */
  | 'scoring';

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
  /** Go: the placement would leave the played block without liberties. */
  | 'SUICIDE'
  /** Go: the point is forbidden by the simple-ko rule for this move. */
  | 'KO'
  /** The tool only exists for the other game (e.g. pass in a gomoku room). */
  | 'WRONG_GAME'
  /** Go: the game is not in its scoring phase. */
  | 'NOT_SCORING'
  /** Go: the marked point holds no stone. */
  | 'INVALID_DEAD_STONE'
  /** The requested rules variant is not implemented. */
  | 'UNSUPPORTED_RULE'
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

/**
 * A Go pass. Placements reuse {@link Move}, so a pass is told apart by the
 * `kind` field only it carries.
 */
export interface GoPassMove {
  kind: 'pass';
  color: StoneColor;
  index: number;
  at: string;
}

export type GoMove = Move | GoPassMove;
export type AnyMove = Move | GoPassMove;

/**
 * Compact move record for agents: kind, color and order; row/col are present
 * on a placement and absent on a pass.
 */
export interface MoveRecord {
  kind: 'place' | 'pass';
  row?: number;
  col?: number;
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

/**
 * A gomoku game's authoritative state. The name deliberately stays
 * `GameState` — the gomoku engine and its tests keep their type — while
 * {@link GoState} sits beside it and {@link AnyGameState} is their union.
 */
export interface GameState {
  /** Discriminant: this state describes a gomoku game. */
  game: 'gomoku';
  schemaVersion: 2;
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

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

export interface GoRules {
  /** v1 is fixed at 9; other sizes are rejected by the game layer, not here. */
  boardSize: 9;
  /** Compensation for white playing second, added to WHITE's total. */
  komi: number;
  koRule: 'simple';
}

export type GoBoard = (StoneColor | null)[][];

/** Rule violations the pure Go engine can return for one placement. */
export type GoErrorCode = 'OUT_OF_BOUNDS' | 'CELL_OCCUPIED' | 'SUICIDE' | 'KO';

/** Chinese area scoring result. Captures never enter these numbers. */
export interface GoScore {
  blackArea: number;
  whiteArea: number;
  komi: number;
  blackTotal: number;
  whiteTotal: number;
  winner: StoneColor | 'draw';
  margin: number;
}

export interface GoGroupSummary {
  color: StoneColor;
  stones: number;
  /** Topmost stone, then leftmost — stable across calls for the same board. */
  representative: Cell;
  liberties: number;
  /** Exact liberty coordinates for 1-2 liberty groups; omitted at 3+. */
  libertyAt?: Cell[];
}

export interface GoGroupsView {
  black: GoGroupSummary[];
  white: GoGroupSummary[];
  /** Groups beyond the per-color cap — counts, not prose to re-parse. */
  omitted: { black: number; white: number };
}

/**
 * A Go game's own status. Kept separate from `GameStatus` on purpose: Go's
 * extra 'scoring' phase must never leak into the gomoku contract, which 206
 * existing tests and every MCP client already pin to idle/playing/finished.
 */
export type GoStatus = 'idle' | 'playing' | 'scoring' | 'finished';

/**
 * A Go game's authoritative state, discriminated by `game: 'go'`.
 */
export interface GoState {
  /** Discriminant: this state describes a Go game. */
  game: 'go';
  schemaVersion: 2;
  roomId: string;
  gameId: string;
  rules: GoRules;
  board: GoBoard;
  /** Still "who would play next" during scoring; confirmation is parallel. */
  turn: StoneColor;
  status: GoStatus;
  seats: Record<StoneColor, PlayerSpec>;
  winner: StoneColor | 'draw' | null;
  endReason: 'resign' | 'scored' | 'draw' | null;
  /** Go has no five-in-a-row line; kept (always null) for a shared result UI. */
  winLine: null;
  lastMove: GoMove | null;
  moveCount: number;
  version: number;
  updatedAt: string;
  /** Prisoners taken by each side — display only, never part of the score. */
  captures: { black: number; white: number };
  /** Points emptied by the most recent capture, for board marking. */
  lastCaptured: Cell[];
  /** Simple-ko forbidden point, set right after a single-stone capture. */
  koPoint: Cell | null;
  /** Two consecutive passes move the game from playing to scoring. */
  consecutivePasses: number;
  /** Stones marked dead during scoring, by whole blocks. */
  deadStones: Cell[];
  scoreConfirmed: Record<StoneColor, boolean>;
  /** Final Chinese-area score once both sides confirmed; null until then. */
  score: GoScore | null;
}

export type AnyGameState = GameState | GoState;

export interface RoomView {
  state: AnyGameState;
  history: AnyMove[];
  commentary: Commentary[];
  /** Room lifecycle, independent of the game's own status. */
  phase: RoomPhase;
  /** Per-seat presence, so the UI can tell "thinking" from "not connected". */
  participants: ParticipantView[];
}

export interface RoomSummary {
  roomId: string;
  /** Which game this room is running. */
  game: 'gomoku' | 'go';
  status: GameStatus | GoStatus;
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
