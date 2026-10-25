import type {
  Actor,
  Commentary,
  CommentaryKind,
  CommentaryMood,
  ErrorCode,
  GameState,
  HotPoint,
  Move,
  MoveRecord,
  PlayerSpec,
  RuleSet,
  StoneColor,
  WaitReason,
} from './game.js';
import type { RoomPhase } from './participant.js';
import type { ParticipantView } from './presence.js';

export interface NewRoomRequest {
  roomId?: string;
  seats?: Record<StoneColor, PlayerSpec>;
  rules?: Partial<RuleSet>;
}

export interface NewGameRequest {
  agentColor?: StoneColor;
}

export interface MoveRequest {
  row: number;
  col: number;
  actor?: Actor;
}

export interface ResignRequest {
  actor?: Actor;
}

export interface SayRequest {
  text: string;
  kind?: CommentaryKind;
  mood?: CommentaryMood;
  actor?: Actor;
}

export interface StateResponse {
  state: GameState;
  yourColor: StoneColor | null;
}

export interface WaitForTurnResponse extends StateResponse {
  reason: WaitReason;
  history: Move[];
}

/** Successful mutation responses carry the state plus the full move history. */
export interface MutationResponse {
  state: GameState;
  history: Move[];
}

/**
 * GameState rendered for LLM agents: the 15×15 nested null array is replaced
 * by a monospace board picture, a move list, and per-color hot points.
 * Agents should never need to rebuild the board cell by cell.
 */
export interface AgentStateView extends Omit<GameState, 'board'> {
  /** Monospace grid: X=black, O=white, .=empty, lowercase = latest move. */
  boardText: string;
  /**
   * Move records for this game. Hot-path responses keep only the most
   * recent moves; get_state returns the full list.
   */
  moves: MoveRecord[];
  /** Earlier moves left out of `moves`; 0 means the list is complete. */
  movesOmitted: number;
  /** Cells where placing that color's stone creates an immediate threat. */
  hotPoints: Record<StoneColor, HotPoint[]>;
}

export interface AgentStateResponse {
  state: AgentStateView;
  yourColor: StoneColor | null;
}

export interface AgentWaitForTurnResponse extends AgentStateResponse {
  reason: WaitReason;
}

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
  };
  state?: GameState;
  /** Move history alongside `state`, so error views stay self-consistent. */
  history?: Move[];
}

export type ClientMessage = { type: 'ping' };

export type ServerMessage =
  | {
      type: 'hello';
      roomId: string;
      state: GameState;
      commentary: Commentary[];
      phase: RoomPhase;
      participants: ParticipantView[];
    }
  | {
      type: 'state';
      roomId: string;
      state: GameState;
    }
  | {
      /** Presence changed (waiting / thinking / idle / disconnected). */
      type: 'participants';
      roomId: string;
      participants: ParticipantView[];
    }
  | {
      /** The room moved through its lifecycle (lobby/waiting/playing/…). */
      type: 'phase';
      roomId: string;
      phase: RoomPhase;
    }
  | {
      type: 'commentary';
      roomId: string;
      commentary: Commentary;
    }
  | {
      type: 'error';
      code: string;
      message: string;
    }
  | {
      type: 'pong';
    };
