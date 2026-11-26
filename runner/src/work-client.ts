import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Claim, WorkTask } from '@arena/shared';
import type { AgentResult } from './result.js';

export interface WorkWaitResult {
  reason: string;
  task?: WorkTask;
  claim?: Claim;
  hint?: string;
}

export interface JoinResult {
  participantId: string;
  role: 'worker';
  name: string;
  workspace: string;
  hint?: string;
}

export class WorkClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export function decodeToolResult<T>(result: unknown): T {
  const response = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  const text = response.content
    ?.find((item) => item.type === 'text' && typeof item.text === 'string')?.text;
  if (text === undefined) throw new WorkClientError('INVALID_RESPONSE', '工作域返回了非文本结果。');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WorkClientError('INVALID_RESPONSE', `工作域返回了无法解析的结果：${text.slice(0, 200)}`);
  }
  if (response.isError) {
    const error = value as { code?: unknown; message?: unknown; hint?: unknown };
    throw new WorkClientError(
      typeof error.code === 'string' ? error.code : 'TOOL_ERROR',
      typeof error.message === 'string' ? error.message : '工作域工具调用失败。',
      typeof error.hint === 'string' ? error.hint : undefined,
    );
  }
  return value as T;
}

/** Thin typed wrapper over the work domain's Streamable HTTP MCP endpoint. */
export class WorkClient {
  private readonly client = new Client({ name: 'arena-runner', version: '0.1.0' });
  private transport: StreamableHTTPClientTransport | undefined;

  constructor(
    private readonly serverUrl: string,
    private readonly name: string,
  ) {}

  async connect(): Promise<void> {
    const url = new URL('/work/mcp', this.serverUrl + '/');
    this.transport = new StreamableHTTPClientTransport(url);
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.client.close();
    this.transport = undefined;
  }

  async join(): Promise<JoinResult> {
    return this.call<JoinResult>('join_work', { role: 'worker', name: this.name });
  }

  async waitForWork(timeoutMs: number, signal?: AbortSignal): Promise<WorkWaitResult> {
    return this.call<WorkWaitResult>('wait_for_work', { timeoutMs }, timeoutMs + 5_000, signal);
  }

  async submitResult(
    taskId: string,
    round: number,
    claimId: string,
    result: AgentResult,
  ): Promise<WorkTask> {
    return this.call<WorkTask>('submit_work_result', { taskId, round, claimId, result });
  }

  async renewClaim(taskId: string, round: number, claimId: string): Promise<{ expiresAt: number }> {
    return this.call<{ expiresAt: number }>('renew_claim', { taskId, round, claimId });
  }

  async acknowledge(taskId: string, round: number): Promise<WorkTask> {
    return this.call<WorkTask>('ack_task_finished', { taskId, round });
  }

  /** The server's view of a task, without the hint the tool adds for agents. */
  async getTask(taskId: string): Promise<WorkTask> {
    const { hint: _hint, ...task } = await this.call<WorkTask & { hint?: string }>('get_task', { taskId });
    return task;
  }

  private async call<T>(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const options = {
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    };
    const result = await this.client.callTool({ name, arguments: args }, undefined, options);
    return decodeToolResult<T>(result);
  }
}
