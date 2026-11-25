import type {
  AnyGameState,
  ArchiveSummary,
  ChatMemberFrame,
  ChatMessageFrame,
  ChatRoomFrame,
  Commentary,
  ErrorCode,
  ReplayResponse,
  RoomSummary,
  RoomView,
  RunnerCommand,
  RunnerCommandKind,
  RunnerDetail,
  RunnerSummary,
  StoneColor,
  WorkTask,
} from '@arena/shared';

/**
 * The chat list's own contract, mirrored client-side: it is the chat
 * domain's summary (served by its own router), deliberately not a shared
 * type — the two domains do not merge their endpoints.
 */
export interface ChatRoomSummaryDto {
  id: string;
  title: string;
  phase: 'open' | 'paused' | 'closed';
  memberCount: number;
  agentCount: number;
  messageCount: number;
  hop: number;
  maxHops: number;
  updatedAt: string;
}

interface ErrorPayload {
  error?: {
    code?: string;
    message?: string;
  };
  state?: AnyGameState;
}

interface MutationPayload {
  state: AnyGameState;
}

export class ApiError extends Error {
  readonly code: ErrorCode | 'NETWORK_ERROR';
  readonly state: AnyGameState | null;

  constructor(
    code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    state: AnyGameState | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.state = state;
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(
      'NETWORK_ERROR',
      path.startsWith('/api/work/') ? '连不上工作服务。' : '连不上棋局服务，请确认后端已经启动。',
    );
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorPayload = (payload ?? {}) as ErrorPayload;
    const code = errorPayload.error?.code;
    const message =
      errorPayload.error?.message ?? `请求失败 (HTTP ${response.status})。`;
    throw new ApiError(
      typeof code === 'string' ? (code as ErrorCode) : 'INTERNAL_ERROR',
      message,
      errorPayload.state ?? null,
    );
  }

  return payload as T;
}

function roomPath(roomId: string, suffix = ''): string {
  return `/api/rooms/${encodeURIComponent(roomId)}${suffix}`;
}

function chatPath(roomId: string, suffix = ''): string {
  return `/api/chat/rooms/${encodeURIComponent(roomId)}${suffix}`;
}

/**
 * The chat REST snapshot keeps the domain policy object; the wire frame the
 * UI consumes flattens it. Local mirror of the server's response shape.
 */
interface ChatRoomRestSnapshot {
  id: string;
  title: string;
  phase: 'open' | 'paused' | 'closed';
  policy: {
    maxHops: number;
    maxMessagesPerMember: number;
    turnTimeoutMs: number;
  };
  seq: number;
  hop: number;
  turn: { participantId: string; name: string } | null;
  members: ChatMemberFrame[];
  messageCount: number;
}

function chatRoomFrameOf(rest: ChatRoomRestSnapshot): ChatRoomFrame {
  return {
    id: rest.id,
    title: rest.title,
    phase: rest.phase,
    seq: rest.seq,
    hop: rest.hop,
    maxHops: rest.policy.maxHops,
    maxMessagesPerMember: rest.policy.maxMessagesPerMember,
    turnTimeoutMs: rest.policy.turnTimeoutMs,
    turn: rest.turn,
    members: rest.members,
    messageCount: rest.messageCount,
  };
}

export const api = {
  workTask: (id: string) => request<WorkTask>('/api/work/tasks/' + encodeURIComponent(id)),
  approveWorkMerge: (id: string) => request<WorkTask>('/api/work/tasks/' + encodeURIComponent(id) + '/approve-merge', {
    method: 'POST', body: '{}',
  }),
  takeOverWork: (id: string, reason: string) => request<WorkTask>('/api/work/tasks/' + encodeURIComponent(id) + '/takeover', {
    method: 'POST', body: JSON.stringify({ reason }),
  }),
  listRunners: (): Promise<RunnerSummary[]> => request<RunnerSummary[]>('/api/runners'),
  runnerDetail: (id: string): Promise<RunnerDetail> => request<RunnerDetail>(
    '/api/runners/' + encodeURIComponent(id),
  ),
  runnerCommand: (id: string, kind: RunnerCommandKind, taskId?: string): Promise<RunnerCommand> => request<RunnerCommand>(
    '/api/runners/' + encodeURIComponent(id) + '/commands',
    { method: 'POST', body: JSON.stringify({ kind, ...(taskId === undefined ? {} : { taskId }) }) },
  ),
  getRoom(roomId: string): Promise<RoomView> {
    return request<RoomView>(roomPath(roomId));
  },

  newGame(
    roomId: string,
    agentColor: StoneColor,
    game: 'gomoku' | 'go' = 'gomoku',
  ): Promise<AnyGameState> {
    return request<MutationPayload>(roomPath(roomId, '/games'), {
      method: 'POST',
      body: JSON.stringify({ agentColor, game }),
    }).then((payload) => payload.state);
  },

  move(roomId: string, row: number, col: number): Promise<AnyGameState> {
    return request<MutationPayload>(roomPath(roomId, '/moves'), {
      method: 'POST',
      body: JSON.stringify({ row, col, actor: 'human' }),
    }).then((payload) => payload.state);
  },

  resign(roomId: string): Promise<AnyGameState> {
    return request<MutationPayload>(roomPath(roomId, '/resign'), {
      method: 'POST',
      body: JSON.stringify({ actor: 'human' }),
    }).then((payload) => payload.state);
  },

  /** Go only: forgo this move; two consecutive passes enter scoring. */
  pass(roomId: string): Promise<AnyGameState> {
    return request<MutationPayload>(roomPath(roomId, '/pass'), {
      method: 'POST',
      body: JSON.stringify({ actor: 'human' }),
    }).then((payload) => payload.state);
  },

  /** Go scoring only: toggle the whole block at (row, col) as dead. */
  markDead(roomId: string, row: number, col: number): Promise<AnyGameState> {
    return request<MutationPayload>(roomPath(roomId, '/dead-stones'), {
      method: 'POST',
      body: JSON.stringify({ row, col, actor: 'human' }),
    }).then((payload) => payload.state);
  },

  /** Go scoring only: accept the score under the current dead-stone marks. */
  confirmScore(roomId: string): Promise<AnyGameState> {
    return request<MutationPayload>(roomPath(roomId, '/score/confirm'), {
      method: 'POST',
      body: JSON.stringify({ actor: 'human' }),
    }).then((payload) => payload.state);
  },

  /** Go scoring only: back out of scoring and keep playing. */
  resumePlay(roomId: string): Promise<AnyGameState> {
    return request<MutationPayload>(roomPath(roomId, '/score/resume'), {
      method: 'POST',
      body: JSON.stringify({ actor: 'human' }),
    }).then((payload) => payload.state);
  },

  /**
   * Lobby ready. The server seats this browser's human participant on first
   * press, so no participantId is needed here.
   */
  ready(roomId: string, ready: boolean): Promise<RoomView> {
    return request<RoomView>(roomPath(roomId, '/ready'), {
      method: 'POST',
      body: JSON.stringify({ ready }),
    });
  },

  say(
    roomId: string,
    text: string,
    kind?: Commentary['kind'],
    mood?: Commentary['mood'],
  ): Promise<Commentary> {
    return request<Commentary>(roomPath(roomId, '/commentary'), {
      method: 'POST',
      body: JSON.stringify({ text, kind, mood, actor: 'human' }),
    });
  },

  /** Speak as the host. `to` names the agent the turn goes to next. */
  chatSend(
    roomId: string,
    text: string,
    to?: string,
  ): Promise<{ message: ChatMessageFrame; room: ChatRoomFrame }> {
    return request<{ message: ChatMessageFrame; room: ChatRoomRestSnapshot }>(
      chatPath(roomId, '/messages'),
      {
        method: 'POST',
        body: JSON.stringify({ text, ...(to === undefined ? {} : { to }) }),
      },
    ).then(({ message, room }) => ({
      message,
      room: chatRoomFrameOf(room),
    }));
  },

  /** Closed-room export: the server renders the transcript as Markdown text. */
  chatTranscript(
    roomId: string,
    limit: number,
  ): Promise<{ format: 'md'; omitted: number; text: string }> {
    const query = new URLSearchParams({
      format: 'md',
      limit: String(Math.max(1, Math.floor(limit))),
    });
    return request<{ format: 'md'; omitted: number; text: string }>(
      `${chatPath(roomId, '/transcript')}?${query.toString()}`,
    );
  },

  /** Host phase controls; the room comes back as the wire frame. */
  chatControl(
    roomId: string,
    action: 'pause' | 'resume' | 'close',
  ): Promise<ChatRoomFrame> {
    return request<{ room: ChatRoomRestSnapshot }>(
      chatPath(roomId, `/${action}`),
      { method: 'POST' },
    ).then(({ room }) => chatRoomFrameOf(room));
  },

  /** Every frame of the room's current game, computed once server-side. */
  getRoomReplay(roomId: string): Promise<ReplayResponse> {
    return request<ReplayResponse>(roomPath(roomId, '/replay'));
  },

  /** The same payload for an archived game. */
  getArchiveReplay(archiveId: string): Promise<ReplayResponse> {
    return request<ReplayResponse>(
      `/api/archive/${encodeURIComponent(archiveId)}/replay`,
    );
  },

  /** Game rooms, for the lobby. */
  listRooms(): Promise<RoomSummary[]> {
    return request<RoomSummary[]>('/api/rooms');
  },

  /** Chat rooms, for the lobby; a separate domain with its own summary. */
  listChatRooms(): Promise<ChatRoomSummaryDto[]> {
    return request<ChatRoomSummaryDto[]>('/api/chat/rooms');
  },

  /**
   * Create a room. The server picks the id (`game-<6 hex>`), so the lobby never
   * has to invent one — and never lands on `default`, which always exists.
   */
  createRoom(): Promise<string> {
    return request<RoomView>('/api/rooms', { method: 'POST', body: '{}' }).then(
      (view) => view.state.roomId,
    );
  },

  /**
   * Create a chat room. `title` and the caps are optional: an empty title
   * falls back to the generated id, and omitted caps take the domain defaults.
   */
  createChatRoom(
    options: {
      title?: string;
      maxHops?: number;
      maxMessagesPerMember?: number;
      /** Seconds one member may hold the turn before it is skipped. */
      turnTimeoutMs?: number;
    } = {},
  ): Promise<string> {
    const policy: Record<string, number> = {};
    if (options.maxHops !== undefined) {
      policy.maxHops = options.maxHops;
    }
    if (options.maxMessagesPerMember !== undefined) {
      policy.maxMessagesPerMember = options.maxMessagesPerMember;
    }
    if (options.turnTimeoutMs !== undefined) {
      policy.turnTimeoutMs = options.turnTimeoutMs;
    }
    const title = options.title?.trim() ?? '';
    return request<{ room: ChatRoomRestSnapshot }>('/api/chat/rooms', {
      method: 'POST',
      body: JSON.stringify({
        ...(title === '' ? {} : { title }),
        ...(Object.keys(policy).length === 0 ? {} : { policy }),
      }),
    }).then(({ room }) => room.id);
  },

  /** Host tuning of the caps; the room comes back as the wire frame. */
  chatSetPolicy(
    roomId: string,
    policy: {
      maxHops?: number;
      maxMessagesPerMember?: number;
      turnTimeoutMs?: number;
    },
  ): Promise<ChatRoomFrame> {
    return request<{ room: ChatRoomRestSnapshot }>(
      chatPath(roomId, '/policy'),
      { method: 'POST', body: JSON.stringify({ policy }) },
    ).then(({ room }) => chatRoomFrameOf(room));
  },

  /** Delete a game room. Its archived games survive, so replays keep working. */
  deleteRoom(roomId: string): Promise<void> {
    return request<void>(roomPath(roomId), { method: 'DELETE' });
  },

  /** Delete a chat room; the server refuses an unclosed transcript. */
  deleteChatRoom(roomId: string): Promise<void> {
    return request<void>(chatPath(roomId), { method: 'DELETE' });
  },

  /**
   * Archived games, newest played first — the server already ordered them,
   * so the caller must not re-sort. Null when the surface is absent or
   * failing: the lobby degrades to "no history" instead of breaking, which
   * keeps it working before the archive stage is deployed.
   */
  async listArchives(): Promise<ArchiveSummary[] | null> {
    try {
      const response = await fetch('/api/archive');
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as ArchiveSummary[];
    } catch {
      return null;
    }
  },
};

export { errorMessage } from './errors';
