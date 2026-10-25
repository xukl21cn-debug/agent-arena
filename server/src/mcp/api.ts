import type {
  AgentStateResponse,
  AgentStateView,
  AgentWaitForTurnResponse,
  Commentary,
  CommentaryKind,
  CommentaryMood,
  ErrorCode,
  GameState,
  Move,
  StoneColor,
} from '@arena/shared';

/**
 * The only surface MCP tools know about. Two implementations exist:
 * `InProcessApi` (same process as the game server) and `HttpApi` (stdio
 * bridge talking REST to a running server). Both return agent-facing views:
 * boardText + moves + hotPoints instead of the raw nested board array.
 *
 * Every method that acts on a seat resolves the caller's identity on the
 * server side (session binding, then room roster). The model never passes a
 * participant id, so it cannot act as somebody else.
 */
export interface ArenaApi {
  /**
   * Claim a seat in a room, binding this session to the resulting participant.
   *
   * Idempotent: joining again with the same name reconnects to the same
   * participant, keeping its seat and id.
   */
  joinGame(
    roomId: string,
    options?: { name?: string; seat?: StoneColor; kind?: 'agent' | 'human' },
  ): Promise<AgentJoinResponse>;
  /** Leave the room, freeing the seat. */
  leaveGame(roomId: string): Promise<{ ok: boolean }>;
  newGame(roomId: string, agentColor?: StoneColor): Promise<AgentStateResponse>;
  getState(roomId: string): Promise<AgentStateResponse>;
  waitForTurn(
    roomId: string,
    timeoutMs: number,
  ): Promise<AgentWaitForTurnResponse>;
  placeStone(roomId: string, row: number, col: number): Promise<AgentStateView>;
  resign(roomId: string): Promise<AgentStateView>;
  say(
    roomId: string,
    text: string,
    kind?: CommentaryKind,
    mood?: CommentaryMood,
  ): Promise<Commentary>;
}

/** What a successful `join_game` reports back. */
export interface AgentJoinResponse {
  /** This agent's stable id in the room. */
  participantId: string;
  name: string;
  seat: StoneColor | null;
  state: AgentStateView;
  /** Everyone else in the room, so the agent knows who it is playing. */
  participants: Array<{
    id: string;
    name: string;
    kind: string;
    seat: StoneColor | null;
  }>;
}

/**
 * Expected, model-actionable failure; carries the current state and move
 * history when known, so error views never contradict themselves.
 */
export class ArenaApiError extends Error {
  readonly code: ErrorCode;
  readonly state: GameState | null;
  readonly history: readonly Move[] | null;

  constructor(
    code: ErrorCode,
    message: string,
    state: GameState | null = null,
    history: readonly Move[] | null = null,
  ) {
    super(message);
    this.name = 'ArenaApiError';
    this.code = code;
    this.state = state;
    this.history = history;
  }
}

export function agentColorOf(state: GameState): StoneColor | null {
  if (state.seats.black.kind === 'agent') {
    return 'black';
  }
  if (state.seats.white.kind === 'agent') {
    return 'white';
  }
  return null;
}
