import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ArenaDatabase } from '../src/db/database.js';
import { SqliteRoomRepository } from '../src/game/rooms/sqlite-repository.js';
import { FileRoomRepository } from '../src/game/rooms/repository.js';
import { RoomManager } from '../src/game/rooms/room-manager.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-sqlite-rooms-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('persists rooms and restores them from SQLite', () => {
  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  const repository = new SqliteRoomRepository(database);
  const manager = new RoomManager({ repository });
  const room = manager.create('sqlite-room');
  expect(room.id).toBe('sqlite-room');
  database.close();

  const reopened = new ArenaDatabase(path.join(dir, 'arena.db'));
  const restored = new RoomManager({ repository: new SqliteRoomRepository(reopened) });
  restored.restoreAll();
  expect(restored.get('sqlite-room')).toBeDefined();
  expect(restored.list()).toMatchObject([{ roomId: 'sqlite-room' }]);
  reopened.close();
});

it('archives and prunes per room in SQLite', () => {
  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  const repository = new SqliteRoomRepository(database, { archiveLimit: 1 });
  const manager = new RoomManager({ repository });
  const room = manager.create('archive-room');
  const persisted = room.toSnapshot();
  repository.archive(persisted);
  expect(repository.listArchives()).toHaveLength(1);

  const second = structuredClone(persisted);
  second.state.gameId = 'second-game';
  second.state.updatedAt = persisted.state.updatedAt + 1_000;
  second.history = [];
  repository.archive(second);
  expect(repository.listArchives()).toHaveLength(1);
  expect(repository.listArchives()[0]).toMatchObject({ roomId: 'archive-room', gameId: 'second-game' });
  database.close();
});

it('imports legacy JSON rooms once when the database is empty', () => {
  const legacyRepository = new FileRoomRepository(dir);
  const legacy = new RoomManager({ repository: legacyRepository });
  legacy.create('legacy-room');

  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  const repository = new SqliteRoomRepository(database, { importFrom: dir });
  expect(repository.list().map((room) => room.roomId)).toContain('legacy-room');
  database.close();

  const reopened = new ArenaDatabase(path.join(dir, 'arena.db'));
  const repositoryAgain = new SqliteRoomRepository(reopened, { importFrom: dir });
  expect(repositoryAgain.list().map((room) => room.roomId)).toEqual(['legacy-room']);
  reopened.close();
});
