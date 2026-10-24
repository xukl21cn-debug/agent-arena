import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type {
  AgentStateResponse,
  AgentStateView,
  AgentWaitForTurnResponse,
  Commentary,
  CommentaryKind,
  CommentaryMood,
  StoneColor,
} from '@gomoku/shared';
import { AGENT_RECENT_MOVES } from '@gomoku/shared';
import { clampWaitMs, type ServerConfig } from '../config.js';
import {
  toAgentStateView,
  type AgentViewOptions,
} from '../core/insights.js';
import { currentSession, sessionContext } from '../core/session-context.js';
import { RoomError, type GameRoom } from '../rooms/room.js';
import { assertRoomId, type RoomManager } from '../rooms/room-manager.js';
import { GomokuApiError, type GomokuApi } from './api.js';
import { registerTools, SERVER_INSTRUCTIONS } from './tools.js';

function checkRoomId(roomId: string): void {
  try {
    assertRoomId(roomId);
  } catch (error) {
    if (error instanceof RoomError) {
      throw new GomokuApiError(error.code, error.message);
    }
    throw error;
  }
}

/** Build the agent-facing view of a room's current game. */
function agentView(room: GameRoom, options?: AgentViewOptions): AgentStateView {
  return toAgentStateView(room.getState(), room.getHistory(), options);
}

/** Hot-path responses keep only recent moves; get_state returns everything. */
const RECENT: AgentViewOptions = { recentMoves: AGENT_RECENT_MOVES };

/**
 * `GomokuApi` backed by the RoomManager living in this process. This is the
 * same object graph the web UI mutates, so there is exactly one game state.
 */
export class InProcessApi implements GomokuApi {
  constructor(
    private readonly manager: RoomManager,
    private readonly config: Pick<ServerConfig, 'waitDefaultMs' | 'waitMaxMs'>,
  ) {}

  /**
   * Record that this seat is alive: bind the calling MCP session to the room
   * the first time it touches it, and refresh the seat's activity stamp.
   *
   * The session binding is what lets presence say `idle`/`thinking` instead of
   * decaying to `disconnected` between two slow tool calls.
   */
  private notePresence(roomId: string, seat: StoneColor | null): void {
    if (!seat) {
      return;
    }
    const presence = this.manager.presenceSource;
    if (!presence) {
      return;
    }
    const session = currentSession();
    if (session?.sessionId) {
      presence.attachSession(roomId, seat, session.sessionId, session.client);
    }
    presence.touch(roomId, seat);
  }

  async newGame(
    roomId: string,
    agentColor?: StoneColor,
  ): Promise<AgentStateResponse> {
    const room = this.getOrCreateRoom(roomId);
    room.newGame({ agentColor });
    this.notePresence(roomId, room.getAgentSeat());
    return { state: agentView(room), yourColor: room.getAgentSeat() };
  }

  async getState(roomId: string): Promise<AgentStateResponse> {
    const room = this.requireRoom(roomId);
    this.notePresence(roomId, room.getAgentSeat());
    return { state: agentView(room), yourColor: room.getAgentSeat() };
  }

  async waitForTurn(
    roomId: string,
    timeoutMs: number,
  ): Promise<AgentWaitForTurnResponse> {
    const room = this.requireRoom(roomId);
    const seat = room.getAgentSeat();
    if (!seat) {
      throw new GomokuApiError(
        'NO_AGENT_SEAT',
        `Room "${roomId}" has no agent seat. Start a game with an agent color.`,
        room.getState(),
        room.getHistory(),
      );
    }

    // A parked long-poll is the strongest evidence that this seat is alive, so
    // it is registered for the whole time the call hangs.
    this.notePresence(roomId, seat);
    const releaseWait = this.manager.presenceSource?.beginWait(roomId, seat);
    let result;
    try {
      result = await room.waitForSeat(
        seat,
        clampWaitMs(timeoutMs, this.config),
      );
    } finally {
      releaseWait?.();
    }
    return { state: agentView(room, RECENT), yourColor: seat, reason: result.reason };
  }

  async placeStone(
    roomId: string,
    row: number,
    col: number,
  ): Promise<AgentStateView> {
    const room = this.requireRoom(roomId);
    this.notePresence(roomId, room.getAgentSeat());
    const result = room.moveBy('agent', row, col);
    if (!result.ok) {
      throw new GomokuApiError(
        result.code,
        result.message,
        result.state,
        room.getHistory(),
      );
    }
    return agentView(room, RECENT);
  }

  async resign(roomId: string): Promise<AgentStateView> {
    const room = this.requireRoom(roomId);
    this.notePresence(roomId, room.getAgentSeat());
    const result = room.resignBy('agent');
    if (!result.ok) {
      throw new GomokuApiError(
        result.code,
        result.message,
        result.state,
        room.getHistory(),
      );
    }
    return agentView(room, RECENT);
  }

  async say(
    roomId: string,
    text: string,
    kind?: CommentaryKind,
    mood?: CommentaryMood,
  ): Promise<Commentary> {
    const room = this.requireRoom(roomId);
    this.notePresence(roomId, room.getAgentSeat());
    try {
      return room.say(text, kind, mood);
    } catch (error) {
      if (error instanceof RoomError) {
        throw new GomokuApiError(
          error.code,
          error.message,
          room.getState(),
          room.getHistory(),
        );
      }
      throw error;
    }
  }

  private requireRoom(roomId: string): GameRoom {
    checkRoomId(roomId);
    const room = this.manager.get(roomId);
    if (!room) {
      throw new GomokuApiError('ROOM_NOT_FOUND', `Room "${roomId}" not found.`);
    }
    return room;
  }

  private getOrCreateRoom(roomId: string): GameRoom {
    checkRoomId(roomId);
    return this.manager.getOrCreate(roomId);
  }
}

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function jsonRpcError(code: number, message: string): unknown {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

function sessionIdOf(req: Request): string | undefined {
  const header = req.headers['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
}

/** `clientInfo.name` reported during initialize, when the session has one. */
function clientName(session: McpSession): string | undefined {
  return session.server.server.getClientVersion()?.name;
}

/**
 * Mounts the MCP Streamable HTTP endpoint at POST/GET/DELETE /mcp.
 * One McpServer + transport per session, all sharing the same RoomManager.
 */
export function mountMcpHttp(
  app: Express,
  manager: RoomManager,
  config: ServerConfig,
): void {
  const sessions = new Map<string, McpSession>();
  const api = new InProcessApi(manager, config);

  const createMcpServer = (): McpServer => {
    const server = new McpServer(
      { name: 'gomoku', version: '0.1.0' },
      { instructions: SERVER_INSTRUCTIONS },
    );
    registerTools(server, api);
    return server;
  };

  const sendBadRequest = (res: Response, message: string): void => {
    res.status(400).json(jsonRpcError(-32000, message));
  };

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = sessionIdOf(req);

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          res.status(404).json(jsonRpcError(-32001, 'Session not found'));
          return;
        }
        // Carry the session identity into the tool call so presence can bind
        // this agent to the room it plays in.
        await sessionContext.run(
          {
            sessionId,
            ...(clientName(existing) === undefined
              ? {}
              : { client: clientName(existing) }),
          },
          () => existing.transport.handleRequest(req, res, req.body),
        );
        return;
      }

      if (!isInitializeRequest(req.body)) {
        sendBadRequest(res, 'Bad Request: No valid session ID provided');
        return;
      }

      let session: McpSession | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          if (session) {
            sessions.set(newSessionId, session);
          }
        },
      });

      const server = createMcpServer();
      session = { server, transport };

      transport.onclose = () => {
        const closedId = transport.sessionId;
        if (closedId) {
          sessions.delete(closedId);
          // A closed session is a confirmed disconnect: forget it everywhere.
          manager.presenceSource?.detachSession(closedId);
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[mcp] POST /mcp failed', error);
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
      }
    }
  });

  // Optional server-initiated SSE stream for notifications.
  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = sessionIdOf(req);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      sendBadRequest(res, 'Bad Request: Invalid or missing session ID');
      return;
    }

    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      console.error('[mcp] GET /mcp failed', error);
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
      }
    }
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = sessionIdOf(req);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      sendBadRequest(res, 'Bad Request: Invalid or missing session ID');
      return;
    }

    try {
      await session.transport.handleRequest(req, res);
      sessions.delete(sessionId!);
      // A DELETE is a client saying goodbye. The transport's own close hook is
      // not guaranteed to fire on every path, so detach here explicitly — a
      // departed agent must stop reading as connected.
      manager.presenceSource?.detachSession(sessionId!);
    } catch (error) {
      console.error('[mcp] DELETE /mcp failed', error);
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
      }
    }
  });
}
