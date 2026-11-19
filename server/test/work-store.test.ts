import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveArtifact, type CreateInput } from '../src/work/model.js';
import { WorkStore } from '../src/work/store.js';

let dir: string;
let clock: number;
let store: WorkStore;
const lease = 60_000;
const brief = { kind: 'brief', path: 'brief.md', summary: 'Scope' } as const;
const request: CreateInput = {
  requestId: 'request-1', title: 'Work item', requirement: 'Confirmed scope',
  branch: 'feat/probe', base: 'a'.repeat(40), acceptance: ['Accept'], docs: [brief],
};
const result = { summary: 'Result', files: ['brief.md'], commits: ['abcdef0'], tests: [], docs: [] };
const review = { summary: 'Reviewed', doc: { kind: 'review', path: 'review.md', summary: 'Review' } } as const;
const options = { timeoutMs: 5 };

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-work-store-'));
  clock = 100;
  writeFileSync(path.join(dir, 'brief.md'), 'Scope');
  writeFileSync(path.join(dir, 'review.md'), 'Review');
  store = new WorkStore(dir, dir, lease, () => clock);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function join() {
  return { coordinator: store.join('coordinator', 'codex', 'c'), worker: store.join('worker', 'dsh', 'w') };
}

describe('work relay persistence', () => {
  it('reuses same-name identity, keeps other names separate, and validates artifacts', () => {
    const { coordinator, worker } = join();
    expect(store.join('worker', 'dsh', 'w2')).toEqual(worker);
    expect(() => store.join('worker', 'other', 'x')).toThrow('已被占用');
    for (const file of ['missing.md', '../brief.md', path.join(dir, 'brief.md')]) {
      expect(() => resolveArtifact(store.workspace, { ...brief, path: file })).toThrow('无法核验');
    }
    expect(() => resolveArtifact(store.workspace, { ...brief, hash: '0'.repeat(64) })).toThrow('无法核验');
    const task = store.create(coordinator, request);
    expect(store.create(coordinator, request).id).toBe(task.id);
    expect(() => store.create(coordinator, { ...request, title: 'Different' })).toThrow('不同内容');
    store.leave(worker, 'w');
    store.leave(worker, 'w2');
    const other = store.join('worker', 'other', 'x');
    expect(() => store.get(task.id, other)).toThrow('找不到');
  });

  it('serializes claims and preserves both rounds through approval and restart', async () => {
    const { coordinator, worker } = join();
    const task = store.create(coordinator, request);
    const second = store.create(coordinator, { ...request, requestId: 'request-2' });
    const taskId = task.id;
    expect(await store.wait(worker, { taskId, ...options })).toEqual({ reason: 'timeout' });
    const [firstClaim, duplicate] = await Promise.all([store.wait(worker, options), store.wait(worker, options)]);
    expect(firstClaim.reason).toBe('assigned');
    expect(duplicate.reason).toBe('in_progress');
    const first = { taskId, round: 1, claimId: firstClaim.claim!.id };
    expect(() => store.leave(worker, 'w')).toThrow('仍有');
    store.submitWork(worker, first, result);
    expect(store.submitWork(worker, first, result).status).toBe('pending_review');
    const reviewing = await store.wait(coordinator, options);
    store.submitReview(coordinator, { ...review, taskId, round: 1, claimId: reviewing.claim!.id, decision: 'rework', findings: 'Fix test' });
    const retried = await store.wait(worker, options);
    expect(retried.task?.id).toBe(taskId);
    expect(retried.task?.activeRound).toBe(2);
    expect(() => store.renew(worker, first)).toThrow('失效');
    store.submitWork(worker, { taskId, round: 2, claimId: retried.claim!.id }, result);
    const check = await store.wait(coordinator, options);
    store.submitReview(coordinator, { ...review, taskId, round: 2, claimId: check.claim!.id, decision: 'approve' });
    expect(() => store.approveMerge(taskId)).toThrow('收工确认');
    store.acknowledge(worker, taskId, 2);
    expect(() => store.recordMerge(coordinator, taskId, { outcome: 'failed', pushed: false })).toThrow('放行');
    store = new WorkStore(dir, dir, lease, () => clock);
    const resumed = join();
    expect(store.get(taskId).status).toBe('pending_merge_approval');
    clock += 1;
    const approval = store.approveMerge(taskId);
    expect(store.approveMerge(taskId).approvedAt).toBe(approval.approvedAt);
    const merged = store.recordMerge(resumed.coordinator, taskId, {
      outcome: 'success', mergeCommit: 'b'.repeat(40), postMergeTests: [{ command: 'pnpm test', outcome: 'passed' }], pushed: false,
    });
    expect(merged.status).toBe('done');
    expect(merged.rounds.map((round) => round.review?.decision)).toEqual(['rework', 'approve']);
    expect(merged.merge?.approvedAt).toBe(approval.approvedAt);
    store = new WorkStore(dir, dir, lease, () => clock);
    expect(store.get(taskId)).toEqual(merged);
    expect((await store.wait(join().worker, options)).task?.id).toBe(second.id);
  });

  it('requires takeover when a restart interrupts an approved merge with no evidence', async () => {
    const { coordinator, worker } = join();
    const { id: taskId } = store.create(coordinator, request);
    const assigned = await store.wait(worker, options);
    store.submitWork(worker, { taskId, round: 1, claimId: assigned.claim!.id }, result);
    const reviewing = await store.wait(coordinator, options);
    store.submitReview(coordinator, { ...review, taskId, round: 1, claimId: reviewing.claim!.id, decision: 'approve' });
    store.acknowledge(worker, taskId, 1);
    const approval = store.approveMerge(taskId);

    store = new WorkStore(dir, dir, lease, () => clock);
    const resumed = join();
    const observed = await store.wait(resumed.coordinator, { taskId, afterStatus: 'merge_approved', ...options });
    expect(observed.reason).toBe('needs_attention');
    expect(observed.task).toMatchObject({
      status: 'needs_attention',
      issue: expect.stringContaining('未登记合并结果'),
      approvedAt: approval.approvedAt,
      acknowledgedAt: approval.acknowledgedAt,
      rounds: approval.rounds,
    });
    expect(observed.task?.merge).toBeUndefined();
    expect(store.approveMerge(taskId).status).toBe('needs_attention');
    expect(() => store.recordMerge(resumed.coordinator, taskId, { outcome: 'failed', pushed: false })).toThrow('放行');
    expect(JSON.parse(readFileSync(path.join(dir, 'work', taskId + '.json'), 'utf8')).status).toBe('needs_attention');
  });

  it('recovers claims by name, renews and reconciles an expired claim without reclaiming it', async () => {
    const { coordinator, worker } = join();
    const task = store.create(coordinator, request);
    const claimed = await store.wait(worker, options);
    store = new WorkStore(dir, dir, lease, () => clock);
    const resumed = join();
    const args = { taskId: task.id, round: 1, claimId: claimed.claim!.id };
    expect((await store.wait(resumed.worker, options)).claim?.id).toBe(args.claimId);
    clock += 200;
    expect(store.renew(resumed.worker, args).expiresAt).toBe(clock + lease);
    clock += lease;
    expect(store.get(task.id).status).toBe('needs_attention');
    expect(() => store.submitWork(resumed.worker, args, result)).toThrow('失效');
    expect((await store.wait(resumed.worker, options)).reason).toBe('needs_attention');
  });

  it('preserves legacy and invalid records on disk and skips them when loading', () => {
    const legacy = path.join(dir, 'work', 'legacy.json');
    writeFileSync(legacy, '{"version":1}');
    const { coordinator } = join();
    const task = store.create(coordinator, request);
    const invalidPath = path.join(dir, 'work', task.id + '.json');
    const invalid = JSON.stringify({ ...task, status: 'working' });
    writeFileSync(invalidPath, invalid);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(new WorkStore(dir, dir, lease).list()).toEqual([]);
      expect(warning).toHaveBeenCalledTimes(2);
      expect(readFileSync(legacy, 'utf8')).toBe('{"version":1}');
      expect(readFileSync(invalidPath, 'utf8')).toBe(invalid);
    } finally {
      warning.mockRestore();
    }
  });
});
