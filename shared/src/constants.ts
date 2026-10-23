import type { RuleSet } from './game.js';

export const DEFAULT_BOARD_SIZE = 15;
export const DEFAULT_WIN_LENGTH = 5;

export const DEFAULT_RULES: RuleSet = {
  boardSize: DEFAULT_BOARD_SIZE,
  winLength: DEFAULT_WIN_LENGTH,
  overlineWin: true,
  forbidden: 'none',
};

export const DEFAULT_ROOM_ID = 'default';
export const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

export const MIN_COMMENTARY_LENGTH = 1;
export const MAX_COMMENTARY_LENGTH = 2000;
export const MAX_COMMENTARY_LOG = 50;

export const MIN_WAIT_MS = 1000;
export const DEFAULT_WAIT_MS = 20_000;
export const MAX_WAIT_MS = 60_000;

/**
 * How many recent moves hot-path responses (wait_for_turn / place_stone /
 * resign / errors) carry; get_state always returns the full history.
 */
export const AGENT_RECENT_MOVES = 8;
