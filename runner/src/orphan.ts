import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export type ReapOutcome = 'gone' | 'killed' | 'kept';

/** What the operating system reports about one process; `null` when there is none. */
export interface ProcessView {
  pid: number;
  /** The process that started it, as far as the OS knows; `null` when it does not say. */
  parentPid: number | null;
  commandLine: string;
}

export type ProcessInspector = (pid: number) => Promise<ProcessView | null>;
export type ProcessKiller = (pid: number) => Promise<void>;

/** The numeric field CIM reports as null for "no parent". */
const readPid = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

/** Windows: CIM is the only built-in that names a process's parent. */
async function inspectWindows(pid: number): Promise<ProcessView | null> {
  const { stdout } = await execute('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}') | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress`,
  ], { windowsHide: true, timeout: 15_000 });
  if (stdout.trim() === '') return null;
  const entry = JSON.parse(stdout) as { ProcessId?: unknown; ParentProcessId?: unknown; CommandLine?: unknown };
  return {
    pid,
    parentPid: readPid(entry.ParentProcessId),
    commandLine: typeof entry.CommandLine === 'string' ? entry.CommandLine : '',
  };
}

/** macOS and Linux: `ps` prints the parent first, then the command. */
async function inspectPosix(pid: number): Promise<ProcessView | null> {
  const { stdout } = await execute('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { timeout: 15_000 });
  if (stdout.trim() === '') return null;
  const match = /^\s*(\d+)\s+(.*)$/u.exec(stdout);
  if (match === null) return { pid, parentPid: null, commandLine: stdout };
  return { pid, parentPid: readPid(Number(match[1])), commandLine: match[2]! };
}

export const inspectProcess: ProcessInspector = (pid) =>
  process.platform === 'win32' ? inspectWindows(pid) : inspectPosix(pid);

/** End the process and everything it started, as the adapter does for a cancel. */
export const killTree: ProcessKiller = async (pid) => {
  if (process.platform === 'win32') {
    await execute('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    // Already gone is the outcome we wanted.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

/**
 * End an agent process that a killed runner left behind, so that resuming the
 * round does not put two agents on one working tree.
 *
 * The pid comes from the state file and pids are reused, so it is only trusted
 * as far as the process itself confirms it: its command line must carry the
 * marker every such agent is started with, and the runner that started it must
 * be gone. Anything else is left alone.
 */
export async function reapOrphanedAgent(
  pid: number | undefined,
  marker: string,
  inspect: ProcessInspector = inspectProcess,
  kill: ProcessKiller = killTree,
): Promise<ReapOutcome> {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return 'gone';
  const agent = await inspect(pid);
  if (agent === null) return 'gone';
  if (!agent.commandLine.includes(marker)) return 'kept';
  if (agent.parentPid !== null && (await inspect(agent.parentPid)) !== null) return 'kept';
  await kill(pid);
  return 'killed';
}
