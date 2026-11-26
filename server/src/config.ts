import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ROOM_ID,
  DEFAULT_WAIT_MS,
  MAX_WAIT_MS,
  MIN_WAIT_MS,
} from '@arena/shared';

/**
 * `<repo>/server/src` in dev (tsx) and `<repo>/server/dist` once built, so
 * going up twice lands on the repo root either way.
 */
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/**
 * Default root for persisted state. The authoritative store is the SQLite file
 * `<dataDir>/arena.db`; the `rooms` / `chat` / `work` / `archive` subdirectories
 * are only read once, as the import source of the pre-SQLite layout.
 *
 * Anchored to this file, not to `process.cwd()`. `pnpm dev` and `pnpm start`
 * run the server with `server/` as the working directory while
 * `node server/dist/index.js` from the repo root does not, so a cwd-relative
 * default silently split the same project across `server/data` and `data/`.
 */
export const DEFAULT_DATA_DIR = path.join(projectRoot, 'data');

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
  /** Root for persisted state; holds `arena.db` plus the legacy JSON import source. */
  dataDir: string;
  /** SQLite database file; defaults to <dataDir>/arena.db. */
  databaseFile: string;
  /** Archived games kept per room, newest first. */
  archiveLimit: number;
  workWorkspace: string;
  workClaimTtlMs: number;
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
  const workspace = env.ARENA_WORK_WORKSPACE?.trim() || projectRoot;
  if (!path.isAbsolute(workspace) || !statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('ARENA_WORK_WORKSPACE must be an existing absolute directory.');
  }
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

  // Both overrides resolve against the repo root, never `process.cwd()`: a
  // relative `ARENA_DB_PATH` would otherwise put the database wherever the
  // server happened to be started from.
  const dataDir = path.resolve(projectRoot, env.ARENA_DATA_DIR?.trim() || DEFAULT_DATA_DIR);
  return {
    port: readInteger(env, 'PORT', DEFAULT_PORT, 1, 65_535),
    host: env.HOST?.trim() || DEFAULT_HOST,
    waitDefaultMs,
    waitMaxMs: Math.max(waitDefaultMs, waitMaxMs),
    defaultRoomId: env.DEFAULT_ROOM_ID?.trim() || DEFAULT_ROOM_ID,
    serverUrl: env.ARENA_SERVER_URL?.trim() || DEFAULT_SERVER_URL,
    dataDir,
    databaseFile: path.resolve(projectRoot, env.ARENA_DB_PATH?.trim() || path.join(dataDir, 'arena.db')),
    archiveLimit: readInteger(env, 'ARENA_ARCHIVE_LIMIT', 20, 1, 500),
    workWorkspace: realpathSync(workspace),
    workClaimTtlMs: readInteger(env, 'ARENA_WORK_CLAIM_TTL_MS', 1_800_000, 60_000, 14_400_000),
  };
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
