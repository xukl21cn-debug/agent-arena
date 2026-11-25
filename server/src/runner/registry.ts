import type {
  RunnerCommand,
  RunnerCommandBatch,
  RunnerCommandKind,
  RunnerDetail,
  RunnerEvent,
  RunnerEventInput,
  RunnerHeartbeatRequest,
  RunnerRegisterRequest,
  RunnerStatus,
  RunnerSummary,
  RunnerTaskRef,
} from '@arena/shared';

export type RunnerErrorCode = 'RUNNER_NOT_FOUND' | 'INVALID_REQUEST';

export class RunnerError extends Error {
  constructor(readonly code: RunnerErrorCode, message: string) {
    super(message);
  }
}

interface RunnerRecord {
  id: string;
  name: string;
  workspace: string;
  version: string;
  registeredAt: number;
  lastSeenAt: number;
  lastStatus: RunnerStatus;
  currentTask: RunnerTaskRef | null;
  events: RunnerEvent[];
  nextEventSeq: number;
  commands: RunnerCommand[];
  nextCommandSeq: number;
  waiters: Set<() => void>;
}

const MAX_EVENTS = 100;
const MAX_ID = 64;

const statusOf = (record: RunnerRecord, now: number, ttlMs: number): RunnerStatus =>
  now - record.lastSeenAt <= ttlMs ? 'online' : 'offline';

/**
 * In-memory registry for local runner processes. It is deliberately not a
 * durable store: runner fleet state is observation data, while work tasks and
 * their evidence remain in WorkStore. A server restart clears presence and
 * command queues, matching the fact that the runner's MCP session is gone too.
 */
export class RunnerRegistry {
  private readonly records = new Map<string, RunnerRecord>();
  private readonly listeners = new Set<(runner: RunnerDetail) => void>();

  constructor(
    private readonly ttlMs = 15_000,
    private readonly now = Date.now,
  ) {}

  register(input: RunnerRegisterRequest): RunnerSummary {
    this.validateId(input.id);
    if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > 64) {
      throw new RunnerError('INVALID_REQUEST', 'runner name must be 1-64 characters.');
    }
    const timestamp = this.now();
    let record = this.records.get(input.id);
    if (record === undefined) {
      record = {
        id: input.id,
        name: input.name.trim(),
        workspace: input.workspace,
        version: input.version,
        registeredAt: timestamp,
        lastSeenAt: timestamp,
        lastStatus: 'online',
        currentTask: null,
        events: [],
        nextEventSeq: 1,
        commands: [],
        nextCommandSeq: 1,
        waiters: new Set(),
      };
      this.records.set(record.id, record);
    } else {
      record.name = input.name.trim();
      record.workspace = input.workspace;
      record.version = input.version;
      record.lastSeenAt = timestamp;
      record.lastStatus = 'online';
    }
    this.notify(record);
    return this.summaryOf(record);
  }

  heartbeat(id: string, input: RunnerHeartbeatRequest = {}): RunnerDetail {
    const record = this.require(id);
    record.lastSeenAt = this.now();
    record.lastStatus = 'online';
    if (input.currentTask !== undefined) record.currentTask = input.currentTask;
    this.notify(record);
    return this.detailOf(record);
  }

  event(id: string, input: RunnerEventInput): RunnerEvent {
    const record = this.require(id);
    record.lastSeenAt = this.now();
    record.lastStatus = 'online';
    const event: RunnerEvent = {
      seq: record.nextEventSeq++,
      at: this.now(),
      level: input.level,
      message: input.message,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    };
    record.events.push(event);
    if (record.events.length > MAX_EVENTS) record.events.splice(0, record.events.length - MAX_EVENTS);
    this.notify(record);
    return event;
  }

  enqueue(id: string, kind: RunnerCommandKind, taskId?: string): RunnerCommand {
    const record = this.require(id);
    const command: RunnerCommand = {
      seq: record.nextCommandSeq++,
      kind,
      requestedAt: this.now(),
      ...(taskId === undefined ? {} : { taskId }),
    };
    record.commands.push(command);
    for (const wake of [...record.waiters]) wake();
    this.notify(record);
    return command;
  }

  async waitForCommands(
    id: string,
    afterSeq: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RunnerCommandBatch> {
    const record = this.require(id);
    const wasOffline = record.lastStatus === 'offline';
    record.lastSeenAt = this.now();
    record.lastStatus = 'online';
    if (wasOffline) this.notify(record);
    // A runner may have persisted a cursor from a previous server process.
    // A fresh registry has no command with that sequence, so start over rather
    // than waiting forever for seq 7 when this process only has seq 1.
    const effectiveAfterSeq = afterSeq > record.nextCommandSeq - 1 ? 0 : afterSeq;
    const drain = (): RunnerCommandBatch | undefined => {
      const commands = record.commands.filter((command) => command.seq > effectiveAfterSeq);
      if (commands.length === 0) return undefined;
      return { commands, nextSeq: commands.at(-1)?.seq ?? effectiveAfterSeq };
    };
    const immediate = drain();
    if (immediate) return immediate;
    if (signal?.aborted) return { commands: [], nextSeq: effectiveAfterSeq };

    return new Promise<RunnerCommandBatch>((resolve) => {
      let settled = false;
      const finish = (batch: RunnerCommandBatch): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.waiters.delete(wake);
        signal?.removeEventListener('abort', onAbort);
        resolve(batch);
      };
      const wake = (): void => {
        const batch = drain();
        if (batch) finish(batch);
      };
      const onAbort = (): void => finish({ commands: [], nextSeq: effectiveAfterSeq });
      const timer = setTimeout(() => finish({ commands: [], nextSeq: effectiveAfterSeq }), timeoutMs);
      record.waiters.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  list(): RunnerSummary[] {
    return [...this.records.values()]
      .sort((a, b) => a.registeredAt - b.registeredAt || a.id.localeCompare(b.id))
      .map((record) => this.summaryOf(record));
  }

  get(id: string): RunnerDetail | undefined {
    const record = this.records.get(id);
    return record === undefined ? undefined : this.detailOf(record);
  }

  subscribe(listener: (runner: RunnerDetail) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Mark runners that stopped heartbeating as offline and notify observers once. */
  sweep(): void {
    const now = this.now();
    for (const record of this.records.values()) {
      const status = statusOf(record, now, this.ttlMs);
      if (status === record.lastStatus) continue;
      record.lastStatus = status;
      this.notify(record);
    }
  }

  private require(id: string): RunnerRecord {
    const record = this.records.get(id);
    if (record === undefined) throw new RunnerError('RUNNER_NOT_FOUND', '找不到该 runner。');
    return record;
  }

  private validateId(id: string): void {
    if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(id)) {
      throw new RunnerError('INVALID_REQUEST', 'runner id must match [a-zA-Z0-9_-]{1,64}.');
    }
  }

  private summaryOf(record: RunnerRecord): RunnerSummary {
    const status = statusOf(record, this.now(), this.ttlMs);
    return {
      id: record.id,
      name: record.name,
      status,
      workspace: record.workspace,
      version: record.version,
      registeredAt: record.registeredAt,
      lastSeenAt: record.lastSeenAt,
      currentTask: record.currentTask,
      ...(record.events.length === 0 ? {} : { lastEvent: record.events.at(-1) }),
    };
  }

  private detailOf(record: RunnerRecord): RunnerDetail {
    return {
      ...this.summaryOf(record),
      events: [...record.events].slice(-MAX_EVENTS),
    };
  }

  private notify(record: RunnerRecord): void {
    if (this.listeners.size === 0) return;
    const detail = this.detailOf(record);
    for (const listener of this.listeners) {
      try { listener(detail); }
      catch (error) { console.error('[runner] subscriber failed', error); }
    }
  }
}
