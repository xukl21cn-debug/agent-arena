import path from 'node:path';
import {
  DEFAULT_ROOM_ID,
  DEFAULT_WAIT_MS,
  MAX_WAIT_MS,
  MIN_WAIT_MS,
} from '@arena/shared';

export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';

export interface ServerConfig {
  port: number;
  host: string;
  waitDefaultMs: number;
  waitMaxMs: number;
  defaultRoomId: string;
  serverUrl: string;
  /** Root for persisted rooms; one JSON file per room under <dataDir>/rooms. */
  dataDir: string;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }

  return Math.min(Math.max(value, min), max);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const waitDefaultMs = readInteger(
    env,
    'WAIT_DEFAULT_MS',
    DEFAULT_WAIT_MS,
    MIN_WAIT_MS,
    MAX_WAIT_MS,
  );
  const waitMaxMs = readInteger(
    env,
    'WAIT_MAX_MS',
    MAX_WAIT_MS,
    MIN_WAIT_MS,
    MAX_WAIT_MS,
  );

  return {
    port: readInteger(env, 'PORT', DEFAULT_PORT, 1, 65_535),
    host: env.HOST?.trim() || DEFAULT_HOST,
    waitDefaultMs,
    waitMaxMs: Math.max(waitDefaultMs, waitMaxMs),
    defaultRoomId: env.DEFAULT_ROOM_ID?.trim() || DEFAULT_ROOM_ID,
    serverUrl: env.ARENA_SERVER_URL?.trim() || DEFAULT_SERVER_URL,
    dataDir: env.ARENA_DATA_DIR?.trim() || path.join(process.cwd(), 'data'),
  };
}

export function resolveServerUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.ARENA_SERVER_URL?.trim() || DEFAULT_SERVER_URL;
}

/**
 * Clamp a requested long-poll timeout into the supported window.
 * Non-numeric or missing values fall back to the configured default.
 */
export function clampWaitMs(
  requested: unknown,
  config: Pick<ServerConfig, 'waitDefaultMs' | 'waitMaxMs'>,
): number {
  const parsed =
    typeof requested === 'number'
      ? requested
      : typeof requested === 'string' && requested.trim() !== ''
        ? Number(requested)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return config.waitDefaultMs;
  }

  return Math.min(Math.max(Math.round(parsed), MIN_WAIT_MS), config.waitMaxMs);
}
