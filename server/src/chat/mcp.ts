import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CHAT_JOIN_RECENT,
  CHAT_RECENT_LIMIT,
  ChatError,
  DEFAULT_CHAT_POLICY,
  chatHint,
  clampChatWaitMs,
  type ChatMember,
  type ChatMessage,
} from './model.js';
import { sessionContext, type SessionBindings } from '../session-context.js';
import type { ChatManager } from './manager.js';

/**
 * The chat domain's own MCP endpoint, mounted at /chat/mcp — completely
 * separate from the games' /mcp so neither instruction set has to explain
 * the other, and an agent that only plays never sees chat tools.
 *
 * Identity reuses SessionBindings under a `chat:`-prefixed room key, so a
 * session can hold a game seat and a chat membership in the same-named room
 * without the two bindings colliding. The module is generic (sessionId →
 * participantId per key) and untouched.
 */

/** Seconds in the default lease, for the instructions this text builds. */
const LEASE_SECONDS = DEFAULT_CHAT_POLICY.turnTimeoutMs / 1000;

export const CHAT_INSTRUCTIONS = `你是聊天室里的 Agent 成员（/chat/mcp，与棋类对弈完全无关）。

房间规则（relay 接力模式）：
- 成员轮流发言：轮到你时 wait_for_messages 会告诉你「轮到你了」，用 send_message 发言。
- 发言后轮转给下一位（可以用 to 参数指定下一位，值用成员的 name）。
- 不要抢话：不是你的轮次时发言会被拒绝（NOT_YOUR_TURN）。
- 轮到你但这一轮没有新内容、或者你已收工时，必须调用 pass_turn 交还轮次，再结束本次工作。
  不要直接停止调用工具——轮次会压在别人身上直到超时，同一成员连续两次超时房间会被暂停。
- 如果你这轮不想说（或者已经说完了），用 pass_turn 把轮次让给下一位，
  不消耗预算——别让房间干等 ${LEASE_SECONDS} 秒超时，连续超时还会暂停房间。
- 如果你觉得该由主持人来说，用 pass_turn 并指定 to: "human" 把轮次交还给他。
  不要和另一个 agent 互相让来让去：连续 6 次让出且没人发言，房间会自动暂停。
- 每人发言数有限制，hop 总预算耗尽后房间会暂停。
- 人类是主持人：随时插话、指定下一位、暂停/恢复房间，不占预算。

标准循环：
1. join_room 占座（name 用你的名字）；房间不存在时会自动创建，返回的 created 为 true。
   之后所有调用自动以这个身份进行；
2. 用 get_transcript 或 join_room 返回的最近消息了解上下文；
3. 循环调用 wait_for_messages（默认挂起 20 秒），按返回的 hint 行动：
   - hint「轮到你了」→ 有话要说就 send_message 简短发言一次；这轮不想说或已收工，就 pass_turn 交还轮次；
   - hint「等 X 发言」→ 保持等待，不要做别的；
   - hint「房间已暂停/已关闭」→ 停止等待，不再调用；
4. 收工检查：轮到你但没有新内容或已收工时，必须用 pass_turn 交还轮次，再结束本次工作；
   收工/离开时优先 to: "human" 把轮次交还主持人，轮次不在你身上时直接结束即可。
5. 发言要短（一两句话），有信息量，不要重复自己之前的话。

wait_for_messages 是长轮询：没有新消息时调用会挂起，这是正常的——你是被消息唤醒的，不等待的 agent 是不可达的。`;

interface ChatMcpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  /** Open standing SSE streams (GET) — the client's lifeline. */
  streams: number;
  /** Tool calls being processed right now (a parked wait counts as one). */
  inflight: number;
}

/**
 * How long a session may stay dark (stream dropped, nothing in flight)
 * before its member is declared gone. Long enough to ride out an SSE
 * reconnect, short enough to free a parked turn within seconds instead of
 * burning full leases on a member that will never answer.
 */
const GONE_GRACE_MS = 5_000;

function jsonRpcError(code: number, message: string): unknown {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

function sessionIdOf(req: Request): string | undefined {
  const header = req.headers['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
}

function clientName(session: ChatMcpSession): string | undefined {
  return session.server.server.getClientVersion()?.name;
}

/** What join_room and wait return: snapshot plus the recent slice. */
interface TranscriptSlice {
  omitted: number;
  lines: Array<{ seq: number; from: string; kind: string; text: string; at: string }>;
}

function transcriptSlice(
  room: ReturnType<ChatManager['getOrThrow']>,
  limit: number,
  afterSeq?: number,
): TranscriptSlice {
  const { messages, omitted } = room.transcript({
    limit,
    ...(afterSeq === undefined ? {} : { afterSeq }),
  });
  return {
    omitted,
    lines: messages.map((message: ChatMessage) => ({
      seq: message.seq,
      from: message.fromName,
      kind: message.kind,
      text: message.text,
      at: message.at,
    })),
  };
}

/**
 * `get_transcript`'s `limit`, validated in the handler so a bad value answers
 * as a JSON `{code, message}` tool error (the `new_game` contract) instead of
 * a bare -32602 protocol error with no domain code for the model to branch
 * on. The REST endpoint keeps its own 400 contract.
 */
function transcriptLimitOf(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 100
  ) {
    throw new ChatError(
      'INVALID_REQUEST',
      `limit must be an integer between 1 and 100, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/** Tool results are JSON text; errors are JSON too, so the model can branch on code. */
function chatErrorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ChatError) {
    return {
      isError: true,
      content: [
        { type: 'text', text: JSON.stringify({ code: error.code, message }) },
      ],
    };
  }
  console.error('[chat-mcp] tool failed', error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code: 'INTERNAL_ERROR', message }) }],
  };
}

async function runChatTool(action: () => unknown): Promise<CallToolResult> {
  try {
    // The wait handler parks, so the action may return a promise.
    return textResult(await action());
  } catch (error) {
    return chatErrorResult(error);
  }
}

function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

export function mountChatMcp(
  app: Express,
  manager: ChatManager,
  bindings: SessionBindings,
  options: { goneGraceMs?: number } = {},
): void {
  const sessions = new Map<string, ChatMcpSession>();
  const goneTimers = new Map<string, NodeJS.Timeout>();
  const goneGraceMs = options.goneGraceMs ?? GONE_GRACE_MS;

  const cancelGoneCheck = (sessionId: string): void => {
    const timer = goneTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      goneTimers.delete(sessionId);
    }
  };

  /**
   * The session looks dead (stream dropped, nothing in flight, grace
   * expired): mark every member it drives as gone so a held turn is handed
   * back at once instead of burning leases on an unreachable member. The
   * session itself stays resumable — a client that comes back after a long
   * blip revives its member on the next call (touch/join) instead of being
   * locked out.
   */
  const markSessionGone = (sessionId: string): void => {
    const claimed = bindings.roomsOf(sessionId);
    if (claimed === undefined) {
      return;
    }
    const now = Date.now();
    for (const [roomKey, participantId] of claimed) {
      if (!roomKey.startsWith('chat:')) {
        continue;
      }
      const roomId = roomKey.slice('chat:'.length);
      // Another live session may still drive the same member (reconnect).
      let stillDriven = false;
      for (const otherId of sessions.keys()) {
        if (otherId !== sessionId && bindings.participantOf(otherId, roomKey) === participantId) {
          stillDriven = true;
          break;
        }
      }
      if (!stillDriven) {
        manager.get(roomId)?.memberGone(participantId, now);
      }
    }
  };

  /**
   * Explicit session end (DELETE / transport close): full teardown —
   * bindings dropped, members marked gone, the session id retired.
   */
  const releaseSession = (sessionId: string): void => {
    cancelGoneCheck(sessionId);
    const session = sessions.get(sessionId);
    if (session === undefined) {
      return;
    }
    sessions.delete(sessionId);
    markSessionGone(sessionId);
    bindings.clear(sessionId);
  };

  /**
   * A connection dropped without the session ending (SSE blip, aborted
   * request). Give the client `goneGraceMs` to come back — any new request
   * cancels — then mark its members gone if the session is still dark.
   */
  const scheduleGoneCheck = (sessionId: string): void => {
    if (goneTimers.has(sessionId)) {
      return;
    }
    const timer = setTimeout(() => {
      goneTimers.delete(sessionId);
      const session = sessions.get(sessionId);
      if (session === undefined) {
        return;
      }
      if (session.streams > 0 || session.inflight > 0) {
        // A standing stream or a parked wait means the client is still there.
        return;
      }
      markSessionGone(sessionId);
    }, goneGraceMs);
    timer.unref();
    goneTimers.set(sessionId, timer);
  };

  const createMcpServer = (): McpServer => {
    const server = new McpServer(
      { name: 'arena-chat', version: '0.1.0' },
      { instructions: CHAT_INSTRUCTIONS },
    );
    registerChatTools(server, manager, bindings);
    return server;
  };

  const sendBadRequest = (res: Response, message: string): void => {
    res.status(400).json(jsonRpcError(-32000, message));
  };

  app.post('/chat/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = sessionIdOf(req);
      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          res.status(404).json(jsonRpcError(-32001, 'Session not found'));
          return;
        }
        // Any request proves the client is alive — and a long-polling wait
        // keeps `inflight` up while it parks, so no gone check fires under a
        // healthy parked waiter.
        cancelGoneCheck(sessionId);
        existing.inflight += 1;
        res.on('close', () => {
          existing.inflight -= 1;
          if (!res.writableEnded) {
            // The connection died mid-call (process exit, network cut).
            scheduleGoneCheck(sessionId);
          }
        });
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

      let session: ChatMcpSession | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          if (session) {
            sessions.set(newSessionId, session);
          }
        },
      });

      const server = createMcpServer();
      session = { server, transport, streams: 0, inflight: 0 };
      transport.onclose = () => {
        const closedId = transport.sessionId;
        if (closedId) {
          releaseSession(closedId);
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[chat-mcp] POST /chat/mcp failed', error);
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
      }
    }
  });

  app.get('/chat/mcp', async (req: Request, res: Response) => {
    const sessionId = sessionIdOf(req);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session || sessionId === undefined) {
      sendBadRequest(res, 'Bad Request: Invalid or missing session ID');
      return;
    }
    // The standing SSE stream is the client's lifeline: when it drops and
    // nothing takes its place within the grace, the session is over.
    cancelGoneCheck(sessionId);
    session.streams += 1;
    res.on('close', () => {
      session.streams -= 1;
      scheduleGoneCheck(sessionId);
    });
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      console.error('[chat-mcp] GET /chat/mcp failed', error);
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
      }
    }
  });

  app.delete('/chat/mcp', async (req: Request, res: Response) => {
    const sessionId = sessionIdOf(req);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session || sessionId === undefined) {
      sendBadRequest(res, 'Bad Request: Invalid or missing session ID');
      return;
    }
    try {
      await session.transport.handleRequest(req, res);
      // Graceful termination: hand held turns back now instead of waiting
      // out the grace window. (transport.onclose releases too — idempotent.)
      releaseSession(sessionId);
    } catch (error) {
      console.error('[chat-mcp] DELETE /chat/mcp failed', error);
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
      }
    }
  });
}

function registerChatTools(
  server: McpServer,
  manager: ChatManager,
  bindings: SessionBindings,
): void {
  // The binding key is namespaced per domain: `chat:<roomId>` never collides
  // with a game seat held in the same-named room.
  const bindingKey = (roomId: string): string => `chat:${roomId}`;

  const memberOf = (roomId: string): ChatMember => {
    const session = sessionContext.getStore();
    const participantId = session?.sessionId
      ? bindings.participantOf(session.sessionId, bindingKey(roomId))
      : undefined;
    const room = manager.getOrThrow(roomId);
    if (participantId === undefined) {
      throw new ChatError(
        'IDENTITY_REQUIRED',
        'You have not joined this chat room; call join_room first.',
      );
    }
    // The live record, not a snapshot copy: sendMessage mutates the member's
    // counter, and a copy would throw the increment away.
    const member = room.memberRef(participantId);
    if (!member) {
      throw new ChatError(
        'MEMBER_NOT_FOUND',
        'Your membership is gone (the room may have been rebuilt); join_room again.',
      );
    }
    return member;
  };

  server.registerTool(
    'join_room',
    {
      title: '加入聊天室',
      description: `加入一个聊天房间成为 agent 成员。房间不存在时**自动创建**（返回 created: true），
所以你可以用一个新房间 id 直接开工；同名再次加入视为重连，拿回原来的成员身份。
返回 participantId、房间快照和最近消息。`,
      inputSchema: z.object({
        roomId: z.string().min(1).describe('房间 id。'),
        name: z.string().min(1).max(64).optional().describe('你的显示名；缺省用客户端名。'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ roomId, name }) =>
      runChatTool(() => {
      // The game domain's join_game has always created the room on demand; chat
      // answering ROOM_NOT_FOUND made "an agent opens a room by naming it"
      // impossible here. `created` keeps the difference visible to the model.
      const existed = manager.get(roomId) !== undefined;
      const room = manager.getOrCreate(roomId);
      const session = sessionContext.getStore();
      // Reconnect: an existing binding is the same member coming back.
      const knownId = session?.sessionId
        ? bindings.participantOf(session.sessionId, bindingKey(roomId))
        : undefined;
      const knownMember = knownId
        ? room.snapshot().members.find((item) => item.id === knownId && item.kind === 'agent')
        : undefined;

      const member = room.join(
        name ?? knownMember?.name ?? session?.client ?? `agent-${Date.now() % 10000}`,
        session?.client,
        Date.now(),
      );
      if (session?.sessionId) {
        bindings.bind(session.sessionId, bindingKey(roomId), member.id);
      }

      const snapshot = room.snapshot();
      const slice = transcriptSlice(room, CHAT_JOIN_RECENT);
      return {

              participantId: member.id,
              name: member.name,
              created: !existed,
              room: snapshot,
              recent: slice.lines,
              omittedEarlier: slice.omitted,
              hint: chatHint(snapshot, snapshot.turn?.participantId === member.id),
            
      };
      }),
  );

  server.registerTool(
    'send_message',
    {
      title: '发送聊天消息',
      description: `在聊天室发言。relay 模式下只有轮到你才能发；人类主持人随时可以。
to 参数指定下一位发言者（用成员 name）。发言会消耗 hop 预算。发完若不再继续发言，记得用 pass_turn 交还轮次。`,
      inputSchema: z.object({
        roomId: z.string().min(1).describe('房间 id。'),
        text: z.string().min(1).describe('消息内容，一两句话即可。'),
        to: z.string().optional().describe('指定下一位发言者的成员名。'),
        replyTo: z.string().optional().describe('引用的消息 id。'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ roomId, text, to, replyTo }) =>
      runChatTool(() => {
      const room = manager.getOrThrow(roomId);
      const member = memberOf(roomId);
      room.touch(member.id, Date.now());
      const message = room.sendMessage(
        member,
        text,
        {
          ...(to === undefined ? {} : { to }),
          ...(replyTo === undefined ? {} : { replyTo }),
        },
        Date.now(),
      );
      const snapshot = room.snapshot();
      return {

              message: {
                seq: message.seq,
                id: message.id,
                hop: message.hop,
                at: message.at,
              },
              room: snapshot,
              hint: chatHint(snapshot, snapshot.turn?.participantId === member.id),
            
      };
      }),
  );

  server.registerTool(
    'pass_turn',
    {
      title: '让出轮次',
      description: `不发言，把轮次让给下一位（或用 to 指定的成员 name）。
不消耗 hop 预算，只记一条系统消息。**收工或这轮没有新内容时必须用它交还轮次**：
发完最后一条消息后若准备结束，先 pass_turn 再退出；否则房间会一直等到 ${LEASE_SECONDS} 秒超时，
同一成员连续两次超时房间会被暂停。
收工/离开时优先用 to: "human" 把轮次交还主持人；不要和另一个 agent 互相让，
连续 6 次让出且没人发言房间会自动暂停。
只有轮到你时才能让；房间里还没有轮次时会报错。`,
      inputSchema: z.object({
        roomId: z.string().min(1).describe('房间 id。'),
        to: z
          .string()
          .optional()
          .describe('接手的成员 name，或 "human" 交还主持人；缺省按加入顺序轮转下一位。'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ roomId, to }) =>
      runChatTool(() => {
        const room = manager.getOrThrow(roomId);
        const member = memberOf(roomId);
        room.touch(member.id, Date.now());
        const turn = room.passTurn(member, to, Date.now());
        const snapshot = room.snapshot();
        return {
          passed: true,
          turn: turn?.name ?? null,
          hop: `${snapshot.hop}/${snapshot.policy.maxHops}`,
          room: snapshot,
          hint: chatHint(snapshot, snapshot.turn?.participantId === member.id),
        };
      }),
  );

  server.registerTool(
    'wait_for_messages',
    {
      title: '等待新消息',
      description: `长轮询等待新消息或轮到自己。没有新消息时调用会挂起（默认 20 秒，上限 30 秒），这是正常的等待。
返回 messages（afterSeq 之后的新消息，最多 ${CHAT_RECENT_LIMIT} 条）、nextCursor、hasMore、omitted、timedOut、yourTurn、房间快照和一句可操作的 hint——按 hint 行动：
「轮到你了」→ 有话要说就 send_message；这轮不想说或已收工，就 pass_turn 交还轮次；「等 X 发言」→ 再次调用本工具；「已暂停/已关闭」→ 停止。
hasMore=true 表示还有未读消息被截断（omitted 是条数），用 afterSeq=nextCursor 连续调用直到拿完——hint 会给出同样指令。
afterSeq 缺省 = 当前最新序号（等你调用之后的新消息）。`,
      inputSchema: z.object({
        roomId: z.string().min(1).describe('房间 id。'),
        afterSeq: z.number().int().min(0).optional().describe('已见过的最大消息序号。'),
        timeoutMs: z.number().int().min(1000).max(30000).optional().describe('挂起时长，默认 20000。'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ roomId, afterSeq, timeoutMs }) =>
      runChatTool(async () => {
      const room = manager.getOrThrow(roomId);
      const member = memberOf(roomId);
      const cursor = afterSeq ?? room.snapshot().seq;
      const outcome = await room.wait(
        member.id,
        cursor,
        clampChatWaitMs(timeoutMs),
        Date.now(),
      );

      const snapshot = room.snapshot();
      const { messages: fresh, omitted } = room.unreadAfter(cursor, CHAT_RECENT_LIMIT);
      const hasMore = omitted > 0;
      const last = fresh[fresh.length - 1];
      const nextCursor = last ? last.seq : cursor;
      const yourTurn = snapshot.phase === 'open' && snapshot.turn?.participantId === member.id;
      return {
        timedOut: outcome.timedOut,
        messages: fresh.map((message: ChatMessage) => ({
          seq: message.seq,
          from: message.fromName,
          kind: message.kind,
          text: message.text,
          at: message.at,
        })),
        nextCursor,
        hasMore,
        omitted,
        yourTurn,
        room: snapshot,
        hint: hasMore
          ? `还有 ${omitted} 条未读消息；用 afterSeq=${nextCursor} 再次调用 wait_for_messages，直到 hasMore=false 再按 hint 行动`
          : chatHint(snapshot, yourTurn),
      };
      }),
  );

  server.registerTool(
    'get_transcript',
    {
      title: '获取聊天转录',
      description: `拿最近的聊天转录（默认最近 ${CHAT_RECENT_LIMIT} 条，更早的只给省略计数）。
用于了解上下文；想拿增量用 wait_for_messages。`,
      inputSchema: z.object({
        roomId: z.string().min(1).describe('房间 id。'),
        // Value validation is deliberately loose at the schema layer and
        // explicit in the handler, so a bad `limit` answers with a JSON code
        // (INVALID_REQUEST) instead of a bare -32602 (same contract as
        // new_game). 1-100 的整数。
        limit: z.unknown().optional().describe('最多返回多少条，1-100 的整数。'),
        afterSeq: z.number().int().min(0).optional().describe('只返回该序号之后的消息。'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ roomId, limit, afterSeq }) =>
      runChatTool(() => {
      const room = manager.getOrThrow(roomId);
      const session = sessionContext.getStore();
      const myId = session?.sessionId
        ? bindings.participantOf(session.sessionId, bindingKey(roomId))
        : undefined;
      if (myId) {
        room.touch(myId, Date.now());
      }

      const snapshot = room.snapshot();
      const slice = transcriptSlice(
        room,
        limit === undefined ? CHAT_RECENT_LIMIT : transcriptLimitOf(limit),
        afterSeq,
      );
      return {

              messages: slice.lines,
              omittedEarlier: slice.omitted,
              room: snapshot,
              hint: chatHint(snapshot, snapshot.turn?.participantId === myId),
            
      };
      }),
  );
}
