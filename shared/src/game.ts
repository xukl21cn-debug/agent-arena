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
  | 'INTERNAL_ERROR';

export interface Cell {
  row: number;
  col: number;
}

export interface PlayerSpec {
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
}

export interface RoomSummary {
  roomId: string;
  status: GameStatus;
  gameId: string;
  moveCount: number;
  version: number;
  updatedAt: string;
}
