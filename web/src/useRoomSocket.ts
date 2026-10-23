import { useEffect, useRef, useState } from 'react';
import {
  MAX_COMMENTARY_LOG,
  type Commentary,
  type GameState,
  type ServerMessage,
} from '@gomoku/shared';
import { api } from './api';

export type ConnectionStatus =
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'offline';

export interface RoomSocket {
  state: GameState | null;
  commentary: Commentary[];
  status: ConnectionStatus;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

function socketUrl(roomId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws?roomId=${encodeURIComponent(roomId)}`;
}

function isServerMessage(value: unknown): value is ServerMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/**
 * Single source of game state: the WebSocket. REST responses are reconciled by
 * the caller through `version`; this hook also restores the room view from
 * `hello` after a reconnect.
 */
export function useRoomSocket(roomId: string): RoomSocket {
  const [state, setState] = useState<GameState | null>(null);
  const [commentary, setCommentary] = useState<Commentary[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const gameIdRef = useRef<string | null>(null);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    const applyState = (incoming: GameState): void => {
      if (incoming.gameId !== gameIdRef.current) {
        gameIdRef.current = incoming.gameId;
        setCommentary([]);
      }
      setState((previous) => {
        if (previous && incoming.version < previous.version) {
          return previous;
        }
        return incoming;
      });
    };

    const connect = (): void => {
      if (disposed) {
        return;
      }

      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');

      let current: WebSocket;
      try {
        current = new WebSocket(socketUrl(roomId));
      } catch {
        scheduleReconnect();
        return;
      }
      socket = current;

      current.onopen = () => {
        attempt = 0;
        setStatus('online');
      };

      current.onmessage = (event: MessageEvent<string>) => {
        let message: unknown;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!isServerMessage(message)) {
          return;
        }

        switch (message.type) {
          case 'hello':
            // Reconnect truth: overwrite the local view, including the log.
            gameIdRef.current = message.state.gameId;
            setState(message.state);
            setCommentary(message.commentary.slice(-MAX_COMMENTARY_LOG));
            break;
          case 'state':
            applyState(message.state);
            break;
          case 'commentary':
            setCommentary((previous) => {
              const next = [...previous, message.commentary];
              return next.slice(-MAX_COMMENTARY_LOG);
            });
            break;
          case 'error':
            console.warn('[ws]', message.code, message.message);
            break;
          default:
            break;
        }
      };

      current.onclose = () => {
        if (disposed) {
          return;
        }
        setStatus('reconnecting');
        scheduleReconnect();
      };

      current.onerror = () => {
        current.close();
      };
    };

    const scheduleReconnect = (): void => {
      if (disposed) {
        return;
      }
      const delay = Math.min(
        RECONNECT_BASE_MS * 2 ** attempt,
        RECONNECT_MAX_MS,
      );
      attempt += 1;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      retryTimer = setTimeout(connect, delay);
    };

    connect();

    // Fallback for the first paint: if the socket is slow or blocked, the REST
    // snapshot still fills the board. The socket overwrites it when it connects.
    api
      .getRoom(roomId)
      .then((view) => {
        if (disposed) {
          return;
        }
        setState((previous) =>
          previous && previous.version > view.state.version
            ? previous
            : view.state,
        );
        setCommentary((previous) =>
          previous.length > 0
            ? previous
            : view.commentary.slice(-MAX_COMMENTARY_LOG),
        );
      })
      .catch(() => {
        // The socket keeps retrying; a failed initial fetch is not fatal.
      });

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      socket?.close();
    };
  }, [roomId]);

  return { state, commentary, status };
}
