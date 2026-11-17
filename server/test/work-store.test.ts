import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkStore } from '../src/work/store.js';

describe('work delivery persistence', () => {
  const binding = { codexSession: 'codex-1', workerSession: 'dsh-1', workspace: '/probe' };
  const request = { requestId: 'request-1', prompt: 'Inspect the project.', branch: 'probe', base: 'a'.repeat(40) };
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'arena-work-store-'));
  });

  afterEach(() => {
    const workDir = path.join(dataDir, 'work');
    for (const entry of readdirSync(workDir)) unlinkSync(path.join(workDir, entry));
    rmdirSync(workDir);
    rmdirSync(dataDir);
  });

  it('recovers the next review and deduplicates the worker report across restart', () => {
    const first = new WorkStore(dataDir, binding);
    const task = first.create(request, 100);
    const workClaim = first.claimNext(undefined, 101).task!.claim!;
    const result = { sessionId: binding.workerSession, text: 'Result from DSH.' };
    first.complete(task.id, workClaim.id, result, 102);

    const restored = new WorkStore(dataDir, binding);
    expect(restored.complete(task.id, workClaim.id, result, 103).status).toBe('pending_review');
    const review = restored.claimNext(undefined, 104).task!;
    expect(review.claim?.kind).toBe('review');
    expect(review.work?.result).toEqual(result);
    expect(restored.claimNext(undefined, 105)).toEqual({ task: null, blockedBy: task.id });
  });

  it('holds an expired delivery for reconciliation instead of running it again', () => {
    const first = new WorkStore(dataDir, binding, 1000);
    const task = first.create(request, 100);
    const claim = first.claimNext(undefined, 101).task!.claim!;

    const restored = new WorkStore(dataDir, binding, 1000);
    expect(restored.claimNext(undefined, 10_000)).toEqual({ task: null, blockedBy: task.id });
    expect(restored.get(task.id, 10_000).status).toBe('needs_attention');
    expect(() => restored.complete(task.id, claim.id, { sessionId: binding.workerSession, text: 'Late.' }, 10_001))
      .toThrow('接力租约已失效');
  });
});
