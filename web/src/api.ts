import type {
  AnyGameState,
  Commentary,
  ErrorCode,
  RoomView,
  StoneColor,
} from '@arena/shared';

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
      '连不上棋局服务，请确认后端已经启动。',
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

export const api = {
  getRoom(roomId: string): Promise<RoomView> {
    return request<RoomView>(roomPath(roomId));
  },

  newGame(roomId: string, agentColor: StoneColor): Promise<AnyGameState> {
    return request<MutationPayload>(roomPath(roomId, '/games'), {
      method: 'POST',
      body: JSON.stringify({ agentColor }),
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
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return '发生未知错误。';
}
