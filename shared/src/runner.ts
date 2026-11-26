import type { WorkStatus } from './work.js';

export const RUNNER_STATUSES = ['online', 'offline'] as const;
export type RunnerStatus = typeof RUNNER_STATUSES[number];

export const RUNNER_EVENT_LEVELS = ['info', 'warn', 'error'] as const;
export type RunnerEventLevel = typeof RUNNER_EVENT_LEVELS[number];

export const RUNNER_COMMAND_KINDS = ['cancel'] as const;
export type RunnerCommandKind = typeof RUNNER_COMMAND_KINDS[number];

/** The task a runner is currently executing, if any. */
export interface RunnerTaskRef {
  id: string;
  title: string;
  status: WorkStatus;
  round: number;
  startedAt?: number;
}

/** One line in the runner's short observation log. */
export interface RunnerEvent {
  seq: number;
  at: number;
  level: RunnerEventLevel;
  message: string;
  taskId?: string;
}

export interface RunnerSummary {
  id: string;
  name: string;
  status: RunnerStatus;
  workspace: string;
  version: string;
  registeredAt: number;
  lastSeenAt: number;
  currentTask: RunnerTaskRef | null;
  lastEvent?: RunnerEvent;
}

export interface RunnerDetail extends RunnerSummary {
  events: RunnerEvent[];
}

export interface RunnerRegisterRequest {
  id: string;
  name: string;
  workspace: string;
  version: string;
}

export interface RunnerHeartbeatRequest {
  currentTask?: RunnerTaskRef | null;
}

export interface RunnerEventInput {
  level: RunnerEventLevel;
  message: string;
  taskId?: string;
}

export interface RunnerCommand {
  seq: number;
  kind: RunnerCommandKind;
  taskId?: string;
  requestedAt: number;
}

/**
 * Where a runner stopped reading commands. The epoch names the registry
 * instance the number belongs to: after a server restart the numbering starts
 * over, and a bare number from before would land inside the new sequence.
 */
export interface RunnerCommandCursor {
  seq: number;
  epoch?: string;
}

export interface RunnerCommandBatch {
  commands: RunnerCommand[];
  nextSeq: number;
  /** The registry instance this batch was read from; send it back as the cursor's epoch. */
  epoch: string;
}
