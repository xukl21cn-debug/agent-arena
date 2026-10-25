import { create } from 'zustand';
import {
  MAX_COMMENTARY_LOG,
  type Commentary,
  type GameState,
  type ParticipantView,
  type RoomPhase,
  type StoneColor,
} from '@arena/shared';
import { ApiError, api, errorMessage } from '../api';

/**
 * This browser's own socket connection, not any seat's presence.
 *
 * Kept separate from `PresenceState` on purpose: "am I connected to the room"
 * and "is the opponent there" are different questions with different owners.
 */
export type ConnectionStatus =
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'offline';

/**
 * One room, one store.
 *
 * The board, the status line, the seat badges and the commentary panel all read
 * the same room state, and presence is part of it — so "is the AI actually
 * there?" is answered once and every surface agrees. Before this, each
 * component derived its own answer from `state.turn`, which is how the header
 * could say 思考中 while the seat badge said 未连接.
 *
 * Data flows in from two places: the WebSocket (authoritative for state and
 * presence) and REST mutations (authoritative for their own reply, which may be
 * newer than the last frame). Both funnel through `applyState`, which keeps the
 * higher `version`.
 */
export interface RoomStore {
  roomId: string;
  /** Connection to this browser's own socket, not to any seat. */
  connection: ConnectionStatus;
  /** Latest game state, from whichever source is newer. */
  state: GameState | null;
  /** Room lifecycle; idle games and room gathering are different facts. */
  phase: RoomPhase;
  /** When the room entered waiting, for the "opponent never came" hint. */
  waitingSince: number | null;
  /** Presence per seat, as the server reports it. */
  participants: ParticipantView[];
  commentary: Commentary[];
  /** A REST mutation is in flight. */
  busy: boolean;
  /** Last user-facing error, already formatted. */
  error: string | null;
  /** The result overlay was dismissed for the current game. */
  resultDismissed: boolean;

  /** Wire the socket for a room; returns the teardown. */
  connect(roomId: string): () => void;
  /** Replace state from a server snapshot (WS frame or REST reply). */
  applyState(state: GameState): void;
  applyParticipants(participants: ParticipantView[]): void;
  applyCommentary(commentary: Commentary): void;
  applyPhase(phase: RoomPhase): void;
  /** Full replace, used by `hello` after a reconnect. */
  reset(input: {
    state: GameState;
    participants: ParticipantView[];
    commentary: Commentary[];
    phase: RoomPhase;
  }): void;

  startGame(humanColor: StoneColor): Promise<void>;
  setReady(ready: boolean): Promise<void>;
  play(row: number, col: number): Promise<void>;
  resign(): Promise<void>;
  dismissResult(): void;
  clearError(): void;
}

/** Human and agent seat colors, derived once so every surface agrees. */
export function seatColors(state: GameState | null): {
  human: StoneColor | null;
  agent: StoneColor | null;
  /** True when both seats are agents: this browser holds no seat, only watches. */
  spectator: boolean;
} {
  if (!state) {
    return { human: null, agent: null, spectator: false };
  }
  if (
    state.seats.black.kind === 'agent' &&
    state.seats.white.kind === 'agent'
  ) {
    // Neither color is "the agent's" and none is the local player's; picking
    // one would answer every downstream question wrongly.
    return { human: null, agent: null, spectator: true };
  }
  const human =
    state.seats.black.kind === 'human'
      ? 'black'
      : state.seats.white.kind === 'human'
        ? 'white'
        : null;
  const agent =
    state.seats.black.kind === 'agent'
      ? 'black'
      : state.seats.white.kind === 'agent'
        ? 'white'
        : null;
  return { human, agent, spectator: false };
}

/** Commentary for the current game, trimmed to the visible log length. */
export function visibleCommentary(
  commentary: Commentary[],
  gameId: string | null,
): Commentary[] {
  return commentary
    .filter((item) => item.gameId === gameId)
    .slice(-MAX_COMMENTARY_LOG);
}

function mergeState(
  previous: GameState | null,
  incoming: GameState,
): GameState {
  if (previous && incoming.version < previous.version) {
    return previous;
  }
  return incoming;
}

export const useRoomStore = create<RoomStore>((set, get) => ({
  roomId: '',
  connection: 'connecting',
  state: null,
  phase: 'lobby',
  waitingSince: null,
  participants: [],
  commentary: [],
  busy: false,
  error: null,
  resultDismissed: false,

  connect(roomId) {
    set({
      roomId,
      connection: 'connecting',
      state: null,
      phase: 'lobby',
      waitingSince: null,
      participants: [],
      commentary: [],
      error: null,
      resultDismissed: false,
    });
    return subscribeToRoom(roomId, set, get);
  },

  applyState(state) {
    const previousGame = get().state?.gameId;
    set((current) => ({
      state: mergeState(current.state, state),
      // A new game starts with an empty commentary log and a fresh overlay.
      ...(state.gameId === previousGame
        ? {}
        : { commentary: [], resultDismissed: false }),
    }));
  },

  applyParticipants(participants) {
    set({ participants });
  },

  applyCommentary(commentary) {
    set((current) => ({
      commentary: [...current.commentary, commentary].slice(-MAX_COMMENTARY_LOG),
    }));
  },

  applyPhase(phase) {
    set((current) => ({
      phase,
      // Client-side clock for the 60s hint: remember when waiting began,
      // forget it the moment the phase moves on.
      waitingSince:
        phase === 'waiting' ? (current.waitingSince ?? Date.now()) : null,
    }));
  },

  reset({ state, participants, commentary, phase }) {
    set({
      state,
      participants,
      commentary: commentary.slice(-MAX_COMMENTARY_LOG),
      phase,
      waitingSince: phase === 'waiting' ? Date.now() : null,
      resultDismissed: false,
    });
  },

  async setReady(ready) {
    const { roomId } = get();
    set({ busy: true, error: null });
    try {
      const view = await api.ready(roomId, ready);
      get().applyState(view.state);
      get().applyParticipants(view.participants);
      get().applyPhase(view.phase);
    } catch (caught) {
      handleError(caught, set);
    } finally {
      set({ busy: false });
    }
  },

  async startGame(humanColor) {
    const { roomId } = get();
    set({ busy: true, error: null });
    try {
      const agentColor: StoneColor = humanColor === 'black' ? 'white' : 'black';
      get().applyState(await api.newGame(roomId, agentColor));
    } catch (caught) {
      handleError(caught, set);
    } finally {
      set({ busy: false });
    }
  },

  async play(row, col) {
    const { roomId } = get();
    set({ busy: true, error: null });
    try {
      get().applyState(await api.move(roomId, row, col));
    } catch (caught) {
      handleError(caught, set);
    } finally {
      set({ busy: false });
    }
  },

  async resign() {
    const { roomId } = get();
    set({ busy: true, error: null });
    try {
      get().applyState(await api.resign(roomId));
    } catch (caught) {
      handleError(caught, set);
    } finally {
      set({ busy: false });
    }
  },

  dismissResult() {
    set({ resultDismissed: true });
  },

  clearError() {
    set({ error: null });
  },
}));

type Setter = (
  partial:
    | Partial<RoomStore>
    | ((state: RoomStore) => Partial<RoomStore>),
) => void;

function handleError(caught: unknown, set: Setter): void {
  // A rejected mutation still carries the authoritative state, so the board
  // never shows a move the server refused.
  if (caught instanceof ApiError && caught.state) {
    useRoomStore.getState().applyState(caught.state);
  }
  set({ error: errorMessage(caught) });
}

/**
 * Socket lifecycle, kept outside the store so React never owns the connection.
 *
 * Reconnect is exponential up to 10s; `hello` is treated as the truth after a
 * reconnect, which is why it replaces state wholesale instead of merging.
 */
function subscribeToRoom(
  roomId: string,
  set: Setter,
  get: () => RoomStore,
): () => void {
  const RECONNECT_BASE_MS = 1_000;
  const RECONNECT_MAX_MS = 10_000;

  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let disposed = false;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws?roomId=${encodeURIComponent(roomId)}`;

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
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (
        typeof message !== 'object' ||
        message === null ||
        typeof (message as { type?: unknown }).type !== 'string'
      ) {
        return;
      }

      const store = get();
      switch ((message as { type: string }).type) {
        case 'hello': {
          const hello = message as {
            state: GameState;
            participants: ParticipantView[];
            commentary: Commentary[];
            phase: RoomPhase;
          };
          store.reset({
            state: hello.state,
            participants: hello.participants,
            commentary: hello.commentary,
            phase: hello.phase,
          });
          break;
        }
        case 'phase':
          store.applyPhase((message as { phase: RoomPhase }).phase);
          break;
        case 'state':
          store.applyState((message as { state: GameState }).state);
          break;
        case 'participants':
          store.applyParticipants(
            (message as { participants: ParticipantView[] }).participants,
          );
          break;
        case 'commentary':
          store.applyCommentary(
            (message as { commentary: Commentary }).commentary,
          );
          break;
        case 'error': {
          const { code, message: text } = message as {
            code?: string;
            message?: string;
          };
          console.warn('[ws]', code, text);
          break;
        }
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

  // First paint may beat the socket: a REST snapshot still fills the board,
  // and the socket overwrites it as soon as `hello` arrives.
  api
    .getRoom(roomId)
    .then((view) => {
      if (disposed) {
        return;
      }
      const store = get();
      store.applyState(view.state);
      if (store.participants.length === 0) {
        store.applyParticipants(view.participants);
      }
      store.applyPhase(view.phase);
    })
    .catch(() => {
      // The socket keeps retrying; a failed first fetch is not fatal.
    });

  return () => {
    disposed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
    }
    socket?.close();
  };
}
