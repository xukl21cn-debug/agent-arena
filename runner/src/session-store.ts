import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type SessionStatus = 'running' | 'submitted' | 'failed';

/** One task-round binding between a work claim and an agent session. */
export interface SessionRecord {
  taskId: string;
  round: number;
  claimId: string;
  sessionId?: string;
  status: SessionStatus;
  startedAt: number;
  updatedAt: number;
  note?: string;
}

interface StateFile {
  version: 1;
  records: SessionRecord[];
}

function keyOf(taskId: string, round: number): string {
  return `${taskId}:${round}`;
}

/**
 * Local task ↔ session binding store. It is deliberately a small JSON file:
 * the runner is a single-process local tool, and this is the evidence needed to
 * avoid launching the same round twice after a restart.
 */
export class SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  constructor(
    private readonly file: string,
    private readonly now = Date.now,
  ) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StateFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error('unsupported state file shape');
      for (const record of parsed.records) {
        if (typeof record.taskId === 'string' && typeof record.round === 'number') {
          this.records.set(keyOf(record.taskId, record.round), record);
        }
      }
    } catch (error) {
      // A corrupt local state file must not prevent the runner from starting.
      // Keep the broken file as evidence instead of letting the next save
      // overwrite it, then continue with an empty in-memory map.
      const backup = `${this.file}.corrupt-${this.now()}`;
      try {
        renameSync(this.file, backup);
        console.warn(`[runner] moved corrupt session state ${this.file} to ${backup}:`, error instanceof Error ? error.message : error);
      } catch (renameError) {
        console.warn(`[runner] ignoring corrupt session state ${this.file}:`, renameError instanceof Error ? renameError.message : renameError);
      }
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const payload: StateFile = { version: 1, records: [...this.records.values()] };
    const temp = `${this.file}.tmp`;
    const fd = openSync(temp, 'w');
    try {
      writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.file);
  }

  get(taskId: string, round: number): SessionRecord | undefined {
    return this.records.get(keyOf(taskId, round));
  }

  /** The latest DSH session seen for a task, used to continue its rework round. */
  latestSessionForTask(taskId: string): string | undefined {
    let found: SessionRecord | undefined;
    for (const record of this.records.values()) {
      if (record.taskId !== taskId || record.sessionId === undefined) continue;
      if (found === undefined || record.round > found.round) found = record;
    }
    return found?.sessionId;
  }

  /**
   * Record the start of a round. Returns false when the same claim was already
   * started, which is the guard against a duplicate launch after a restart.
   */
  begin(input: Pick<SessionRecord, 'taskId' | 'round' | 'claimId'>): boolean {
    const key = keyOf(input.taskId, input.round);
    const existing = this.records.get(key);
    if (existing?.claimId === input.claimId && existing.status !== 'failed') return false;
    const now = this.now();
    this.records.set(key, {
      ...input,
      status: 'running',
      startedAt: now,
      updatedAt: now,
    });
    this.save();
    return true;
  }

  setSessionId(taskId: string, round: number, sessionId: string): void {
    const record = this.records.get(keyOf(taskId, round));
    if (!record) return;
    record.sessionId = sessionId;
    record.updatedAt = this.now();
    this.save();
  }

  markSubmitted(taskId: string, round: number, note?: string): void {
    this.mark(taskId, round, 'submitted', note);
  }

  markFailed(taskId: string, round: number, note?: string): void {
    this.mark(taskId, round, 'failed', note);
  }

  private mark(taskId: string, round: number, status: SessionStatus, note?: string): void {
    const record = this.records.get(keyOf(taskId, round));
    if (!record) return;
    record.status = status;
    record.updatedAt = this.now();
    if (note !== undefined) record.note = note.slice(0, 2000);
    this.save();
  }
}
