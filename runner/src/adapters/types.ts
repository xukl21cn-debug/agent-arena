import type { WorkTask } from '@arena/shared';

export interface AgentRunOptions {
  /** Continue an existing persisted agent session instead of starting a new one. */
  resumeSessionId?: string;
  /** Text placed before the task handoff, e.g. to tell the agent its last run was cut short. */
  preamble?: string;
  /** Called as soon as the CLI reports its session identity. */
  onSessionId?: (sessionId: string) => void;
  /** Called with the CLI process id as soon as it is started. */
  onPid?: (pid: number | undefined) => void;
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
