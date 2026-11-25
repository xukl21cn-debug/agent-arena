import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** DSH headless invocation settings for the first adapter. */
export interface DshConfig {
  /** Executable name or absolute path. Defaults to `dsh` (`dsh.cmd` on Windows). */
  command: string;
  /** Extra words placed before the DSH CLI arguments (for wrappers or test fixtures). */
  argsPrefix: string[];
  /** DSH profile name. The shipped one-shot profile is `headless`. */
  profile: string;
  /** Permission preset passed to DSH; `null` leaves the session default. */
  permissionMode: string | null;
  /** Approval policy for unattended runs; `null` leaves the session default. */
  approvalPolicy: 'ask' | 'never' | null;
  /** Extra writable roots, passed through as `--add-dir`. */
  extraDirs: string[];
  /** Hard wall-clock limit for one DSH process. */
  timeoutMs: number;
}

export interface RunnerConfig {
  /** Stable registry id; derived from the name when omitted. */
  id: string;
  serverUrl: string;
  name: string;
  workspace: string;
  stateFile: string;
  waitTimeoutMs: number;
  heartbeatIntervalMs: number;
  dsh: DshConfig;
}

interface RawConfig {
  id?: unknown;
  serverUrl?: unknown;
  name?: unknown;
  workspace?: unknown;
  stateFile?: unknown;
  waitTimeoutMs?: unknown;
  heartbeatIntervalMs?: unknown;
  dsh?: Record<string, unknown>;
}

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';
const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
const DEFAULT_DSH_TIMEOUT_MS = 30 * 60_000;

function text(value: unknown, fallback: string, field: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function integer(value: unknown, fallback: number, field: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string or null.`);
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${field} must be an array of non-empty strings.`);
  }
  return value.map((item) => item.trim());
}

function resolveRelative(baseDir: string, value: string, field: string): string {
  const resolved = path.resolve(baseDir, value);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`${field} must be an existing directory: ${resolved}`);
  }
  return realpathSync(resolved);
}

/**
 * Load the local runner configuration. A missing default file is allowed and
 * produces working defaults for the current checkout; an explicitly named file
 * must exist. Relative paths in the file resolve from the file's directory.
 */
export function loadRunnerConfig(
  filePath?: string,
  cwd = process.cwd(),
): RunnerConfig {
  const requested = filePath ?? process.env.ARENA_RUNNER_CONFIG?.trim() ?? 'runner.config.json';
  const required = filePath !== undefined || Boolean(process.env.ARENA_RUNNER_CONFIG?.trim());
  const absoluteFile = path.resolve(cwd, requested);
  const exists = existsSync(absoluteFile);
  if (!exists && required) {
    throw new Error(`Runner config not found: ${absoluteFile}`);
  }
  const raw: RawConfig = exists
    ? JSON.parse(readFileSync(absoluteFile, 'utf8')) as RawConfig
    : {};
  const baseDir = exists ? path.dirname(absoluteFile) : cwd;
  const dshRaw = raw.dsh ?? {};
  const workspace = resolveRelative(
    baseDir,
    text(raw.workspace, exists ? '.' : cwd, 'workspace'),
    'workspace',
  );
  const name = text(raw.name, 'runner-dsh', 'name');
  const id = text(raw.id, `runner-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`, 'id');
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(id)) {
    throw new Error('id must match [a-zA-Z0-9_-]{1,64}.');
  }
  const stateFile = path.resolve(baseDir, text(raw.stateFile, '.arena-runner/state.json', 'stateFile'));
  const permissionMode = dshRaw.permissionMode === undefined
    ? 'workspace-write'
    : optionalText(dshRaw.permissionMode, 'dsh.permissionMode');
  const approvalPolicy = dshRaw.approvalPolicy === undefined
    ? 'never'
    : optionalText(dshRaw.approvalPolicy, 'dsh.approvalPolicy');
  if (approvalPolicy !== null && approvalPolicy !== 'ask' && approvalPolicy !== 'never') {
    throw new Error('dsh.approvalPolicy must be "ask", "never", or null.');
  }
  const rawCommand = text(dshRaw.command, process.platform === 'win32' ? 'dsh.cmd' : 'dsh', 'dsh.command');
  const command = process.platform === 'win32' && rawCommand === 'dsh' ? 'dsh.cmd' : rawCommand;

  return {
    id,
    serverUrl: text(raw.serverUrl, DEFAULT_SERVER_URL, 'serverUrl').replace(/\/+$/u, ''),
    name,
    workspace,
    stateFile,
    waitTimeoutMs: integer(raw.waitTimeoutMs, DEFAULT_WAIT_TIMEOUT_MS, 'waitTimeoutMs', 1_000, 30_000),
    heartbeatIntervalMs: integer(raw.heartbeatIntervalMs, 5_000, 'heartbeatIntervalMs', 1_000, 60_000),
    dsh: {
      command,
      argsPrefix: stringArray(dshRaw.argsPrefix, 'dsh.argsPrefix'),
      profile: text(dshRaw.profile, 'headless', 'dsh.profile'),
      permissionMode,
      approvalPolicy,
      extraDirs: stringArray(dshRaw.extraDirs, 'dsh.extraDirs')
        .map((entry, index) => resolveRelative(workspace, entry, `dsh.extraDirs[${index}]`)),
      timeoutMs: integer(dshRaw.timeoutMs, DEFAULT_DSH_TIMEOUT_MS, 'dsh.timeoutMs', 60_000, 4 * 60 * 60_000),
    },
  };
}
