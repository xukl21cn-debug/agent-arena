import type {
  RunnerCommandBatch,
  RunnerCommandKind,
  RunnerEventLevel,
  RunnerSummary,
  RunnerTaskRef,
} from '@arena/shared';

export class RunnerManagementError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** HTTP client for the server's runner registry; separate from the work MCP client. */
export class RunnerManagementClient {
  constructor(
    private readonly serverUrl: string,
    private readonly id: string,
    private readonly name: string,
    private readonly workspace: string,
    private readonly version = '0.1.0',
  ) {}

  async register(): Promise<RunnerSummary> {
    return this.request<RunnerSummary>('/api/runners/register', {
      method: 'POST',
      body: JSON.stringify({
        id: this.id,
        name: this.name,
        workspace: this.workspace,
        version: this.version,
      }),
    });
  }

  async heartbeat(currentTask: RunnerTaskRef | null): Promise<void> {
    await this.request(`/api/runners/${encodeURIComponent(this.id)}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({ currentTask }),
    });
  }

  async event(level: RunnerEventLevel, message: string, taskId?: string): Promise<void> {
    await this.request(`/api/runners/${encodeURIComponent(this.id)}/events`, {
      method: 'POST',
      body: JSON.stringify({ level, message, ...(taskId === undefined ? {} : { taskId }) }),
    });
  }

  async pollCommands(afterSeq: number, timeoutMs: number, signal?: AbortSignal): Promise<RunnerCommandBatch> {
    const query = new URLSearchParams({
      afterSeq: String(afterSeq),
      timeoutMs: String(timeoutMs),
    });
    return this.request(`/api/runners/${encodeURIComponent(this.id)}/commands?${query.toString()}`, {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** Page-side command enqueue; runner itself normally only polls. */
  async command(kind: RunnerCommandKind, taskId?: string): Promise<void> {
    await this.request(`/api/runners/${encodeURIComponent(this.id)}/commands`, {
      method: 'POST',
      body: JSON.stringify({ kind, ...(taskId === undefined ? {} : { taskId }) }),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      if (init.body !== undefined) headers.set('content-type', 'application/json');
      response = await fetch(new URL(path, this.serverUrl + '/'), { ...init, headers });
    } catch (error) {
      throw new RunnerManagementError('NETWORK_ERROR', `连不上 runner 管理接口：${error instanceof Error ? error.message : String(error)}`);
    }
    let payload: unknown = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      const error = payload as { error?: { code?: string; message?: string } } | null;
      throw new RunnerManagementError(
        error?.error?.code ?? 'HTTP_ERROR',
        error?.error?.message ?? `Runner 管理请求失败 (HTTP ${response.status})。`,
      );
    }
    return payload as T;
  }
}
