import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Small SQLite wrapper shared by the server repositories. It owns schema
 * versioning, PRAGMAs and the transaction helper; domain repositories own
 * their tables and payload shapes.
 */
export class ArenaDatabase {
  readonly db: DatabaseSync;

  constructor(readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
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
  }
}
