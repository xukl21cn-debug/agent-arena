import { describe, expect, it } from 'vitest';
import type { RunnerDetail, RunnerTaskRef } from '@arena/shared';
import { RunnerRegistry } from '../src/runner/registry.js';

const task: RunnerTaskRef = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Test task',
  status: 'working',
  round: 1,
  startedAt: 1_000,
};

describe('RunnerRegistry', () => {
  it('registers, updates current task, and lists the runner', () => {
    let now = 1_000;
    const registry = new RunnerRegistry(1_000, () => now);
    const summary = registry.register({ id: 'runner-1', name: 'Local', workspace: '/tmp/ws', version: '0.1.0' });
    expect(summary).toMatchObject({ id: 'runner-1', status: 'online', currentTask: null });

    now = 1_500;
    const detail = registry.heartbeat('runner-1', { currentTask: task });
    expect(detail.currentTask).toEqual(task);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('runner-1')).toMatchObject({ lastSeenAt: 1_500, status: 'online' });
  });

  it('records events and wakes a command long-poll', async () => {
    let now = 1_000;
    const registry = new RunnerRegistry(1_000, () => now);
    registry.register({ id: 'runner-1', name: 'Local', workspace: '/tmp/ws', version: '0.1.0' });
    expect(registry.event('runner-1', { level: 'info', message: 'started' })).toMatchObject({ seq: 1, message: 'started' });

    const parked = registry.waitForCommands('runner-1', { seq: 0, epoch: registry.epoch }, 500);
    now = 1_100;
    const command = registry.enqueue('runner-1', 'cancel', task.id);
    const batch = await parked;
    expect(batch.commands).toEqual([command]);
    expect(batch).toMatchObject({ nextSeq: command.seq, epoch: registry.epoch });
  });

  it('returns the queued commands to a restarted poll after a timeout', async () => {
    const registry = new RunnerRegistry(1_000, () => 1_000);
    registry.register({ id: 'runner-1', name: 'Local', workspace: '/tmp/ws', version: '0.1.0' });
    expect((await registry.waitForCommands('runner-1', { seq: 0 }, 5)).commands).toEqual([]);
    const command = registry.enqueue('runner-1', 'cancel');
    expect((await registry.waitForCommands('runner-1', { seq: 0 }, 5)).commands).toEqual([command]);
  });

  it('starts over on a cursor from before a server restart, so no new command is skipped', async () => {
    const registry = new RunnerRegistry(1_000, () => 1_000);
    registry.register({ id: 'runner-1', name: 'Local', workspace: '/tmp/ws', version: '0.1.0' });
    // Three commands queued after the restart, before the runner came back.
    const queued = [
      registry.enqueue('runner-1', 'cancel'),
      registry.enqueue('runner-1', 'cancel'),
      registry.enqueue('runner-1', 'cancel'),
    ];
    // The runner still holds a cursor from the previous server process whose
    // number happens to fall inside the new sequence: reading on from it
    // would silently drop the first two.
    const stale = await registry.waitForCommands('runner-1', { seq: 2, epoch: 'previous-server-process' }, 5);
    expect(stale.commands).toEqual(queued);
    expect(stale).toMatchObject({ nextSeq: 3, epoch: registry.epoch });
    // A cursor beyond the new queue is handled the same way.
    expect((await registry.waitForCommands('runner-1', { seq: 7, epoch: 'previous-server-process' }, 5)).commands).toEqual(queued);
  });

  it('trusts a cursor from its own instance and forgets what the runner has dealt with', async () => {
    const registry = new RunnerRegistry(1_000, () => 1_000);
    registry.register({ id: 'runner-1', name: 'Local', workspace: '/tmp/ws', version: '0.1.0' });
    const queued = [
      registry.enqueue('runner-1', 'cancel'),
      registry.enqueue('runner-1', 'cancel'),
      registry.enqueue('runner-1', 'cancel'),
    ];
    const cursor = (seq: number) => ({ seq, epoch: registry.epoch });
    expect((await registry.waitForCommands('runner-1', cursor(0), 5)).commands).toEqual(queued);
    expect((await registry.waitForCommands('runner-1', cursor(3), 5)).commands).toEqual([]);
    // Dealt with means gone: a runner that lost its cursor file gets nothing old back.
    expect((await registry.waitForCommands('runner-1', cursor(0), 5)).commands).toEqual([]);
  });

  it('keeps only the last hundred commands for a runner that never reads them', async () => {
    const registry = new RunnerRegistry(1_000, () => 1_000);
    registry.register({ id: 'runner-1', name: 'Local', workspace: '/tmp/ws', version: '0.1.0' });
    for (let index = 0; index < 130; index += 1) registry.enqueue('runner-1', 'cancel');
    const batch = await registry.waitForCommands('runner-1', { seq: 0, epoch: registry.epoch }, 5);
    expect(batch.commands).toHaveLength(100);
    expect(batch.commands[0]?.seq).toBe(31);
    expect(batch.nextSeq).toBe(130);
  });

  it('turns stale runners offline and notifies subscribers once', () => {
    let now = 1_000;
    const registry = new RunnerRegistry(1_000, () => now);
    const seen: RunnerDetail[] = [];
    registry.subscribe((detail) => seen.push(detail));
    registry.register({ id: 'runner-1', name: 'Local', workspace: '/tmp/ws', version: '0.1.0' });
    seen.length = 0;
    now = 3_000;
    registry.sweep();
    expect(registry.list()[0]?.status).toBe('offline');
    expect(seen.at(-1)?.status).toBe('offline');
    registry.sweep();
    expect(seen).toHaveLength(1);
  });

  it('rejects unknown ids', () => {
    const registry = new RunnerRegistry();
    expect(() => registry.heartbeat('missing')).toThrow(/找不到/u);
  });
});
