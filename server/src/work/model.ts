import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { WORK_STATUSES, type ArtifactRef, type WorkTask } from '@arena/shared';
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const timestamp = z.number().int().nonnegative();
const round = z.number().int().positive();
export const id = z.uuid();
export const role = z.enum(['coordinator', 'worker']);
export const name = text(64);
export const reason = text(2000);
const revision = z.string().regex(/^(?:[\da-f]{40}|[\da-f]{64})$/i);
const hash = z.string().regex(/^[\da-f]{64}$/i);
const relative = text(1024).refine((file) =>
  !path.posix.isAbsolute(file) && !path.win32.isAbsolute(file)
  && !file.includes(':') && !file.includes('\0') && !file.split(/[\\/]/u).includes('..'));
const artifact = z.object({
  kind: z.enum(['brief', 'design', 'prompt', 'work_summary', 'code_doc', 'review', 'other']),
  path: relative,
  summary: text(500),
  hash,
});
const artifactInput = artifact.partial({ hash: true }).extend({ path: text(1024) });
const test = z.object({ command: text(500), outcome: z.enum(['passed', 'failed']), note: text(1000).optional() });
const request = z.object({
  requestId: text(200),
  title: text(120),
  requirement: text(12000),
  branch: z.string().min(1).max(240).refine((value) => !/\s/u.test(value) && !value.includes('..')),
  base: revision,
  acceptance: z.array(text(500)).min(1).max(20),
  docs: z.array(artifact).min(1).max(50),
});
export const createInput = request.extend({ docs: z.array(artifactInput).min(1).max(50) });
const result = z.object({
  summary: text(8000),
  files: z.array(relative).max(200),
  commits: z.array(z.string().regex(/^[\da-f]{7,64}$/i)).max(50),
  tests: z.array(test).max(50),
  docs: z.array(artifact).max(50),
  unresolved: text(2000).optional(),
});
export const resultInput = result.extend({ docs: z.array(artifactInput).max(50) });
const review = z.object({
  decision: z.enum(['approve', 'rework']),
  summary: text(8000),
  doc: artifact,
  findings: text(8000).optional(),
});
export const claimInput = z.object({ taskId: id, round, claimId: id });
export const reviewInput = claimInput.extend({ ...review.shape, doc: artifactInput });
export const mergeInput = z.object({
  outcome: z.enum(['success', 'failed']),
  mergeCommit: revision.optional(),
  postMergeTests: z.array(test).max(50).optional(),
  pushed: z.boolean(),
  remote: text(500).optional(),
  note: reason.optional(),
});
const claim = z.object({ id, kind: z.enum(['work', 'review']), round, expiresAt: timestamp });
const participant = z.object({ id: z.string(), name });

export const taskSchema = request.extend({
  version: z.literal(2),
  id,
  workspace: z.string(),
  status: z.enum(WORK_STATUSES),
  coordinator: participant,
  worker: participant,
  rounds: z.array(z.object({
    round,
    createdAt: timestamp,
    workClaim: claim.optional(),
    reviewClaim: claim.optional(),
    work: result.extend({ claimId: id, submittedAt: timestamp }).optional(),
    review: review.extend({ claimId: id, reviewedAt: timestamp }).optional(),
  })).min(1),
  activeRound: round,
  createdAt: timestamp,
  updatedAt: timestamp,
  approvedAt: timestamp.optional(),
  acknowledgedAt: timestamp.optional(),
  merge: mergeInput.extend({ approvedAt: timestamp, recordedAt: timestamp }).optional(),
  issue: reason.optional(),
}).refine((task) => task.activeRound === task.rounds.length &&
  task.rounds.every((entry, index) => {
    const active = index === task.activeRound - 1;
    return entry.round === index + 1
      && (active && task.status === 'working'
        ? entry.workClaim?.kind === 'work' && entry.workClaim.round === entry.round
        : entry.workClaim === undefined)
      && (active && task.status === 'reviewing'
        ? entry.reviewClaim?.kind === 'review' && entry.reviewClaim.round === entry.round
        : entry.reviewClaim === undefined);
  }), '任务轮次或领取记录不一致') satisfies z.ZodType<WorkTask>;

export type CreateInput = z.infer<typeof createInput>;
export type ResultInput = z.infer<typeof resultInput>;
export type ReviewInput = z.infer<typeof reviewInput>;
export type MergeInput = z.infer<typeof mergeInput>;
export type ClaimInput = z.infer<typeof claimInput>;
export type WorkErrorCode = 'INVALID_REQUEST' | 'IDENTITY_REQUIRED' | 'ROLE_TAKEN'
  | 'NOT_COORDINATOR' | 'NOT_WORKER' | 'TASK_NOT_FOUND' | 'REQUEST_CONFLICT'
  | 'CLAIM_INACTIVE' | 'TASK_ACTIVE' | 'INVALID_STATE' | 'INVALID_ARTIFACT';

export class WorkError extends Error {
  constructor(readonly code: WorkErrorCode, message: string, readonly hint = '核对任务和参数后重试。') {
    super(message);
  }
}

export function readArtifact(workspace: string, input: z.infer<typeof artifactInput>): { ref: ArtifactRef; content: Buffer } {
  try {
    const file = realpathSync(path.resolve(workspace, relative.parse(input.path)));
    const local = path.relative(workspace, file);
    if (!local || local === '..' || local.startsWith('..' + path.sep) || path.isAbsolute(local)) {
      throw new Error('outside workspace');
    }
    if (!statSync(file).isFile()) throw new Error('not a file');
    const content = readFileSync(file);
    const digest = createHash('sha256').update(content).digest('hex');
    if (input.hash && input.hash.toLowerCase() !== digest) throw new Error('hash mismatch');
    return { ref: { ...input, hash: digest }, content };
  } catch {
    throw new WorkError('INVALID_ARTIFACT', `无法核验文档 ${input.path}。`, '确认文件位于工作区内，并检查路径和 SHA-256。');
  }
}

export function resolveArtifact(workspace: string, input: z.infer<typeof artifactInput>): ArtifactRef {
  return readArtifact(workspace, input).ref;
}
