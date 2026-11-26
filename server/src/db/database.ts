import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Schema version this build understands. A file written by a newer build is
 * refused instead of being written to blindly: after a rollback the old code
 * would otherwise fail later with `no such table` in the middle of a request.
 */
const CURRENT_SCHEMA = 4;

/**
 * Small SQLite wrapper shared by the server repositories. It owns schema
 * versioning, PRAGMAs, one-shot migration flags and the transaction helper;
 * domain repositories own their tables and payload shapes.
 */
export class ArenaDatabase {
  readonly db: DatabaseSync;

  constructor(readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.db = new DatabaseSync(file);
    } catch (error) {
      // The bare driver message ("unable to open database file") never says
      // which file, which is the only thing the user needs to know.
      throw new Error(
        `[arena] 无法打开数据库 ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    try {
      this.migrate();
    } catch (error) {
      // A refused or failed migration must not keep the file locked for the
      // rest of the process (on Windows that also blocks deleting it).
      try {
        this.db.close();
      } catch {
        /* the original error matters more */
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * 1 while a transaction is open, 0 otherwise. Nested calls run inside the
   * outer transaction instead of opening a second one. It must return to 0
   * even when `BEGIN` itself fails (busy, disk full), otherwise every later
   * `transaction()` would hit the guard, skip `BEGIN`, and silently write
   * without atomicity for the rest of the process.
   */
  private transactionDepth = 0;

  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.transactionDepth = 1;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* keep the original error */
        }
        throw error;
      }
    } finally {
      this.transactionDepth = 0;
    }
  }

  /**
   * One-shot migration markers. "The table is empty" is not a safe guard: a
   * user deleting the last room would empty it again, and the next boot would
   * import the legacy JSON back, resurrecting what was just deleted.
   */
  metaFlag(key: string): boolean {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    return row?.value === '1';
  }

  setMetaFlag(key: string): void {
    this.db.prepare(
      'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, '1');
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const row = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
      | { version?: number | null }
      | undefined;
    const version = row?.version ?? 0;
    if (version > CURRENT_SCHEMA) {
      throw new Error(
        `[arena] 数据库 ${this.file} 的 schema 版本是 ${version}，高于本程序支持的 ${CURRENT_SCHEMA}；请升级服务端，或换回该版本之前的备份`,
      );
    }
    if (version < 1) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS rooms (
            id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS archives (
            archive_id TEXT PRIMARY KEY,
            room_id TEXT NOT NULL,
            played_at INTEGER NOT NULL,
            payload TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS archives_played_at ON archives(played_at DESC);
        `);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(1, Date.now());
      });
    }
    if (version < 2) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS chat_rooms (
            id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS chat_rooms_updated_at ON chat_rooms(updated_at DESC);
        `);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(2, Date.now());
      });
    }
    if (version < 3) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS work_tasks (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            payload TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS work_tasks_status ON work_tasks(status, updated_at DESC);
        `);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(3, Date.now());
      });
    }
    if (version < 4) {
      this.transaction(() => {
        // v4: one-shot import markers, and every timestamp column in epoch ms.
        // `rooms.updated_at` was declared INTEGER but received the domain's ISO
        // string, and `chat_rooms.updated_at` was declared TEXT; both are
        // rewritten so one kind of timestamp means one storage class.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );

          CREATE TABLE chat_rooms_v4 (
            id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
          INSERT INTO chat_rooms_v4(id, payload, updated_at)
            SELECT id, payload, updated_at FROM chat_rooms;
          DROP TABLE chat_rooms;
          ALTER TABLE chat_rooms_v4 RENAME TO chat_rooms;
          CREATE INDEX IF NOT EXISTS chat_rooms_updated_at ON chat_rooms(updated_at DESC);
        `);
        this.normalizeTimestamps('rooms');
        this.normalizeTimestamps('chat_rooms');
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(4, Date.now());
      });
    }
  }

  /**
   * Turn ISO strings left by earlier builds into epoch milliseconds. Done in
   * JS rather than SQL: `strftime('%s', …)` truncates to whole seconds, which
   * would silently shave the milliseconds off every stored timestamp.
   */
  private normalizeTimestamps(table: 'rooms' | 'chat_rooms'): void {
    const rows = this.db
      .prepare(`SELECT rowid AS id, updated_at AS value FROM ${table} WHERE typeof(updated_at) = 'text'`)
      .all() as Array<{ id: number; value: string }>;
    if (rows.length === 0) return;
    const update = this.db.prepare(`UPDATE ${table} SET updated_at = ? WHERE rowid = ?`);
    for (const row of rows) {
      const parsed = Date.parse(row.value);
      update.run(Number.isFinite(parsed) ? parsed : Date.now(), row.id);
    }
  }
}
