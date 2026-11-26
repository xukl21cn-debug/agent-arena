import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ArenaDatabase } from '../src/db/database.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-sqlite-migration-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('refuses a database written by a newer build', () => {
  const file = path.join(dir, 'arena.db');
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations(version, applied_at) VALUES (99, 0);
  `);
  raw.close();

  // Writing into a schema we do not understand fails later, mid-request, with
  // "no such table"; refusing at boot says what actually happened.
  expect(() => new ArenaDatabase(file)).toThrow(/schema 版本/);
});

it('names the file when it exists but is not a database', () => {
  const file = path.join(dir, 'arena.db');
  writeFileSync(file, 'x');
  // The driver only says "file is not a database"; with ARENA_DB_PATH the
  // user would not know which file to fix.
  expect(() => new ArenaDatabase(file)).toThrow(/not a database/);
  expect(() => new ArenaDatabase(file)).toThrow(file);
});

it('upgrades a v3 database: adds the meta table and moves timestamps to epoch ms', () => {
  const file = path.join(dir, 'arena.db');
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations(version, applied_at) VALUES (1, 0), (2, 0), (3, 0);
    CREATE TABLE rooms (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE archives (archive_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, played_at INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE chat_rooms (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE work_tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL);
    INSERT INTO rooms VALUES ('r1', '{"id":"r1"}', '2026-11-20T08:18:30.692Z');
    INSERT INTO chat_rooms VALUES ('c1', '{"id":"c1"}', '2026-11-23T14:58:03.425Z');
  `);
  raw.close();

  const database = new ArenaDatabase(file);
  const room = database.db.prepare('SELECT updated_at FROM rooms WHERE id = ?').get('r1') as { updated_at: number };
  expect(room.updated_at).toBe(Date.parse('2026-11-20T08:18:30.692Z'));
  const chat = database.db.prepare('SELECT updated_at FROM chat_rooms WHERE id = ?').get('c1') as { updated_at: number };
  expect(chat.updated_at).toBe(Date.parse('2026-11-23T14:58:03.425Z'));

  expect(database.metaFlag('probe')).toBe(false);
  database.setMetaFlag('probe');
  expect(database.metaFlag('probe')).toBe(true);
  database.close();
});

it('keeps transactions working after BEGIN fails', () => {
  const file = path.join(dir, 'arena.db');
  const holder = new ArenaDatabase(file);
  const other = new ArenaDatabase(file);
  other.db.exec('PRAGMA busy_timeout = 0');

  // Another process holding the write lock makes BEGIN IMMEDIATE throw.
  holder.db.exec('BEGIN IMMEDIATE');
  expect(() => other.transaction(() => undefined)).toThrow();
  holder.db.exec('ROLLBACK');

  // If the failed BEGIN had leaked the depth counter, this transaction would
  // skip BEGIN entirely and the thrown error would leave the table behind.
  expect(() =>
    other.transaction(() => {
      other.db.exec('CREATE TABLE probe(x)');
      throw new Error('boom');
    }),
  ).toThrow('boom');
  expect(() => other.db.prepare('SELECT * FROM probe').all()).toThrow();

  // ...and the next transaction still opens one.
  other.transaction(() => {
    other.db.exec('CREATE TABLE probe2(x)');
  });
  expect(() => other.db.prepare('SELECT * FROM probe2').all()).not.toThrow();

  holder.close();
  other.close();
});
