import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ArenaDatabase } from '../src/db/database.js';
import { ChatManager } from '../src/chat/manager.js';
import { SqliteChatStore } from '../src/chat/store.js';
import { SqliteRoomRepository } from '../src/game/rooms/sqlite-repository.js';
import { RoomManager } from '../src/game/rooms/room-manager.js';
import { WorkStore } from '../src/work/store.js';
import { SqliteWorkTaskStore } from '../src/work/sqlite-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-sqlite-corrupt-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Rows no writer produces: a truncated write, a bare `null`, a non-object. */
const BAD_PAYLOADS = ['{"id":"x","state":', 'null', '"just a string"'];

it('skips corrupt room and archive rows instead of failing the boot', () => {
  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  const repository = new SqliteRoomRepository(database);
  const room = new RoomManager({ repository }).create('good-room');
  const archive = structuredClone(room.toSnapshot());
  archive.state.gameId = 'g1';
  archive.history = [];
  repository.archive(archive);
  const badRoom = database.db.prepare('INSERT INTO rooms(id, payload, updated_at) VALUES (?, ?, ?)');
  const badArchive = database.db.prepare(
    'INSERT INTO archives(archive_id, room_id, played_at, payload) VALUES (?, ?, ?, ?)',
  );
  BAD_PAYLOADS.forEach((payload, index) => {
    badRoom.run(`bad-${index}`, payload, 1);
    badArchive.run(`good-room__bad${index}`, 'good-room', 1, payload);
  });
  // Intact snapshots stored under another key, or under an id no room may have:
  // loaded naively, the first would come back as a ghost room and the second
  // would make `restoreAll` throw when it creates a room under that id.
  badRoom.run('renamed', JSON.stringify(room.toSnapshot()), 1);
  badRoom.run('bad id!', JSON.stringify({ ...room.toSnapshot(), id: 'bad id!' }), 1);
  badArchive.run('good-room__other', 'good-room', 1, JSON.stringify(archive));

  expect(repository.list().map((entry) => entry.roomId)).toEqual(['good-room']);
  expect(repository.listArchives().map((entry) => entry.archiveId)).toEqual(['good-room__g1']);
  expect(repository.load('bad-0')).toBeNull();
  expect(repository.load('renamed')).toBeNull();
  expect(repository.loadArchive('good-room__bad0')).toBeNull();
  // The next boot must come up on these rows.
  expect(() => new RoomManager({ repository }).restoreAll()).not.toThrow();
  database.close();
});

it('skips corrupt chat rows and still restores the healthy rooms', () => {
  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  const store = new SqliteChatStore(database);
  new ChatManager(dir, store).create('good-chat');
  const insert = database.db.prepare('INSERT INTO chat_rooms(id, payload, updated_at) VALUES (?, ?, ?)');
  BAD_PAYLOADS.forEach((payload, index) => insert.run(`bad-${index}`, payload, 1));
  expect(store.loadAll().map((entry) => entry.roomId)).toEqual(['good-chat']);
  expect(store.load('bad-0')).toBeNull();

  // Parses, but is not a room: the restore path has to reject it as well.
  insert.run('ghost', '{"id":"ghost"}', 1);
  const restored = new ChatManager(dir, store);
  expect(() => restored.restoreAll()).not.toThrow();
  expect(restored.list().map((entry) => entry.id)).toEqual(['good-chat']);
  database.close();
});

it('skips corrupt work task rows', () => {
  writeFileSync(path.join(dir, 'brief.md'), '# Scope');
  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  const store = new SqliteWorkTaskStore(database);
  const work = new WorkStore(dir, dir, 60_000, undefined, store);
  const coordinator = work.join('coordinator', 'coordinator', 'coordinator-session');
  work.join('worker', 'runner', 'worker-session');
  const task = work.create(coordinator, {
    requestId: 'corrupt-1',
    title: 'Kept',
    requirement: 'Survives',
    branch: 'feat/probe',
    base: 'a'.repeat(40),
    acceptance: ['Kept'],
    docs: [{ kind: 'brief', path: 'brief.md', summary: 'Scope' }],
  });
  const insert = database.db.prepare('INSERT INTO work_tasks(id, status, updated_at, payload) VALUES (?, ?, ?, ?)');
  BAD_PAYLOADS.forEach((payload, index) => insert.run(`bad-${index}`, 'queued', 1, payload));

  expect(store.loadAll().map((entry) => entry.id)).toEqual([task.id]);
  // A store built over the same rows comes up with the healthy task only.
  expect(new WorkStore(dir, dir, 60_000, undefined, store).list().map((entry) => entry.id)).toEqual([task.id]);
  database.close();
});
