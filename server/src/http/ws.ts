import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  ChatMemberFrame,
  ChatRoomFrame,
  ServerMessage,
} from '@arena/shared';
import type { ChatManager } from '../chat/manager.js';
import type { ChatRoomSnapshot } from '../chat/model.js';
import type { PresenceRegistry } from '../core/presence.js';
import type { RoomManager } from '../rooms/room-manager.js';

export interface WebSocketOptions {
  path?: string;
  pingIntervalMs?: number;
  /** Presence registry; when omitted the socket only relays game state. */
  presence?: PresenceRegistry;
  /** Chat rooms; when passed, sockets asking `?kind=chat` subscribe to them. */
  chat?: ChatManager;
}

/** How much timeline a chat `hello` carries; matches the REST room detail. */
const CHAT_HELLO_MESSAGES = 50;

function sendJson(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    console.error('[ws] failed to send message', error);
  }
}

/**
 * Chat domain snapshot → wire frame. The frame flattens the two policy
 * numbers the UI renders and drops the rest, so the domain's ChatPolicy
 * never crosses into the shared transport contract.
 */
function chatRoomFrame(snapshot: ChatRoomSnapshot): ChatRoomFrame {
  const members: ChatMemberFrame[] = snapshot.members.map((member) => ({
    id: member.id,
    name: member.name,
    kind: member.kind,
    joinedAt: member.joinedAt,
    messages: member.messages,
    lastSeenAt: member.lastSeenAt,
  }));
  return {
    id: snapshot.id,
    title: snapshot.title,
    phase: snapshot.phase,
    seq: snapshot.seq,
    hop: snapshot.hop,
    maxHops: snapshot.policy.maxHops,
    maxMessagesPerMember: snapshot.policy.maxMessagesPerMember,
    turn: snapshot.turn
      ? { participantId: snapshot.turn.participantId, name: snapshot.turn.name }
      : null,
    members,
    messageCount: snapshot.messageCount,
  };
}

/**
 * Read-only broadcast channel: `hello` on connect, then `state`, `commentary`,
 * and `participants` events. Clients never mutate state over WS (actions go via
 * REST). Sockets that ask for `?kind=chat` get the chat flavour instead — the
 * same rule, one endpoint, so the arena keeps a single push mechanism.
 *
 * Each socket counts as one browser viewer for its room, which is what keeps a
 * human seat at `idle`/`thinking` instead of decaying to `disconnected` while
 * somebody is looking at the board.
 */
export function attachWebSocket(
  server: Server,
  manager: RoomManager,
  options: WebSocketOptions = {},
): WebSocketServer {
  const path = options.path ?? '/ws';
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const presence = options.presence;
  const chat = options.chat;
  const wss = new WebSocketServer({ server, path });
  const alive = new WeakSet<WebSocket>();
  /** Last presence frame sent per socket, so only real changes hit the wire. */
  const lastFrame = new WeakMap<WebSocket, string>();
  /** Room each socket is watching, for presence fan-out. */
  const socketRoom = new WeakMap<WebSocket, string>();

  const pushParticipants = (socket: WebSocket, roomId: string): void => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const room = manager.get(roomId);
    if (!room) {
      return;
    }
    const participants = room.getParticipants();
    const serialized = JSON.stringify(participants);
    if (lastFrame.get(socket) === serialized) {
      return;
    }
    lastFrame.set(socket, serialized);
    sendJson(socket, { type: 'participants', roomId, participants });
  };

  /**
   * The chat half of the channel: `hello` with a snapshot plus the recent
   * timeline, then a `message` frame per new message and a `room` frame per
   * mutation. Same rule as the games — clients never mutate over WS; the
   * human posts through the chat REST routes.
   */
  const chatConnection = (
    socket: WebSocket,
    registry: ChatManager,
    roomId: string,
  ): void => {
    const room = registry.get(roomId);
    if (!room) {
      sendJson(socket, {
        type: 'error',
        code: 'ROOM_NOT_FOUND',
        message: `Chat room "${roomId}" not found.`,
      });
      socket.close(1008, 'ROOM_NOT_FOUND');
      return;
    }

    // Remember the cursor inside the listener: a reconnect asks for `hello`
    // again, but a live socket must only ever see messages it has not seen.
    let lastSeq = room.seq;
    sendJson(socket, {
      type: 'hello',
      roomId,
      kind: 'chat',
      room: chatRoomFrame(room.snapshot()),
      messages: room.recentMessages(CHAT_HELLO_MESSAGES),
    });

    const unsubscribe = room.subscribe(() => {
      // Messages first, snapshot after: the timeline appends, then the room
      // frame refreshes turn / hop / phase around what was appended.
      const { messages } = room.unreadAfter(lastSeq, Number.POSITIVE_INFINITY);
      for (const message of messages) {
        sendJson(socket, {
          type: 'message',
          roomId,
          kind: 'chat',
          message,
        });
      }
      lastSeq = room.seq;
      sendJson(socket, {
        type: 'room',
        roomId,
        kind: 'chat',
        room: chatRoomFrame(room.snapshot()),
      });
    });

    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      unsubscribe();
      alive.delete(socket);
    };
    socket.on('close', cleanup);
    socket.on('error', (error) => {
      console.error(`[ws] chat socket error in room "${roomId}"`, error);
      cleanup();
    });
  };

  wss.on('connection', (socket, request) => {
    alive.add(socket);

    let url: URL;
    try {
      url = new URL(request.url ?? path, 'http://127.0.0.1');
    } catch {
      sendJson(socket, { type: 'error', code: 'INVALID_REQUEST', message: 'Malformed WebSocket URL.' });
      socket.close(1008, 'INVALID_REQUEST');
      return;
    }

    // Liveness and client pings work the same for both room kinds.
    socket.on('pong', () => {
      alive.add(socket);
    });

    socket.on('message', (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        sendJson(socket, {
          type: 'error',
          code: 'INVALID_REQUEST',
          message: 'Messages must be valid JSON.',
        });
        return;
      }

      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'ping'
      ) {
        sendJson(socket, { type: 'pong' });
      }
    });

    // `kind=chat` rides the same endpoint but a different domain; anything
    // else — including no kind at all — stays on the games, so existing
    // clients keep their behaviour byte for byte.
    if (url.searchParams.get('kind') === 'chat') {
      if (!chat) {
        sendJson(socket, {
          type: 'error',
          code: 'INVALID_REQUEST',
          message: 'Chat rooms are not served on this endpoint.',
        });
        socket.close(1008, 'INVALID_REQUEST');
        return;
      }
      chatConnection(socket, chat, url.searchParams.get('roomId') ?? '');
      return;
    }

    const roomId = url.searchParams.get('roomId') ?? manager.defaultRoomId;
    const room = manager.get(roomId);

    if (!room) {
      sendJson(socket, {
        type: 'error',
        code: 'ROOM_NOT_FOUND',
        message: `Room "${roomId}" not found.`,
      });
      socket.close(1008, 'ROOM_NOT_FOUND');
      return;
    }

    socketRoom.set(socket, roomId);

    // Register the viewer before building the snapshot: `hello` must already
    // report this tab, otherwise the first paint says "unknown" for a human
    // who is plainly looking at the board.
    //
    // The tab watches the room, not a seat: starting a new game can move the
    // human from black to white, and the same tab keeps watching throughout.
    const detachViewer = presence?.attachViewer(roomId);

    const view = room.getView();
    lastFrame.set(socket, JSON.stringify(view.participants));
    sendJson(socket, {
      type: 'hello',
      roomId,
      state: view.state,
      commentary: view.commentary,
      phase: view.phase,
      participants: view.participants,
    });

    const unsubscribePhase = room.onPhase((phaseRoomId, phase) => {
      sendJson(socket, { type: 'phase', roomId: phaseRoomId, phase });
    });

    const unsubscribeState = room.onState((state) => {
      sendJson(socket, { type: 'state', roomId, state });
      // Whose turn it is changes presence (`thinking`), so refresh with state.
      pushParticipants(socket, roomId);
    });
    const unsubscribeCommentary = room.onCommentary((commentary) => {
      sendJson(socket, { type: 'commentary', roomId, commentary });
    });

    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      unsubscribeState();
      unsubscribePhase();
      unsubscribeCommentary();
      detachViewer?.();
      socketRoom.delete(socket);
      alive.delete(socket);
    };

    socket.on('close', cleanup);
    socket.on('error', (error) => {
      console.error(`[ws] socket error in room "${roomId}"`, error);
      cleanup();
    });
  });

  // Presence changes originate outside any socket: an MCP session attaching, a
  // long-poll parking, or the stale sweep. Fan those out to the right room.
  const unsubscribePresence = presence?.onChange((roomId) => {
    for (const socket of wss.clients) {
      if (socketRoom.get(socket) === roomId) {
        pushParticipants(socket, roomId);
      }
    }
  });

  const pingTimer = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, pingIntervalMs);
  pingTimer.unref();

  wss.on('close', () => {
    clearInterval(pingTimer);
    unsubscribePresence?.();
  });

  return wss;
}
