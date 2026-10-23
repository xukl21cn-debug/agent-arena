import {
  type ErrorRequestHandler,
  Router,
  type Request,
  type Response,
} from 'express';
import {
  type Actor,
  type CommentaryKind,
  type CommentaryMood,
  type ErrorCode,
  type ErrorResponse,
  type PlayerSpec,
  type RuleSet,
  type StoneColor,
} from '@gomoku/shared';
import { clampWaitMs, type ServerConfig } from '../config.js';
import { assertRoomId, type RoomManager } from '../rooms/room-manager.js';
import { RoomError, type GameRoom } from '../rooms/room.js';

const COMMENTARY_KINDS: readonly CommentaryKind[] = [
  'evaluation',
  'position',
  'reaction',
  'result',
  'banter',
];

const COMMENTARY_MOODS: readonly CommentaryMood[] = [
  'neutral',
  'confident',
  'happy',
  'nervous',
  'surprised',
  'sad',
];

const PARTICIPANT_KINDS = ['human', 'agent', 'remote'] as const;

export function statusForCode(code: ErrorCode): number {
  switch (code) {
    case 'ROOM_NOT_FOUND':
      return 404;
    case 'ROOM_EXISTS':
      return 409;
    case 'GAME_NOT_PLAYING':
      return 409;
    case 'NOT_YOUR_TURN':
      return 409;
    case 'INTERNAL_ERROR':
      return 500;
    case 'BACKEND_UNAVAILABLE':
      return 503;
    default:
      return 400;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyOf(req: Request): Record<string, unknown> {
  if (req.body === undefined || req.body === null) {
    return {};
  }
  if (!isRecord(req.body)) {
    throw new RoomError('INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  return req.body;
}

function queryValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function actorOf(value: unknown, fallback: Actor): Actor {
  if (value === undefined) {
    return fallback;
  }
  if (value === 'human' || value === 'agent') {
    return value;
  }
  throw new RoomError('INVALID_REQUEST', 'actor must be "human" or "agent".');
}

function colorOf(value: unknown): StoneColor | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'black' || value === 'white') {
    return value;
  }
  throw new RoomError('INVALID_REQUEST', 'agentColor must be "black" or "white".');
}

function integerOf(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RoomError('INVALID_REQUEST', `${name} must be an integer.`);
  }
  return value;
}

function roomIdOf(value: unknown, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string') {
    throw new RoomError('INVALID_ROOM_ID', 'roomId must be a string.');
  }
  return value;
}

function seatOf(value: unknown, color: StoneColor): PlayerSpec {
  if (!isRecord(value)) {
    throw new RoomError(
      'INVALID_REQUEST',
      `seats.${color} must be an object like { "kind": "human" }.`,
    );
  }

  const kind = value.kind;
  if (
    typeof kind !== 'string' ||
    !(PARTICIPANT_KINDS as readonly string[]).includes(kind)
  ) {
    throw new RoomError(
      'INVALID_REQUEST',
      `seats.${color}.kind must be one of ${PARTICIPANT_KINDS.join(', ')}.`,
    );
  }

  const name = value.name;
  if (name !== undefined && typeof name !== 'string') {
    throw new RoomError(
      'INVALID_REQUEST',
      `seats.${color}.name must be a string.`,
    );
  }

  return name === undefined
    ? { kind: kind as PlayerSpec['kind'] }
    : { kind: kind as PlayerSpec['kind'], name };
}

function seatsOf(value: unknown): Record<StoneColor, PlayerSpec> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new RoomError('INVALID_REQUEST', 'seats must be an object.');
  }
  return {
    black: seatOf(value.black, 'black'),
    white: seatOf(value.white, 'white'),
  };
}

function rulesOf(value: unknown): Partial<RuleSet> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new RoomError('INVALID_REQUEST', 'rules must be an object.');
  }

  const rules: Partial<RuleSet> = {};
  if (value.boardSize !== undefined) {
    rules.boardSize = integerOf(value.boardSize, 'rules.boardSize');
  }
  if (value.winLength !== undefined) {
    rules.winLength = integerOf(value.winLength, 'rules.winLength');
  }
  if (value.overlineWin !== undefined) {
    if (typeof value.overlineWin !== 'boolean') {
      throw new RoomError('INVALID_REQUEST', 'rules.overlineWin must be a boolean.');
    }
    rules.overlineWin = value.overlineWin;
  }
  if (value.forbidden !== undefined) {
    if (value.forbidden !== 'none') {
      throw new RoomError('INVALID_REQUEST', 'rules.forbidden only supports "none" in v1.');
    }
    rules.forbidden = 'none';
  }
  return rules;
}

function commentaryKindOf(value: unknown): CommentaryKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    !COMMENTARY_KINDS.includes(value as CommentaryKind)
  ) {
    throw new RoomError(
      'INVALID_REQUEST',
      `kind must be one of ${COMMENTARY_KINDS.join(', ')}.`,
    );
  }
  return value as CommentaryKind;
}

function commentaryMoodOf(value: unknown): CommentaryMood | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    !COMMENTARY_MOODS.includes(value as CommentaryMood)
  ) {
    throw new RoomError(
      'INVALID_REQUEST',
      `mood must be one of ${COMMENTARY_MOODS.join(', ')}.`,
    );
  }
  return value as CommentaryMood;
}

function roomOrThrow(manager: RoomManager, rawRoomId: unknown): GameRoom {
  assertRoomId(rawRoomId);
  const room = manager.get(rawRoomId);
  if (!room) {
    throw new RoomError('ROOM_NOT_FOUND', `Room "${rawRoomId}" not found.`);
  }
  return room;
}

/** Re-throw engine rule validation errors as client errors. */
function asInvalidRequest(error: unknown): never {
  if (error instanceof RoomError) {
    throw error;
  }
  if (error instanceof Error) {
    throw new RoomError('INVALID_REQUEST', error.message);
  }
  throw error;
}

function createRoomOrThrow(
  manager: RoomManager,
  roomId: string,
  config: { seats?: Record<StoneColor, PlayerSpec>; rules?: Partial<RuleSet> },
): GameRoom {
  assertRoomId(roomId);
  try {
    return manager.create(roomId, config);
  } catch (error) {
    return asInvalidRequest(error);
  }
}

/**
 * REST API used by the browser and, through the stdio bridge, by MCP clients.
 * Every mutation is delegated to the owning GameRoom.
 */
export function createApiRouter(
  manager: RoomManager,
  config: ServerConfig,
): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/rooms', (_req, res) => {
    res.json(manager.list());
  });

  router.post('/rooms', (req, res) => {
    const body = bodyOf(req);
    const roomId = roomIdOf(body.roomId, manager.defaultRoomId);

    const room = createRoomOrThrow(manager, roomId, {
      seats: seatsOf(body.seats),
      rules: rulesOf(body.rules),
    });

    res.status(201).json(room.getView());
  });

  router.get('/rooms/:roomId', (req, res) => {
    res.json(roomOrThrow(manager, req.params.roomId).getView());
  });

  router.post('/rooms/:roomId/games', (req, res) => {
    const room = roomOrThrow(manager, req.params.roomId);
    const body = bodyOf(req);
    const state = room.newGame({ agentColor: colorOf(body.agentColor) });
    res.json({ state, history: [...room.getHistory()] });
  });

  router.post('/rooms/:roomId/moves', (req, res) => {
    const room = roomOrThrow(manager, req.params.roomId);
    const body = bodyOf(req);
    const row = integerOf(body.row, 'row');
    const col = integerOf(body.col, 'col');
    const actor = actorOf(body.actor, 'human');

    const result = room.moveBy(actor, row, col);
    if (!result.ok) {
      const payload: ErrorResponse = {
        error: { code: result.code, message: result.message },
        state: result.state,
        history: [...room.getHistory()],
      };
      res.status(statusForCode(result.code)).json(payload);
      return;
    }

    res.json({ state: result.state, history: [...room.getHistory()] });
  });

  router.post('/rooms/:roomId/resign', (req, res) => {
    const room = roomOrThrow(manager, req.params.roomId);
    const body = bodyOf(req);
    const actor = actorOf(body.actor, 'human');

    const result = room.resignBy(actor);
    if (!result.ok) {
      const payload: ErrorResponse = {
        error: { code: result.code, message: result.message },
        state: result.state,
        history: [...room.getHistory()],
      };
      res.status(statusForCode(result.code)).json(payload);
      return;
    }

    res.json({ state: result.state, history: [...room.getHistory()] });
  });

  router.post('/rooms/:roomId/commentary', (req, res) => {
    const room = roomOrThrow(manager, req.params.roomId);
    const body = bodyOf(req);

    if (typeof body.text !== 'string') {
      throw new RoomError('INVALID_REQUEST', 'text must be a string.');
    }

    const commentary = room.say(
      body.text,
      commentaryKindOf(body.kind),
      commentaryMoodOf(body.mood),
    );
    res.json(commentary);
  });

  router.get('/rooms/:roomId/wait-for-turn', async (req, res) => {
    const room = roomOrThrow(manager, req.params.roomId);
    const actor = actorOf(queryValue(req.query.actor), 'agent');
    const seat = room.getSeatFor(actor);
    if (!seat) {
      // Returned directly (not thrown) so state and history ride along,
      // matching what the in-process MCP API reports for this failure.
      const payload: ErrorResponse = {
        error: {
          code: 'NO_AGENT_SEAT',
          message: `Room "${room.id}" has no ${actor} seat.`,
        },
        state: room.getState(),
        history: [...room.getHistory()],
      };
      res.status(statusForCode('NO_AGENT_SEAT')).json(payload);
      return;
    }

    const timeoutMs = clampWaitMs(queryValue(req.query.timeoutMs), config);
    const result = await room.waitForSeat(seat, timeoutMs);
    res.json({
      state: result.state,
      yourColor: room.getAgentSeat(),
      reason: result.reason,
      history: [...room.getHistory()],
    });
  });

  return router;
}

export function apiErrorHandler(): ErrorRequestHandler {
  return (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof RoomError) {
      const payload: ErrorResponse = {
        error: { code: error.code, message: error.message },
      };
      res.status(statusForCode(error.code)).json(payload);
      return;
    }

    const type = isRecord(error) ? error.type : undefined;
    if (type === 'entity.parse.failed') {
      const payload: ErrorResponse = {
        error: { code: 'INVALID_REQUEST', message: 'Request body is not valid JSON.' },
      };
      res.status(400).json(payload);
      return;
    }
    if (type === 'entity.too.large') {
      const payload: ErrorResponse = {
        error: { code: 'INVALID_REQUEST', message: 'Request body is too large.' },
      };
      res.status(413).json(payload);
      return;
    }

    console.error('[api] unhandled error', error);
    const payload: ErrorResponse = {
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
    };
    res.status(500).json(payload);
  };
}
