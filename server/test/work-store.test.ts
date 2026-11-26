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

  it('dispatches a task from the local work page and reviews it as the human coordinator', async () => {
    const { worker } = join();
    const task = store.createForHuman(request);
    expect(task).toMatchObject({ status: 'queued', coordinator: { id: 'w_human_0', name: '看板用户' } });
    const claimed = await store.wait(worker, options);
    store.submitWork(worker, { taskId: task.id, round: 1, claimId: claimed.claim!.id }, result);
    const reviewed = store.reviewForHuman(task.id, { decision: 'approve', summary: '人工复审通过' });
    expect(reviewed.status).toBe('pending_ack');
    expect(reviewed.rounds[0]?.review).toMatchObject({ decision: 'approve', summary: '人工复审通过' });
  });

  it('requires findings when the human reviewer requests rework', async () => {
    const { worker } = join();
    const task = store.createForHuman(request);
    const claimed = await store.wait(worker, options);
    store.submitWork(worker, { taskId: task.id, round: 1, claimId: claimed.claim!.id }, result);
    expect(() => store.reviewForHuman(task.id, { decision: 'rework', summary: '需要调整' })).toThrow('具体意见');
  });

  it('rejects a human approval without commits without leaving the task reviewing', async () => {
    const { worker } = join();
    const task = store.createForHuman(request);
    const claimed = await store.wait(worker, options);
    store.submitWork(worker, { taskId: task.id, round: 1, claimId: claimed.claim!.id }, {
      summary: '受阻', files: [], commits: [], tests: [], docs: [], unresolved: '环境不通',
    });
    expect(() => store.reviewForHuman(task.id, { decision: 'approve', summary: '通过' })).toThrow('没有可合并的提交');
    expect(store.get(task.id).status).toBe('pending_review');
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

describe('interrupted rounds and board cancellation', () => {
  /** A claimed round whose runner died: the lease is never renewed and runs out. */
  async function interruptedTask(): Promise<{ worker: ReturnType<typeof join>['worker']; taskId: string; claimId: string }> {
    const { worker } = join();
    const task = store.createForHuman(request);
    const claimed = await store.wait(worker, options);
    expect(claimed.reason).toBe('assigned');
    clock += lease + 1;
    expect(store.get(task.id)).toMatchObject({ status: 'needs_attention', issue: '领取租约已过期。请确认现场后处理。' });
    return { worker, taskId: task.id, claimId: claimed.claim!.id };
  }

  it('continues an interrupted round as a fresh claim on the same round', async () => {
    const { worker, taskId, claimId } = await interruptedTask();
    const resumed = store.resumeRound(taskId);
    expect(resumed).toMatchObject({ status: 'rework_requested', activeRound: 1, issue: '已请求继续第 1 轮，等待执行者领取。' });
    expect(resumed.rounds[0]?.workClaim).toBeUndefined();

    // The worker gets the same round back under a new claim.
    const again = await store.wait(worker, options);
    expect(again).toMatchObject({ reason: 'assigned', task: { id: taskId, activeRound: 1 } });
    expect(again.claim).toMatchObject({ kind: 'work', round: 1 });
    expect(again.claim!.id).not.toBe(claimId);

    // The continued round is handed in under the new claim; the old one stays dead.
    expect(() => store.submitWork(worker, { taskId, round: 1, claimId }, result)).toThrow('失效');
    store.submitWork(worker, { taskId, round: 1, claimId: again.claim!.id }, result);
    expect(store.get(taskId)).toMatchObject({
      status: 'pending_review',
      rounds: [{ work: { claimId: again.claim!.id }, workClaim: undefined }],
    });
  });

  it('refuses to continue a task that is not waiting on an interrupted execution', async () => {
    const { worker } = join();
    const task = store.createForHuman(request);
    expect(() => store.resumeRound(task.id)).toThrow('只有执行途中被打断');
    const claimed = await store.wait(worker, options);
    store.submitWork(worker, { taskId: task.id, round: 1, claimId: claimed.claim!.id }, result);
    // Cut short during review instead: the round already has its work result.
    store.takeover(task.id, '统筹失联。');
    expect(store.get(task.id).status).toBe('needs_attention');
    expect(() => store.resumeRound(task.id)).toThrow(
      expect.objectContaining({ message: '只有执行途中被打断的轮次可以继续。', hint: '复审或合并阶段出问题的任务请接管或取消。' }),
    );
    expect(store.get(task.id).status).toBe('needs_attention');
  });

  it('cancels a running task from the board whoever dispatched it, and frees the board', async () => {
    const { coordinator, worker } = join();
    const task = store.create(coordinator, request);
    const claimed = await store.wait(worker, options);
    expect(claimed.reason).toBe('assigned');

    const cancelled = store.cancelForHuman(task.id, '方向变了，不再需要。');
    expect(cancelled).toMatchObject({ status: 'cancelled', issue: '方向变了，不再需要。' });
    expect(cancelled.rounds[0]?.workClaim).toBeUndefined();
    // Cancelling twice is harmless.
    expect(store.cancelForHuman(task.id, '再点一次')).toMatchObject({ status: 'cancelled' });
    // The runner's stale claim is refused, so nothing lands on a cancelled task.
    expect(() => store.submitWork(worker, { taskId: task.id, round: 1, claimId: claimed.claim!.id }, result)).toThrow('失效');
    // And the next task is picked up right away instead of waiting behind it.
    const next = store.createForHuman({ ...request, requestId: 'request-2' });
    expect(await store.wait(worker, options)).toMatchObject({ reason: 'assigned', task: { id: next.id } });
  });

  it('still asks the coordinator for a confirmation before cancelling a running task', async () => {
    const { coordinator, worker } = join();
    const task = store.create(coordinator, request);
    await store.wait(worker, options);
    expect(() => store.cancel(coordinator, task.id, '先不强制')).toThrow('仍可能在执行');
    expect(store.cancel(coordinator, task.id, '确认现场后强制取消', true).status).toBe('cancelled');
  });
});
