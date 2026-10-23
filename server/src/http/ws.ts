import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerMessage } from '@gomoku/shared';
import type { RoomManager } from '../rooms/room-manager.js';

export interface WebSocketOptions {
  path?: string;
  pingIntervalMs?: number;
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
 * Read-only broadcast channel: `hello` on connect, then `state` and
 * `commentary` events. Clients never mutate state over WS (actions go via REST).
 */
export function attachWebSocket(
  server: Server,
  manager: RoomManager,
  options: WebSocketOptions = {},
): WebSocketServer {
  const path = options.path ?? '/ws';
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const wss = new WebSocketServer({ server, path });
  const alive = new WeakSet<WebSocket>();

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

    const view = room.getView();
    sendJson(socket, {
      type: 'hello',
      roomId,
      state: view.state,
      commentary: view.commentary,
    });

    const unsubscribeState = room.onState((state) => {
      sendJson(socket, { type: 'state', roomId, state });
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
      unsubscribeCommentary();
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
  });

  return wss;
}
