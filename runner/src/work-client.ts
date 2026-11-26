import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

/**
 * The server no longer knows this session: it restarted, or dropped the
 * session. The SDK does not open a new one by itself, and on the dead session
 * every call keeps failing, `join_work` included. Checked by class: the SDK
 * leaves the error's `name` as "Error".
 */
export function sessionGone(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404;
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

interface CallOptions {
  timeout?: number;
  signal?: AbortSignal;
}

/** Thin typed wrapper over the work domain's Streamable HTTP MCP endpoint. */
export class WorkClient {
  private readonly client = new Client({ name: 'arena-runner', version: '0.1.0' });
  private transport: StreamableHTTPClientTransport | undefined;
  /** Bumped each time a new session replaces one the server forgot. */
  private generation = 0;
  private refreshing: Promise<void> | undefined;

  constructor(
    private readonly serverUrl: string,
    private readonly name: string,
    /** Called after a lost session was replaced and the worker rejoined. */
    private readonly onReconnect?: () => void,
  ) {}

  async connect(): Promise<void> {
    await this.open();
  }

  async close(): Promise<void> {
    await this.client.close();
    this.transport = undefined;
  }

  async join(): Promise<JoinResult> {
    return this.call<JoinResult>('join_work', { role: 'worker', name: this.name });
  }

  async waitForWork(timeoutMs: number, signal?: AbortSignal): Promise<WorkWaitResult> {
    return this.call<WorkWaitResult>('wait_for_work', { timeoutMs }, { timeout: timeoutMs + 5_000, signal });
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

  private async open(): Promise<void> {
    const url = new URL('/work/mcp', this.serverUrl + '/');
    this.transport = new StreamableHTTPClientTransport(url);
    await this.client.connect(this.transport);
  }

  /**
   * Replace a session the server no longer knows. The work domain binds the
   * worker identity to the MCP session, so the new session joins again under
   * the same name, which is how it gets its identity back. Calls that hit the
   * dead session together share this one reconnect.
   */
  private async refreshSession(): Promise<void> {
    this.refreshing ??= (async () => {
      await this.client.close().catch(() => undefined);
      await this.open();
      this.generation += 1;
      await this.request<JoinResult>('join_work', { role: 'worker', name: this.name }, {});
      this.onReconnect?.();
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async request<T>(name: string, args: Record<string, unknown>, options: CallOptions): Promise<T> {
    return decodeToolResult<T>(await this.client.callTool({ name, arguments: args }, undefined, options));
  }

  private async call<T>(name: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<T> {
    const generation = this.generation;
    try {
      return await this.request<T>(name, args, options);
    } catch (error) {
      if (options.signal?.aborted || !sessionGone(error)) throw error;
      // Another call that hit the same dead session may already have replaced it.
      if (this.generation === generation) await this.refreshSession();
      return this.request<T>(name, args, options);
    }
  }
}
