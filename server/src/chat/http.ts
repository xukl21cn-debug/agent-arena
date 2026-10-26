import { Router, type Request, type RequestHandler, type Response } from 'express';
import {
  CHAT_MODES,
  CHAT_RECENT_LIMIT,
  ChatError,
  type ChatErrorCode,
  type ChatMessage,
  type ChatPolicy,
} from './model.js';
import { HUMAN_MEMBER_ID } from './chat-room.js';
import type { ChatManager } from './manager.js';

interface ChatErrorPayload {
  error: {
    code: ChatErrorCode;
    message: string;
  };
}

export function statusForChatCode(code: ChatErrorCode): number {
  switch (code) {
    case 'ROOM_NOT_FOUND':
      return 404;
    case 'ROOM_EXISTS':
    case 'ROOM_CLOSED':
    case 'ROOM_PAUSED':
    case 'NOT_YOUR_TURN':
    case 'MEMBER_LIMIT_REACHED':
      return 409;
    default:
      return 400;
  }
}

function bodyOf(req: Request): Record<string, unknown> {
  if (req.body === undefined || req.body === null) {
    return {};
  }
  if (typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new ChatError('INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  return req.body as Record<string, unknown>;
}

function textOf(body: Record<string, unknown>): string {
  if (typeof body.text !== 'string') {
    throw new ChatError('INVALID_REQUEST', 'text must be a string.');
  }
  return body.text;
}

function optionalString(
  body: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = body[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ChatError('INVALID_REQUEST', `${name} must be a string.`);
  }
  return value;
}

/** Integer policy fields with their inclusive ranges. turnTimeoutMs shares
 *  the MCP wait tool's 1s floor so a room cannot be created with a lease
 *  shorter than any client can observe. */
type ChatPolicyIntField = Exclude<keyof ChatPolicy, 'mode'>;

const CHAT_POLICY_INT_FIELDS: ReadonlyArray<
  readonly [name: ChatPolicyIntField, min: number, max: number]
> = [
  ['maxHops', 1, 1000],
  ['maxMessagesPerMember', 1, 1000],
  ['turnTimeoutMs', 1_000, 600_000],
  ['maxMessageChars', 1, 100_000],
];

function intInRange(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ChatError(
      'INVALID_REQUEST',
      `policy.${name} must be an integer.`,
    );
  }
  if (value < min || value > max) {
    throw new ChatError(
      'INVALID_REQUEST',
      `policy.${name} must be between ${min} and ${max}.`,
    );
  }
  return value;
}

/**
 * Parse and validate a policy override. Every field is checked, and an
 * unknown or out-of-range field is an error rather than a silent default —
 * silently dropping `policy` was the bug this replaces, and silently
 * dropping a misspelled field would be the same mistake again.
 */
function chatPolicyOf(raw: unknown): Partial<ChatPolicy> {
  if (raw === undefined) {
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ChatError('INVALID_REQUEST', 'policy must be an object.');
  }
  const input = raw as Record<string, unknown>;
  const known = new Set<string | number>([
    'mode',
    ...CHAT_POLICY_INT_FIELDS.map(([name]) => name),
  ]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw new ChatError('INVALID_REQUEST', `Unknown policy field "${key}".`);
    }
  }
  const policy: Partial<ChatPolicy> = {};
  if (input.mode !== undefined) {
    if (
      typeof input.mode !== 'string' ||
      !CHAT_MODES.includes(input.mode as ChatPolicy['mode'])
    ) {
      throw new ChatError(
        'INVALID_REQUEST',
        `policy.mode must be one of ${CHAT_MODES.join(', ')}.`,
      );
    }
    policy.mode = input.mode as ChatPolicy['mode'];
  }
  for (const [name, min, max] of CHAT_POLICY_INT_FIELDS) {
    if (input[name] !== undefined) {
      policy[name] = intInRange(input[name], name, min, max);
    }
  }
  return policy;
}

function renderMessage(message: ChatMessage): ChatMessage {
  return message;
}

/** Markdown transcript line. System lines render as italics, chat as list items. */
function messageLine(message: ChatMessage): string {
  const clock = message.at.slice(11, 16);
  if (message.kind === 'system') {
    return `- \`${clock}\` *${message.text}*`;
  }
  const to = message.to ? ` → ${message.to}` : '';
  return `- \`${clock}\` **${message.fromName}**${to}: ${message.text}`;
}

/**
 * REST for the human side: create and observe rooms, speak as the host,
 * pause/resume/close, export transcripts. Agents come in through /chat/mcp.
 *
 * REST speech is always the reserved `human` member — no caller identity is
 * involved, which is exactly the trust model of the game REST (the browser
 * is the human side).
 */
export function createChatRouter(manager: ChatManager): Router {
  const router = Router();

  router.post('/rooms', (req, res) => {
    const body = bodyOf(req);
    const title = optionalString(body, 'title');
    let roomId = optionalString(body, 'roomId');
    if (roomId === undefined) {
      // Human-friendly default ids: chat-<6 hex>.
      roomId = `chat-${Math.random().toString(16).slice(2, 8)}`;
    }
    const policy = chatPolicyOf(body.policy);
    const room = manager.create(roomId, {
      ...(title === undefined ? {} : { title }),
      ...(Object.keys(policy).length === 0 ? {} : { policy }),
    });
    res.status(201).json({ room: room.snapshot() });
  });

  router.get('/rooms', (_req, res) => {
    res.json(manager.list());
  });

  router.get('/rooms/:roomId', (req, res) => {
    const room = manager.getOrThrow(req.params.roomId);
    res.json({
      room: room.snapshot(),
      messages: room.recentMessages(50).map(renderMessage),
    });
  });

  router.post('/rooms/:roomId/messages', (req, res) => {
    const room = manager.getOrThrow(req.params.roomId);
    const body = bodyOf(req);
    const text = textOf(body);
    const to = optionalString(body, 'to');
    const replyTo = optionalString(body, 'replyTo');
    const member = room.humanMember();
    room.touch(HUMAN_MEMBER_ID, Date.now());
    const message = room.sendMessage(
      member,
      text,
      { ...(to === undefined ? {} : { to }), ...(replyTo === undefined ? {} : { replyTo }) },
      Date.now(),
    );
    res.status(201).json({ message: renderMessage(message), room: room.snapshot() });
  });

  const phaseAction = (action: 'pause' | 'resume' | 'close'): RequestHandler => {
    return (req, res) => {
      // The explicit RequestHandler annotation drops Express's inferred
      // params shape, so the id is checked rather than assumed.
      const roomId = req.params.roomId;
      if (typeof roomId !== 'string') {
        throw new ChatError('INVALID_REQUEST', 'roomId is required.');
      }
      const room = manager.getOrThrow(roomId);
      const now = Date.now();
      if (action === 'pause') {
        room.pause(now);
      } else if (action === 'resume') {
        room.resume(now);
      } else {
        room.close(now);
      }
      res.json({ room: room.snapshot() });
    };
  };

  router.post('/rooms/:roomId/pause', phaseAction('pause'));
  router.post('/rooms/:roomId/resume', phaseAction('resume'));
  router.post('/rooms/:roomId/close', phaseAction('close'));

  router.get('/rooms/:roomId/transcript', (req, res) => {
    const room = manager.getOrThrow(req.params.roomId);
    const format = req.query.format === 'md' ? 'md' : 'json';
    const limit = numberQuery(req.query.limit) ?? CHAT_RECENT_LIMIT;
    const afterSeq = numberQuery(req.query.afterSeq);

    const { messages, omitted } = room.transcript({
      limit,
      ...(afterSeq === undefined ? {} : { afterSeq }),
    });

    if (format === 'md') {
      const lines = messages.map(messageLine);
      const head =
        omitted > 0 ? [`*（前 ${omitted} 条省略）*`, ...lines] : lines;
      res.json({
        format,
        omitted,
        text: head.join('\n'),
        room: room.snapshot(),
      });
      return;
    }

    res.json({
      format,
      omitted,
      messages: messages.map(renderMessage),
      room: room.snapshot(),
    });
  });

  return router;
}

function numberQuery(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ChatError('INVALID_REQUEST', 'limit/afterSeq must be a number.');
  }
  return Math.floor(parsed);
}

/** Chat errors answer as JSON on the chat routes; everything else falls through. */
export function chatErrorHandler(): (
  error: unknown,
  req: Request,
  res: Response,
  next: (error?: unknown) => void,
) => void {
  return (error, req, res, next) => {
    if (error instanceof ChatError) {
      const payload: ChatErrorPayload = {
        error: { code: error.code, message: error.message },
      };
      res.status(statusForChatCode(error.code)).json(payload);
      return;
    }
    next(error);
  };
}
