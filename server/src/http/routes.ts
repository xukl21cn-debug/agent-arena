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
  type Participant,
  type PlayerSpec,
  type RuleSet,
  type StoneColor,
} from '@arena/shared';
import { clampWaitMs, type ServerConfig } from '../config.js';
import { assertRoomId, type RoomManager } from '../rooms/room-manager.js';
import { RoomError, type ActorRef, type GameRoom } from '../rooms/room.js';

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
    case 'PARTICIPANT_NOT_FOUND':
      return 404;
    case 'ROOM_EXISTS':
    case 'GAME_NOT_PLAYING':
    case 'NOT_YOUR_TURN':
    case 'SEAT_TAKEN':
    // Two agents in one room is a conflict the caller resolves by identifying
    // itself, not a malformed request.
    case 'AMBIGUOUS_ACTOR':
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

/**
 * Record activity for whichever seat the actor occupies, so REST callers (the
 * stdio bridge included) count as present even without an MCP session.
 */
function touchActor(manager: RoomManager, room: GameRoom, actor: Actor): void {
  const seat = room.getSeatFor(actor);
  if (seat) {
    manager.presenceSource?.touch(room.id, seat);
  }
}

/**
 * How the caller identifies itself.
 *
 * The header wins so the stdio bridge — which holds no server session — can
 * present its participant id on every request. A body field is accepted for
 * callers that cannot set headers. Falling back to `actor` keeps every
 * pre-participant client working.
 */
function actorRefOf(
  req: { headers: Record<string, unknown> },
  body: Record<string, unknown>,
): ActorRef {
  const header = req.headers['x-arena-participant'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (typeof fromHeader === 'string' && fromHeader.length > 0) {
    return { participantId: fromHeader };
  }

  const fromBody = body.participantId;
  if (typeof fromBody === 'string' && fromBody.length > 0) {
    return { participantId: fromBody };
  }

  return { actor: actorOf(body.actor, 'human') };
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

  // ---- participants -------------------------------------------------------

  /** Everyone currently in the room. */
  router.get('/rooms/:roomId/participants', (req, res) => {
    const room = roomOrThrow(manager, req.params.roomId);
    res.json({ participants: room.getRoster() });
  });

  /**
   * Join (or reconnect to) the room, optionally claiming a seat.
   *
   * The stdio bridge calls this once and then sends its id on every request;
   * the web client joins as the human seat when it connects.
   */
  router.post('/rooms/:roomId/participants', (req, res) => {
    const room = roomOrThrow(manager, req.params.roomId);
    const body = bodyOf(req);

    const kind = body.kind;
    if (kind !== undefined && kind !== 'agent' && kind !== 'human' && kind !== 'remote') {
      throw new RoomError(
        'INVALID_REQUEST',
        'kind must be one of agent, human, remote.',
      );
    }

    const name = body.name;
    if (name !== undefined && typeof name !== 'string') {
      throw new RoomError('INVALID_REQUEST', 'name must be a string.');
    }

    const seat = body.seat === undefined ? undefined : colorOf(body.seat);

    const participant = room.join({
      kind: (kind as Participant['kind'] | undefined) ?? 'agent',
      ...(name === undefined ? {} : { name }),
      ...(seat === undefined ? {} : { seat }),
    });

    const view = room.getView();
    res.status(201).json({
      participantId: participant.id,
      name: participant.name,
      seat: participant.seat,
      state: view.state,
      history: view.history,
      participants: room.getRoster().map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        seat: item.seat,
      })),
    });
  });

  /** Leave the room; the seat is freed for somebody else. */
  router.delete('/rooms/:roomId/participants/:participantId', (req, res) => {
    const room = roomOrThrow(manager, req.params.roomId);
    const ok = room.leave(req.params.participantId);
    if (!ok) {
      throw new RoomError(
        'PARTICIPANT_NOT_FOUND',
        `Participant "${req.params.participantId}" is not in room "${room.id}".`,
      );
    }
    res.json({ ok: true });
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

    // Prefer the participant the caller claims (header or body); fall back to
    // the legacy actor kind, which the room resolves only while unambiguous.
    const ref = actorRefOf(req, body);
    if ('actor' in ref) {
      touchActor(manager, room, ref.actor);
    }

    const result = room.moveAs(ref, row, col);
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

    const ref = actorRefOf(req, body);
    if ('actor' in ref) {
      touchActor(manager, room, ref.actor);
    }

    const result = room.resignAs(ref);
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

    // The header identifies the stdio bridge; a query parameter serves callers
    // that cannot set one. Falling back to `actor` keeps old clients working.
    const ref = actorRefOf(
      req,
      req.query.participantId === undefined
        ? { actor: queryValue(req.query.actor) }
        : { participantId: queryValue(req.query.participantId) },
    );

    const identity = room.resolve(ref);
    if (!identity.ok) {
      // Returned directly (not thrown) so state and history ride along,
      // matching what the in-process MCP API reports for this failure.
      const payload: ErrorResponse = {
        error: { code: identity.code, message: identity.message },
        state: room.getState(),
        history: [...room.getHistory()],
      };
      res.status(statusForCode(identity.code)).json(payload);
      return;
    }
    const { seat } = identity;

    const timeoutMs = clampWaitMs(queryValue(req.query.timeoutMs), config);
    // A parked long-poll is the strongest "this seat is alive" signal, so it is
    // registered as presence evidence for the whole time it hangs.
    const releaseWait = manager.presenceSource?.beginWait(room.id, seat);
    let result;
    try {
      result = await room.waitForSeat(seat, timeoutMs);
    } finally {
      releaseWait?.();
    }
    res.json({
      state: result.state,
      yourColor: seat,
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
