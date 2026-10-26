import { create } from 'zustand';
import type { ChatMessageFrame, ChatRoomFrame } from '@arena/shared';
import { api, errorMessage } from '../api';

/** This browser's own socket, same meaning as the game store's status. */
export type ChatConnection =
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'offline';

/**
 * One chat room, one store — the mirror of store/room.ts for the chat half
 * of /ws. The socket is authoritative (hello / message / room frames);
 * REST replies from the composer and the host controls apply immediately
 * and dedupe against whatever the socket echoes back, keyed by `seq`.
 */
export interface ChatStore {
  roomId: string;
  connection: ChatConnection;
  /** Latest room snapshot; `seq` decides who wins when frames race. */
  room: ChatRoomFrame | null;
  messages: ChatMessageFrame[];
  /** A REST mutation is in flight. */
  busy: boolean;
  /** Last user-facing error, already formatted. */
  error: string | null;

  /** Wire the socket for a room; returns the teardown. */
  connect(roomId: string): () => void;
  /** Full replace, used by `hello` on connect and reconnect. */
  applyHello(room: ChatRoomFrame, messages: ChatMessageFrame[]): void;
  applyMessage(message: ChatMessageFrame): void;
  applyRoom(room: ChatRoomFrame): void;
  /** Post as the host; resolves false when the server refused. */
  send(text: string, to?: string): Promise<boolean>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  closeRoom(): Promise<void>;
  clearError(): void;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  roomId: '',
  connection: 'connecting',
  room: null,
  messages: [],
  busy: false,
  error: null,

  connect(roomId) {
    set({
      roomId,
      connection: 'connecting',
      room: null,
      messages: [],
      error: null,
    });
    return subscribeToChatRoom(roomId, set, get);
  },

  applyHello(room, messages) {
    set({ room, messages });
  },

  applyMessage(message) {
    set((current) => {
      // The REST reply and the socket echo describe the same message; keep one.
      if (current.messages.some((item) => item.seq === message.seq)) {
        return {};
      }
      return {
        messages: [...current.messages, message].sort(
          (a, b) => a.seq - b.seq,
        ),
      };
    });
  },

  applyRoom(room) {
    // Snapshots race between REST replies and socket frames; `seq` is
    // monotonic per room, so the older one loses.
    set((current) =>
      current.room && room.seq < current.room.seq ? {} : { room },
    );
  },

  async send(text, to) {
    const { roomId } = get();
    set({ busy: true, error: null });
    try {
      const { message, room } = await api.chatSend(roomId, text, to);
      get().applyMessage(message);
      get().applyRoom(room);
      return true;
    } catch (caught) {
      set({ error: errorMessage(caught) });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  async pause() {
    await control('pause', set, get);
  },

  async resume() {
    await control('resume', set, get);
  },

  async closeRoom() {
    await control('close', set, get);
  },

  clearError() {
    set({ error: null });
  },
}));

type Setter = (
  partial:
    | Partial<ChatStore>
    | ((state: ChatStore) => Partial<ChatStore>),
) => void;

async function control(
  action: 'pause' | 'resume' | 'close',
  set: Setter,
  get: () => ChatStore,
): Promise<void> {
  const { roomId } = get();
  set({ busy: true, error: null });
  try {
    get().applyRoom(await api.chatControl(roomId, action));
  } catch (caught) {
    set({ error: errorMessage(caught) });
  } finally {
    set({ busy: false });
  }
}

/**
 * Socket lifecycle, kept outside the store so React never owns the
 * connection — the same shape as the game store's subscribeToRoom.
 */
function subscribeToChatRoom(
  roomId: string,
  set: Setter,
  get: () => ChatStore,
): () => void {
  const RECONNECT_BASE_MS = 1_000;
  const RECONNECT_MAX_MS = 10_000;

  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let disposed = false;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws?roomId=${encodeURIComponent(roomId)}&kind=chat`;

  const scheduleReconnect = (): void => {
    if (disposed) {
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt += 1;
    if (retryTimer) {
      clearTimeout(retryTimer);
    }
    retryTimer = setTimeout(open, delay);
  };

  const open = (): void => {
    if (disposed) {
      return;
    }
    set({ connection: attempt === 0 ? 'connecting' : 'reconnecting' });

    let current: WebSocket;
    try {
      current = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = current;

    current.onopen = () => {
      attempt = 0;
      set({ connection: 'online' });
    };

    current.onmessage = (event: MessageEvent<string>) => {
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof frame !== 'object' || frame === null) {
        return;
      }
      // Chat frames carry kind:'chat'; the shared pong and any stray frame
      // from another room kind are not for this page.
      if ((frame as { kind?: unknown }).kind !== 'chat') {
        return;
      }

      const store = get();
      switch ((frame as { type: string }).type) {
        case 'hello': {
          const hello = frame as {
            room: ChatRoomFrame;
            messages: ChatMessageFrame[];
          };
          store.applyHello(hello.room, hello.messages);
          break;
        }
        case 'message':
          store.applyMessage((frame as { message: ChatMessageFrame }).message);
          break;
        case 'room':
          store.applyRoom((frame as { room: ChatRoomFrame }).room);
          break;
        default:
          break;
      }
    };

    current.onclose = () => {
      if (disposed) {
        return;
      }
      set({ connection: 'reconnecting' });
      scheduleReconnect();
    };

    current.onerror = () => {
      current.close();
    };
  };

  open();

  return () => {
    disposed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
    }
    socket?.close();
  };
}
