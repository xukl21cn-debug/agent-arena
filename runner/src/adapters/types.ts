import type { WorkTask } from '@arena/shared';

export interface AgentRunOptions {
  /** Continue an existing persisted agent session instead of starting a new one. */
  resumeSessionId?: string;
  /** Called as soon as the CLI reports its session identity. */
  onSessionId?: (sessionId: string) => void;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  sessionId?: string;
  text: string;
  reasonKind: string | null;
  exitCode: number;
  stderr: string;
}

/** A client adapter is an execution target, not an agent: it gets a task and returns evidence. */
export interface AgentAdapter {
  run(task: WorkTask, options?: AgentRunOptions): Promise<AgentRunResult>;
}
