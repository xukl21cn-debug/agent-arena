import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { inspectProcess, killTree, reapOrphanedAgent, type ProcessView } from '../src/orphan.js';

const execute = promisify(execFile);
const marker = '--profile headless --json';

/** A process that says it is the agent we start, and nothing else about it. */
const agent = (pid: number, parentPid: number | null): ProcessView => ({
  pid,
  parentPid,
  commandLine: `node dsh.js ${marker} -`,
});

function harness(table: Record<number, ProcessView | null>) {
  const killed: number[] = [];
  return {
    killed,
    inspect: async (pid: number) => table[pid] ?? null,
    kill: async (pid: number) => { killed.push(pid); table[pid] = null; },
  };
}

it('ends the agent a dead runner left behind', async () => {
  const h = harness({ 4242: agent(4242, 777), 777: null });
  expect(await reapOrphanedAgent(4242, marker, h.inspect, h.kill)).toBe('killed');
  expect(h.killed).toEqual([4242]);
});

it('leaves alone a process that is not the agent, or whose runner is still there', async () => {
  // The pid was reused by something else.
  const reused = harness({ 4242: { pid: 4242, parentPid: 777, commandLine: 'node server.js' }, 777: null });
  expect(await reapOrphanedAgent(4242, marker, reused.inspect, reused.kill)).toBe('kept');
  // The runner that started it is alive: it is not an orphan.
  const owned = harness({ 4242: agent(4242, 777), 777: { pid: 777, parentPid: 1, commandLine: 'node runner' } });
  expect(await reapOrphanedAgent(4242, marker, owned.inspect, owned.kill)).toBe('kept');
  expect(reused.killed).toEqual([]);
  expect(owned.killed).toEqual([]);
});

it('has nothing to do without a pid or without a process', async () => {
  const h = harness({});
  expect(await reapOrphanedAgent(undefined, marker, h.inspect, h.kill)).toBe('gone');
  expect(await reapOrphanedAgent(4242, marker, h.inspect, h.kill)).toBe('gone');
  expect(h.killed).toEqual([]);
});

// Against the real operating system, on every platform.
it('finds and ends a real orphan whose runner is gone', async () => {
  // The "agent" is started detached, the way the adapter starts it on macOS and
  // Linux and the way it is left on Windows when a runner is killed: on its
  // own, and still running after the process that started it is gone.
  const childCode = `/* ${marker} */ setTimeout(() => {}, 60_000)`;
  const { stdout } = await execute(process.execPath, [
    '-e',
    "const child = require('node:child_process').spawn(process.execPath, ['-e', process.argv[1]], { stdio: 'ignore', windowsHide: true, detached: true }); child.unref(); console.log(child.pid);",
    childCode,
  ]);
  const pid = Number(stdout.trim());
  expect(Number.isInteger(pid)).toBe(true);

  try {
    const view = await inspectProcess(pid);
    expect(view).not.toBeNull();
    expect(view?.commandLine).toContain(marker);
    // Its parent, the short-lived starter, is gone.
    expect(view?.parentPid).not.toBeNull();
    expect(await inspectProcess(view!.parentPid!)).toBeNull();
    expect(await reapOrphanedAgent(pid, marker)).toBe('killed');
    expect(await inspectProcess(pid)).toBeNull();
  } finally {
    await killTree(pid).catch(() => undefined);
  }
}, 30_000);
