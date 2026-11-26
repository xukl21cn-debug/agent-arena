import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunnerCommandCursor } from '@arena/shared';
import type { AgentResult } from './result.js';

/**
 * Where one task round stands for this runner.
 *
 * - `running`: started, no result yet;
 * - `submitting`: the result is ready and waiting for the server to take it;
 * - `submitted`: the server has the result;
 * - `failed`: the server kept rejecting the result;
 * - `interrupted`: the process died mid-run and the claim is gone;
 * - `abandoned`: a result can no longer be handed in under its claim.
 */
export type SessionStatus =
  | 'running'
  | 'submitting'
  | 'submitted'
  | 'failed'
  | 'interrupted'
  | 'abandoned';

/** A record that will not change again, so nothing waits on it. */
const SETTLED: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'submitted',
  'failed',
  'interrupted',
  'abandoned',
]);

/** Settled records kept for the record; everything still in play is always kept. */
const MAX_SETTLED_RECORDS = 100;

/** How long `save` keeps retrying a replace that Windows refused: attempts × pause. */
const RENAME_ATTEMPTS = 20;
const RENAME_PAUSE_MS = 50;
/** The pause itself; `Atomics.wait` is the only synchronous sleep Node offers. */
const RENAME_PAUSE = new Int32Array(new SharedArrayBuffer(4));

/** One task-round binding between a work claim and an agent session. */
export interface SessionRecord {
  taskId: string;
  round: number;
  claimId: string;
  sessionId?: string;
  status: SessionStatus;
  startedAt: number;
  updatedAt: number;
  /** The runner process that started, or most recently resumed, this record. */
  instanceId?: string;
  /** The result waiting for the server; present from `submitting` on. */
  result?: AgentResult;
  /** How many times the server answered a hand-in with a rejection. */
  rejections?: number;
  note?: string;
}

interface StateFile {
  version: 1;
  records: SessionRecord[];
  /** Highest runner-management command already consumed by this runner, and in which registry. */
  commandSeq?: number;
  commandEpoch?: string;
}

function keyOf(taskId: string, round: number): string {
  return `${taskId}:${round}`;
}

/**
 * Local task ↔ session binding store. It is deliberately a small JSON file:
 * the runner is a single-process local tool, and this is the evidence needed to
 * avoid launching the same round twice after a restart, and to hand in a result
 * the server could not take the first time.
 */
export class SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private commandSeq = 0;
  private commandEpoch: string | undefined;

  constructor(
    private readonly file: string,
    private readonly now = Date.now,
    /** Identifies this runner process in the records it starts. */
    readonly instanceId: string = randomUUID(),
  ) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StateFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error('unsupported state file shape');
      this.commandSeq = typeof parsed.commandSeq === 'number' && Number.isInteger(parsed.commandSeq) && parsed.commandSeq >= 0
        ? parsed.commandSeq : 0;
      this.commandEpoch = typeof parsed.commandEpoch === 'string' ? parsed.commandEpoch : undefined;
      for (const record of parsed.records) {
        if (typeof record?.taskId === 'string' && typeof record.round === 'number' && typeof record.claimId === 'string') {
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
    const settled = [...this.records.values()]
      .filter((record) => SETTLED.has(record.status))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const record of settled.slice(0, Math.max(0, settled.length - MAX_SETTLED_RECORDS))) {
      this.records.delete(keyOf(record.taskId, record.round));
    }
    mkdirSync(path.dirname(this.file), { recursive: true });
    const payload: StateFile = {
      version: 1,
      records: [...this.records.values()],
      ...(this.commandSeq === 0 && this.commandEpoch === undefined ? {} : { commandSeq: this.commandSeq }),
      ...(this.commandEpoch === undefined ? {} : { commandEpoch: this.commandEpoch }),
    };
    // Named for this process: two runner processes never write through one temp file.
    const temp = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(temp, 'w');
    try {
      writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Windows refuses to replace a file that something else has open for a
    // moment — an antivirus scan or the indexer reading what was just written.
    // Retry briefly rather than let a lost write surface as an error in
    // whichever loop happened to save.
    for (let attempt = 1; ; attempt += 1) {
      try {
        renameSync(temp, this.file);
        return;
      } catch (error) {
        if (attempt >= RENAME_ATTEMPTS) {
          rmSync(temp, { force: true });
          throw error;
        }
        Atomics.wait(RENAME_PAUSE, 0, 0, RENAME_PAUSE_MS);
      }
    }
  }

  /** Where this runner stopped reading registry commands, and in which registry. */
  commandCursor(): RunnerCommandCursor {
    return { seq: this.commandSeq, ...(this.commandEpoch === undefined ? {} : { epoch: this.commandEpoch }) };
  }

  setCommandCursor(cursor: RunnerCommandCursor): void {
    if (!Number.isInteger(cursor.seq)) return;
    // Empty long-polls return the same cursor; skip the write in that case.
    if (cursor.seq <= this.commandSeq && cursor.epoch === this.commandEpoch) return;
    this.commandSeq = cursor.seq;
    this.commandEpoch = cursor.epoch;
    this.save();
  }

  get(taskId: string, round: number): SessionRecord | undefined {
    return this.records.get(keyOf(taskId, round));
  }

  /**
   * Rounds another runner process left `running`: that process is gone, so
   * each one is either resumed here or marked interrupted once the server has
   * been asked what became of its claim. A record from before instance ids
   * existed counts as another process's.
   */
  orphans(): SessionRecord[] {
    return [...this.records.values()]
      .filter((record) => record.status === 'running' && record.instanceId !== this.instanceId)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Rounds whose result is ready and still waiting for the server. */
  pendingSubmissions(): SessionRecord[] {
    return [...this.records.values()].filter((record) => record.status === 'submitting');
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
   * Record the start of a round. Returns false when the same claim is already
   * in play, which is the guard against a duplicate launch. The one exception
   * is a `resume`: a round another process left `running` is taken over, keeping
   * its session and start time.
   */
  begin(input: Pick<SessionRecord, 'taskId' | 'round' | 'claimId'>, options: { resume?: boolean } = {}): boolean {
    const key = keyOf(input.taskId, input.round);
    const existing = this.records.get(key);
    if (existing?.claimId === input.claimId && !SETTLED.has(existing.status)) {
      const takeover = options.resume === true
        && existing.status === 'running'
        && existing.instanceId !== this.instanceId;
      if (!takeover) return false;
      existing.instanceId = this.instanceId;
      existing.updatedAt = this.now();
      this.save();
      return true;
    }
    const now = this.now();
    this.records.set(key, {
      ...input,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      instanceId: this.instanceId,
      // A later claim on the same round keeps the session the earlier attempt
      // used, so it is still there if this attempt is cut short as well.
      ...(existing?.sessionId === undefined ? {} : { sessionId: existing.sessionId }),
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

  /**
   * Keep a result on disk before the first hand-in attempt, so a crash or an
   * unreachable server cannot lose it.
   */
  setResult(taskId: string, round: number, result: AgentResult): SessionRecord | undefined {
    const record = this.records.get(keyOf(taskId, round));
    if (!record) return undefined;
    record.status = 'submitting';
    record.result = result;
    record.rejections = 0;
    record.updatedAt = this.now();
    this.save();
    return record;
  }

  /** The server answered this hand-in with a rejection; returns the new count. */
  countRejection(taskId: string, round: number): number {
    const record = this.records.get(keyOf(taskId, round));
    if (!record) return 0;
    record.rejections = (record.rejections ?? 0) + 1;
    record.updatedAt = this.now();
    this.save();
    return record.rejections;
  }

  markSubmitted(taskId: string, round: number, note?: string): void {
    this.mark(taskId, round, 'submitted', note);
  }

  markFailed(taskId: string, round: number, note?: string): void {
    this.mark(taskId, round, 'failed', note);
  }

  markInterrupted(taskId: string, round: number, note?: string): void {
    this.mark(taskId, round, 'interrupted', note);
  }

  markAbandoned(taskId: string, round: number, note?: string): void {
    this.mark(taskId, round, 'abandoned', note);
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
