import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  second.state.updatedAt = new Date(Date.parse(persisted.state.updatedAt) + 1_000).toISOString();
  second.history = [];
  repository.archive(second);
  expect(repository.listArchives()).toHaveLength(1);
  expect(repository.listArchives()[0]).toMatchObject({ roomId: 'archive-room', gameId: 'second-game' });
  database.close();
});

it('prunes archives per room instead of globally', () => {
  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  const repository = new SqliteRoomRepository(database, { archiveLimit: 1 });
  const manager = new RoomManager({ repository });
  for (const roomId of ['room-a', 'room-b']) {
    const room = manager.create(roomId);
    const persisted = room.toSnapshot();
    for (const [gameId, offset] of [['g1', 1_000], ['g2', 2_000]] as const) {
      const copy = structuredClone(persisted);
      copy.state.gameId = gameId;
      copy.state.updatedAt = new Date(Date.parse(persisted.state.updatedAt) + offset).toISOString();
      copy.history = [];
      repository.archive(copy);
    }
  }
  // One archive each: pruning room-b must not have evicted room-a's history.
  expect(repository.listArchives().map((entry) => entry.roomId).sort()).toEqual(['room-a', 'room-b']);
  database.close();
});

it('skips broken legacy records instead of failing the import', () => {
  const legacy = new RoomManager({ repository: new FileRoomRepository(dir) });
  legacy.create('good-room');
  // A payload without a usable state.updatedAt cannot be bound to the row...
  writeFileSync(
    path.join(dir, 'rooms', 'broken-room.json'),
    JSON.stringify({ id: 'broken-room', state: {}, history: [], commentary: [] }),
  );
  // ...and this name is not a valid id, which used to throw inside the importer.
  writeFileSync(path.join(dir, 'rooms', 'bad name.json'), '{}');

  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  const repository = new SqliteRoomRepository(database, { importFrom: dir });
  expect(repository.list().map((room) => room.roomId)).toEqual(['good-room']);
  database.close();
});

it('does not create the legacy directories in SQLite mode', () => {
  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  new SqliteRoomRepository(database, { importFrom: dir });
  expect(existsSync(path.join(dir, 'rooms'))).toBe(false);
  expect(existsSync(path.join(dir, 'archive'))).toBe(false);
  database.close();
});

it('does not resurrect a deleted room from the legacy JSON on the next boot', () => {
  const legacy = new RoomManager({ repository: new FileRoomRepository(dir) });
  legacy.create('legacy-room');
  const file = path.join(dir, 'arena.db');

  const first = new ArenaDatabase(file);
  const repository = new SqliteRoomRepository(first, { importFrom: dir });
  expect(repository.list().map((room) => room.roomId)).toEqual(['legacy-room']);
  repository.delete('legacy-room');
  expect(repository.list()).toEqual([]);
  first.close();

  // The table is empty again, but the import already ran: the marker, not the
  // row count, decides.
  const second = new ArenaDatabase(file);
  expect(new SqliteRoomRepository(second, { importFrom: dir }).list()).toEqual([]);
  second.close();
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
