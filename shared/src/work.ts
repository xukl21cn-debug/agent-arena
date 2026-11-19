export const WORK_STATUSES = [
  'queued', 'working', 'pending_review', 'reviewing', 'rework_requested', 'pending_ack',
  'pending_merge_approval', 'merge_approved', 'done', 'needs_attention', 'cancelled',
] as const;

export type WorkStatus = typeof WORK_STATUSES[number];
export type WorkRole = 'coordinator' | 'worker';
export interface WorkParticipant { id: string; name: string }

export interface ArtifactRef {
  kind: 'brief' | 'design' | 'prompt' | 'work_summary' | 'code_doc' | 'review' | 'other';
  path: string;
  summary: string;
  hash: string;
}

export interface TestEvidence {
  command: string;
  outcome: 'passed' | 'failed';
  note?: string;
}

export interface Claim {
  id: string;
  kind: 'work' | 'review';
  round: number;
  expiresAt: number;
}

export interface WorkResult {
  claimId: string;
  summary: string;
  files: string[];
  commits: string[];
  tests: TestEvidence[];
  docs: ArtifactRef[];
  unresolved?: string;
  submittedAt: number;
}

export interface WorkReview {
  claimId: string;
  decision: 'approve' | 'rework';
  summary: string;
  doc: ArtifactRef;
  findings?: string;
  reviewedAt: number;
}

export interface WorkRound {
  round: number;
  createdAt: number;
  work?: WorkResult;
  review?: WorkReview;
  workClaim?: Claim;
  reviewClaim?: Claim;
}

export interface MergeRecord {
  approvedAt: number;
  outcome: 'success' | 'failed';
  mergeCommit?: string;
  postMergeTests?: TestEvidence[];
  pushed: boolean;
  remote?: string;
  note?: string;
  recordedAt: number;
}

export interface WorkTask {
  version: 2;
  id: string;
  requestId: string;
  workspace: string;
  title: string;
  requirement: string;
  branch: string;
  base: string;
  acceptance: string[];
  docs: ArtifactRef[];
  status: WorkStatus;
  coordinator: WorkParticipant;
  worker: WorkParticipant;
  rounds: WorkRound[];
  activeRound: number;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  acknowledgedAt?: number;
  merge?: MergeRecord;
  issue?: string;
}

export interface WorkTaskSummary {
  id: string;
  title: string;
  status: WorkStatus;
  activeRound: number;
  branch: string;
  coordinatorName: string;
  workerName: string;
  updatedAt: number;
}
