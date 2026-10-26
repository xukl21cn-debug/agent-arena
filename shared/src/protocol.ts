import type {
  Actor,
  AnyGameState,
  AnyMove,
  Cell,
  Commentary,
  CommentaryKind,
  CommentaryMood,
  ErrorCode,
  GoGroupsView,
  GoScore,
  GoState,
  GameState,
  HotPoint,
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
  /**
   * Which game to play; omitted stays gomoku so existing clients keep their
   * behaviour. Go rule parameters outside the v1 envelope (non-9 board,
   * non-simple ko) are rejected with UNSUPPORTED_RULE.
   */
  game?: 'gomoku' | 'go';
  /** Go: must be 9 in v1. Gomoku: forwarded to the existing rule set. */
  boardSize?: number;
  /** Go only (default 7.5); rejected for gomoku. */
  komi?: number;
  /** Go only (default simple); rejected for gomoku. */
  koRule?: 'simple';
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
  state: AnyGameState;
  yourColor: StoneColor | null;
}

export interface WaitForTurnResponse extends StateResponse {
  reason: WaitReason;
  history: AnyMove[];
}

/** Successful mutation responses carry the state plus the full move history. */
export interface MutationResponse {
  state: AnyGameState;
  history: AnyMove[];
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
  state: AgentStateView | GoAgentStateView;
  yourColor: StoneColor | null;
}

export interface AgentWaitForTurnResponse extends AgentStateResponse {
  reason: WaitReason;
}

/**
 * GoState rendered for LLM agents: the 9×9 nested array becomes a monospace
 * picture, moves compact to records, and block liberties arrive as
 * pre-digested group summaries. Discriminated from {@link AgentStateView} by
 * `game`; transports hand out {@link AnyAgentStateView}.
 */
export interface GoAgentStateView extends Omit<GoState, 'board'> {
  /**
   * Monospace grid: B=black, W=white, .=empty, lowercase = latest placement,
   * × = points emptied by the most recent capture.
   */
  boardText: string;
  /** Move records; passes carry kind 'pass' and no row/col. */
  moves: MoveRecord[];
  /** Earlier moves left out of `moves`; 0 means the list is complete. */
  movesOmitted: number;
  /** Prisoner counts plus the points the latest capture emptied. */
  captures: { black: number; white: number; lastCaptured: Cell[] };
  /** Block summaries, most endangered first; see {@link GoGroupsView}. */
  groups: GoGroupsView;
  /** Chinese-area score under the current dead-stone marks; null while playing. */
  scorePreview: GoScore | null;
}

export type AnyAgentStateView = AgentStateView | GoAgentStateView;

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
  };
  state?: AnyGameState;
  /** Move history alongside `state`, so error views stay self-consistent. */
  history?: AnyMove[];
}

export type ClientMessage = { type: 'ping' };

/* ------------------------------------------------------------------
   Chat wire frames
   Chat and game rooms share one /ws endpoint, so the chat event types
   belong to this transport contract. They are wire shapes only — the
   chat domain's own types (ChatRoom, ChatPolicy, ChatErrorCode) stay in
   the server package and are deliberately not mirrored here. Every chat
   frame carries `kind: 'chat'` so consumers can tell it from a game
   frame without guessing at payloads.
------------------------------------------------------------------ */

/** One timeline entry, exactly as it travels over the wire. */
export interface ChatMessageFrame {
  /** Room-local, monotonic from 1. */
  seq: number;
  id: string;
  from: string;
  /** Redundant so transcripts render after a member left. */
  fromName: string;
  /** Requested next speaker, member id or name at send time. */
  to?: string;
  kind: 'chat' | 'event' | 'system';
  text: string;
  replyTo?: string;
  hop: number;
  at: string;
}

export interface ChatMemberFrame {
  id: string;
  /** `human` is the reserved host identity. */
  name: string;
  kind: 'human' | 'agent';
  joinedAt: string;
  /** Agent messages sent; humans are never counted. */
  messages: number;
  /** Epoch ms of the member's last activity; a timestamp, not presence. */
  lastSeenAt: number;
}

export interface ChatRoomFrame {
  id: string;
  title: string;
  phase: 'open' | 'paused' | 'closed';
  seq: number;
  hop: number;
  /** The policy numbers the UI renders; the full policy stays server-side. */
  maxHops: number;
  maxMessagesPerMember: number;
  turn: { participantId: string; name: string } | null;
  members: ChatMemberFrame[];
  messageCount: number;
}

export type ServerMessage =
  | {
      type: 'hello';
      roomId: string;
      state: AnyGameState;
      commentary: Commentary[];
      phase: RoomPhase;
      participants: ParticipantView[];
    }
  | {
      type: 'state';
      roomId: string;
      state: AnyGameState;
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
      /** Chat greeting on connect: room snapshot plus the recent timeline
       * tail. Independent fields, not the game `state` — chat has no board. */
      type: 'hello';
      roomId: string;
      kind: 'chat';
      room: ChatRoomFrame;
      messages: ChatMessageFrame[];
    }
  | {
      /** One new chat message. */
      type: 'message';
      roomId: string;
      kind: 'chat';
      message: ChatMessageFrame;
    }
  | {
      /** Chat snapshot after membership, turn, hop or phase moved. */
      type: 'room';
      roomId: string;
      kind: 'chat';
      room: ChatRoomFrame;
    }
  | {
      type: 'error';
      code: string;
      message: string;
    }
  | {
      type: 'pong';
    };
