import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerMessage } from '@arena/shared';
import type { PresenceRegistry } from '../core/presence.js';
import type { RoomManager } from '../rooms/room-manager.js';

export interface WebSocketOptions {
  path?: string;
  pingIntervalMs?: number;
  /** Presence registry; when omitted the socket only relays game state. */
  presence?: PresenceRegistry;
}

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
 * Read-only broadcast channel: `hello` on connect, then `state`, `commentary`,
 * and `participants` events. Clients never mutate state over WS (actions go via
 * REST).
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
