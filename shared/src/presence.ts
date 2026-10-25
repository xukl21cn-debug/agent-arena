import type { ParticipantKind, StoneColor } from './game.js';

/**
 * How a seat currently looks to the outside world.
 *
 * Presence answers "is anyone actually there?" without guessing from silence:
 * a parked long-poll is proof of life, whose turn it is explains a quiet
 * opponent, and only a lost connection counts as disconnected.
 */
export type PresenceState =
  /** Never connected: no session, no viewer, no call ever arrived. */
  | 'unknown'
  /** A long-poll is parked on this seat: the process is alive and listening. */
  | 'waiting'
  /** It is this seat's turn and the game is running: silence is expected. */
  | 'thinking'
  /** Connected but not waiting and not on turn. */
  | 'idle'
  /** Was seen before, and its connection is gone. */
  | 'disconnected';

/**
 * How long an agent may stay silent before its seat reads as disconnected.
 *
 * Only a fallback for agent clients that expose no session (the stdio bridge
 * holds no session in the server process). It never affects game logic: a
 * player who thinks for ten minutes is still `thinking`, not `disconnected`,
 * and a human seat is judged by its browser tab alone.
 */
export const PRESENCE_STALE_MS = 120_000;

/**
 * How long an MCP session may stay silent before it counts as gone.
 *
 * Every call refreshes it, including a parked long-poll (which the server caps
 * at 60s), so a live agent never trips this. It exists because the MCP SDK's
 * `client.close()` aborts the local connection without telling the server: a
 * vanished client is only ever observable as silence.
 */
export const PRESENCE_SESSION_IDLE_MS = 90_000;

/** Raw signals a room collects for one seat. */
export interface SeatPresenceSignals {
  /** Something is attached: a session, a browser viewer, or a recent call. */
  connected: boolean;
  /** A long-poll is parked on this seat. */
  waiting: boolean;
  /** Epoch ms of the last observed activity, or null when never seen. */
  lastSeenAt: number | null;
  /** MCP clientInfo name reported by the agent, when it reported one. */
  client?: string;
}

export interface PresenceInput extends SeatPresenceSignals {
  /** True when the game is running and it is this seat's turn. */
  isTurn: boolean;
}

/**
 * Collapse the raw signals into one presence state.
 *
 * Order matters: a parked wait is the strongest evidence, then whether anything
 * is attached, then whose turn it is. Deciding *what counts as attached* is the
 * caller's job — it differs per client kind, and keeping that policy out of
 * here is what stops a human seat from being "connected" by a REST call.
 */
export function computePresence(input: PresenceInput): PresenceState {
  if (input.waiting) {
    return 'waiting';
  }
  if (input.connected) {
    return input.isTurn ? 'thinking' : 'idle';
  }
  return input.lastSeenAt === null ? 'unknown' : 'disconnected';
}

/** One seat as the web UI and MCP responses render it. */
export interface ParticipantView {
  seat: StoneColor;
  /** Who holds the seat, when the roster knows; legacy seats have none. */
  participantId?: string;
  kind: ParticipantKind;
  /** Display label: the declared name, else 你 / AI. */
  label: string;
  presence: PresenceState;
  client?: string;
  lastSeenAt: number | null;
  /** True while a long-poll is parked on this seat. */
  waiting: boolean;
  /** True when the game is running and this seat is to move. */
  isTurn: boolean;
}

/**
 * What the UI should say about the side that is not the local player.
 *
 * The distinction this encodes: "it is the AI's turn" and "the AI can actually
 * take its turn" are different facts. Before presence existed the UI collapsed
 * them, so an agent that never connected still read as 思考中 — the player sat
 * waiting for nobody.
 */
export type OpponentStatus =
  /** Not this side's turn. */
  | 'idle'
  /** Its turn, and a live connection is there: it is genuinely thinking. */
  | 'thinking'
  /** Its turn, but nothing is attached: it never connected. */
  | 'offline'
  /** Its turn, but the connection dropped. */
  | 'disconnected';

export function opponentStatus(
  participant: ParticipantView | null | undefined,
  options: { playing: boolean; isOpponentTurn: boolean },
): OpponentStatus {
  if (!options.playing || !options.isOpponentTurn) {
    return 'idle';
  }
  switch (participant?.presence) {
    case 'waiting':
    case 'thinking':
    case 'idle':
      return 'thinking';
    case 'disconnected':
      return 'disconnected';
    default:
      return 'offline';
  }
}
