#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type {
  AgentStateResponse,
  AgentWaitForTurnResponse,
  AnyAgentStateView,
  AnyGameState,
  AnyMove,
  Commentary,
  CommentaryKind,
  CommentaryMood,
  ErrorCode,
  MutationResponse,
  RoomView,
  StoneColor,
  WaitForTurnResponse,
} from '@arena/shared';
import { AGENT_RECENT_MOVES } from '@arena/shared';
import { resolveServerUrl } from '../config.js';
import {
  toAnyAgentStateView,
  type AgentViewOptions,
} from '../core/insights.js';
import {
  agentColorOf,
  ArenaApiError,
  type AgentJoinResponse,
  type ArenaApi,
} from './api.js';
import { registerTools, SERVER_INSTRUCTIONS } from './tools.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Hot-path responses keep only recent moves; get_state returns everything. */
const RECENT: AgentViewOptions = { recentMoves: AGENT_RECENT_MOVES };

/**
 * `ArenaApi` that proxies to a running arena server over REST. Used by the
 * stdio bridge, which deliberately holds no game state of its own. REST
 * responses carry the move history so the bridge can build the same
 * agent-facing views (boardText / moves / hotPoints) as the in-process API.
 */
export class HttpApi implements ArenaApi {
  private readonly baseUrl: string;
  /** Participant id this bridge claimed, sent on every later request. */
  private participantId: string | undefined;

  constructor(baseUrl: string = resolveServerUrl()) {
    this.baseUrl = baseUrl;
  }

  async joinGame(
    roomId: string,
    options: {
      name?: string;
      seat?: StoneColor;
      kind?: 'agent' | 'human';
      ready?: boolean;
    } = {},
  ): Promise<AgentJoinResponse> {
    const payload = await this.request<{
      participantId: string;
      name: string;
      seat: StoneColor | null;
      phase: AgentJoinResponse['phase'];
      state: AnyGameState;
      history: AnyMove[];
      participants: AgentJoinResponse['participants'];
    }>(
      'POST',
      `/api/rooms/${encodeURIComponent(roomId)}/participants`,
      options,
    );
    // Remember the id: the bridge holds no server-side session, so it has to
    // present its identity on every later call itself.
    this.participantId = payload.participantId;
    return {
      participantId: payload.participantId,
      name: payload.name,
      seat: payload.seat,
      phase: payload.phase,
      state: toAnyAgentStateView(payload.state, payload.history),
      participants: payload.participants,
    };
  }

  async leaveGame(roomId: string): Promise<{ ok: boolean }> {
    if (this.participantId === undefined) {
      return { ok: false };
    }
    const payload = await this.request<{ ok: boolean }>(
      'DELETE',
      `/api/rooms/${encodeURIComponent(roomId)}/participants/${encodeURIComponent(this.participantId)}`,
    );
    this.participantId = undefined;
    return payload;
  }

  async newGame(
    roomId: string,
    agentColor?: StoneColor,
  ): Promise<AgentStateResponse> {
    const payload = await this.request<MutationResponse>(
      'POST',
      `/api/rooms/${encodeURIComponent(roomId)}/games`,
      agentColor === undefined ? {} : { agentColor },
    );
    const state = payload.state;
    return {
      state: toAnyAgentStateView(state, payload.history),
      yourColor: agentColorOf(state),
    };
  }

  async getState(roomId: string): Promise<AgentStateResponse> {
    const view = await this.request<RoomView>(
      'GET',
      `/api/rooms/${encodeURIComponent(roomId)}`,
    );
    return {
      state: toAnyAgentStateView(view.state, view.history),
      yourColor: agentColorOf(view.state),
    };
  }

  async waitForTurn(
    roomId: string,
    timeoutMs: number,
  ): Promise<AgentWaitForTurnResponse> {
    const payload = await this.request<WaitForTurnResponse>(
      'GET',
      `/api/rooms/${encodeURIComponent(roomId)}/wait-for-turn?actor=agent&timeoutMs=${encodeURIComponent(String(timeoutMs))}`,
    );
    return {
      state: toAnyAgentStateView(payload.state, payload.history, RECENT),
      yourColor: payload.yourColor,
      reason: payload.reason,
    };
  }

  async placeStone(
    roomId: string,
    row: number,
    col: number,
  ): Promise<AnyAgentStateView> {
    const payload = await this.request<MutationResponse>(
      'POST',
      `/api/rooms/${encodeURIComponent(roomId)}/moves`,
      { row, col, actor: 'agent' },
    );
    return toAnyAgentStateView(payload.state, payload.history, RECENT);
  }

  async resign(roomId: string): Promise<AnyAgentStateView> {
    const payload = await this.request<MutationResponse>(
      'POST',
      `/api/rooms/${encodeURIComponent(roomId)}/resign`,
      { actor: 'agent' },
    );
    return toAnyAgentStateView(payload.state, payload.history, RECENT);
  }

  async say(
    roomId: string,
    text: string,
    kind?: CommentaryKind,
    mood?: CommentaryMood,
  ): Promise<Commentary> {
    return this.request<Commentary>(
      'POST',
      `/api/rooms/${encodeURIComponent(roomId)}/commentary`,
      { text, kind, mood, actor: 'agent' },
    );
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);

    // The bridge has no server-side session, so it identifies itself with a
    // header the REST layer resolves back to a participant.
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (this.participantId !== undefined) {
      headers['x-arena-participant'] = this.participantId;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ArenaApiError(
        'BACKEND_UNAVAILABLE',
        `无法连接 arena 后端 ${this.baseUrl}。请先运行 "pnpm start"（生产）或 "pnpm dev"（开发）启动服务，然后重试。(${detail})`,
      );
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw this.toApiError(payload, response.status);
    }

    if (payload === null) {
      throw new ArenaApiError(
        'INTERNAL_ERROR',
        `后端返回了非 JSON 响应 (HTTP ${response.status})。`,
      );
    }

    return payload as T;
  }

  private toApiError(payload: unknown, status: number): ArenaApiError {
    if (isRecord(payload) && isRecord(payload.error)) {
      const { code, message } = payload.error;
      const state = isRecord(payload.state)
        ? (payload.state as unknown as AnyGameState)
        : null;
      const history = Array.isArray(payload.history)
        ? (payload.history as unknown as AnyMove[])
        : null;
      return new ArenaApiError(
        typeof code === 'string' ? (code as ErrorCode) : 'INTERNAL_ERROR',
        typeof message === 'string' ? message : `HTTP ${status}`,
        state,
        history,
      );
    }

    return new ArenaApiError(
      'INTERNAL_ERROR',
      `后端请求失败 (HTTP ${status})。`,
    );
  }
}

export function createStdioServer(api: ArenaApi): McpServer {
  const server = new McpServer(
    { name: 'arena', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, api);
  return server;
}

async function main(): Promise<void> {
  const serverUrl = resolveServerUrl();
  const server = createStdioServer(new HttpApi(serverUrl));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel: logs must go to stderr.
  console.error(`[agent-arena] stdio bridge ready, backend: ${serverUrl}`);
}

main().catch((error: unknown) => {
  console.error('[agent-arena] fatal error', error);
  process.exit(1);
});
