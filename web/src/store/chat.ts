import { create } from 'zustand';
import type { ChatMessageFrame, ChatRoomFrame } from '@arena/shared';
import { api, errorMessage } from '../api';
import { errorText } from '../errors';

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
  /** Last error code; lets the page tell "room gone" apart from a network blip. */
  errorCode: string | null;

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
  /** Host tuning of the caps; raising the hop budget can lift a budget pause. */
  setPolicy(policy: {
    maxHops?: number;
    maxMessagesPerMember?: number;
    turnTimeoutMs?: number;
  }): Promise<void>;
  clearError(): void;
}

/**
 * Bumped every time `connect()` runs. A request captures the value it started
 * under and drops its reply if the counter moved — which covers both switching
 * rooms and leaving and re-entering the same room, where the room id alone
 * would still match.
 */
let chatVisitSeq = 0;

export const useChatStore = create<ChatStore>((set, get) => ({
  roomId: '',
  connection: 'connecting',
  room: null,
  messages: [],
  busy: false,
  error: null,
  errorCode: null,

  connect(roomId) {
    // Every entry into a room is a new visit: a reply issued during the last
    // one must not land here even if it is the same room id.
    chatVisitSeq += 1;
    set({
      roomId,
      connection: 'connecting',
      room: null,
      messages: [],
      error: null,
      errorCode: null,
      // A request abandoned by leaving must not leave the new room disabled.
      busy: false,
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
    const visit = chatVisitSeq;
    const current = () => chatVisitSeq === visit && get().roomId === roomId;

    set({ busy: true, error: null });
    try {
      const { message, room } = await api.chatSend(roomId, text, to);
      // A reply that lands after the user left belongs to the visit they left;
      // appending it would put a stranger's line in this timeline.
      if (!current()) {
        return false;
      }
      get().applyMessage(message);
      get().applyRoom(room);
      return true;
    } catch (caught) {
      if (current()) {
        set({ error: errorMessage(caught) });
      }
      return false;
    } finally {
      if (current()) {
        set({ busy: false });
      }
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

  async setPolicy(policy) {
    const { roomId } = get();
    const visit = chatVisitSeq;
    const current = () => chatVisitSeq === visit && get().roomId === roomId;

    set({ busy: true, error: null });
    try {
      const room = await api.chatSetPolicy(roomId, policy);
      // Same rule as `control`: a reply for a visit the user already left is
      // dropped rather than painted onto the new room.
      if (!current()) {
        return;
      }
      get().applyRoom(room);
    } catch (caught) {
      if (current()) {
        set({ error: errorMessage(caught) });
      }
    } finally {
      if (current()) {
        set({ busy: false });
      }
    }
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
  const visit = chatVisitSeq;
  const current = () => chatVisitSeq === visit && get().roomId === roomId;

  set({ busy: true, error: null });
  try {
    const room = await api.chatControl(roomId, action);
    // Same rule as `send`: a reply for a visit the user already left is dropped.
    if (current()) {
      get().applyRoom(room);
    }
  } catch (caught) {
    if (current()) {
      set({ error: errorMessage(caught) });
    }
  } finally {
    if (current()) {
      set({ busy: false });
    }
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
      if (disposed || socket !== current) return;
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
        case 'error': {
          const err = frame as { message?: string; code?: string };
          console.warn('[ws]', err.code, err.message);
          set({
            connection: 'offline',
            error: errorText(err.code, err.message),
            errorCode: err.code ?? null,
          });
          break;
        }
        default:
          break;
      }
    };

    current.onclose = (event: CloseEvent) => {
      if (disposed) {
        return;
      }
      if (event.code === 1008) {
        const code = event.reason || 'ROOM_NOT_FOUND';
        set({
          connection: 'offline',
          error: errorText(code),
          errorCode: code,
        });
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
