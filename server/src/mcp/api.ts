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
} from '@gomoku/shared';

/**
 * The only surface MCP tools know about. Two implementations exist:
 * `InProcessApi` (same process as the game server) and `HttpApi` (stdio
 * bridge talking REST to a running server). Both return agent-facing views:
 * boardText + moves + hotPoints instead of the raw nested board array.
 */
export interface GomokuApi {
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

/**
 * Expected, model-actionable failure; carries the current state and move
 * history when known, so error views never contradict themselves.
 */
export class GomokuApiError extends Error {
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
    this.name = 'GomokuApiError';
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
