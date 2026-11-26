import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  // The indexed column is epoch ms, not the snapshot's ISO string.
  const row = database.db.prepare('SELECT updated_at FROM rooms WHERE id = ?').get('sqlite-room') as { updated_at: number };
  expect(row.updated_at).toBe(Date.parse(room.getState().updatedAt));
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

it('skips broken legacy records instead of failing the boot', () => {
  const legacy = new RoomManager({ repository: new FileRoomRepository(dir) });
  const good = legacy.create('good-room').toSnapshot();
  const archive = structuredClone(good);
  archive.state.gameId = 'g1';
  archive.history = [];
  legacy.repository.archive(archive);
  const rooms = path.join(dir, 'rooms');
  const archives = path.join(dir, 'archive');

  // No usable state.updatedAt...
  writeFileSync(path.join(rooms, 'broken-room.json'), JSON.stringify({ id: 'broken-room', state: {}, history: [], commentary: [] }));
  // ...parses but cannot be restored, so as a row it would fail every boot after this one...
  writeFileSync(path.join(rooms, 'no-history.json'), JSON.stringify({ id: 'no-history', state: good.state, commentary: [] }));
  // ...and the payload does not belong to this file name.
  writeFileSync(path.join(rooms, 'renamed.json'), JSON.stringify({ ...good, id: 'other-id' }));
  // A file name that is not a valid id used to throw inside the importer.
  writeFileSync(path.join(rooms, 'bad name.json'), '{}');
  writeFileSync(path.join(archives, 'no-id__g.json'), JSON.stringify({ state: {}, history: [], commentary: [] }));
  writeFileSync(path.join(archives, 'renamed__g.json'), JSON.stringify({ ...archive, state: { ...archive.state, gameId: 'g2' } }));

  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  const repository = new SqliteRoomRepository(database, { importFrom: dir });
  // Nothing else reached the database: a row that cannot be read back would be
  // logged on every boot. (`list()` alone would not show it — the reader skips
  // unreadable rows too.)
  expect(database.db.prepare('SELECT id FROM rooms ORDER BY id').all().map((row) => row.id)).toEqual(['good-room']);
  expect(database.db.prepare('SELECT archive_id FROM archives').all().map((row) => row.archive_id)).toEqual([
    'good-room__g1',
  ]);
  expect(repository.list().map((entry) => entry.roomId)).toEqual(['good-room']);
  expect(repository.listArchives().map((entry) => entry.archiveId)).toEqual(['good-room__g1']);
  // Everything that was imported can be restored: the next boot must not throw.
  expect(() => new RoomManager({ repository }).restoreAll()).not.toThrow();
  database.close();
});

it('never imports legacy JSON over live rows, even without the import marker', () => {
  const legacy = new RoomManager({ repository: new FileRoomRepository(dir) });
  const snapshot = legacy.create('stale-room').toSnapshot();
  // Older data under the same id stays on disk.
  writeFileSync(
    path.join(dir, 'rooms', 'stale-room.json'),
    JSON.stringify({ ...snapshot, state: { ...snapshot.state, version: 99 } }),
  );
  const file = path.join(dir, 'arena.db');

  const first = new ArenaDatabase(file);
  new RoomManager({ repository: new SqliteRoomRepository(first) }).create('stale-room');
  // A database written before the marker existed has rows but no marker.
  first.db.prepare('DELETE FROM meta').run();
  first.close();

  const second = new ArenaDatabase(file);
  const repository = new SqliteRoomRepository(second, { importFrom: dir });
  expect(repository.load('stale-room')?.state.version).not.toBe(99);
  expect(second.metaFlag('legacy_imported:rooms')).toBe(true);
  second.close();
});

it('does not create the legacy directories in SQLite mode', () => {
  // Legacy rooms on disk but no archive directory. The import has to read the
  // one that exists without conjuring up the one that was never there.
  const seed = path.join(dir, 'seed');
  const snapshot = new RoomManager({ repository: new FileRoomRepository(seed) }).create('legacy-room').toSnapshot();
  mkdirSync(path.join(dir, 'rooms'));
  writeFileSync(path.join(dir, 'rooms', 'legacy-room.json'), JSON.stringify(snapshot));

  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  const repository = new SqliteRoomRepository(database, { importFrom: dir });
  // It did read the legacy tree, so the directory check below is not vacuous.
  expect(repository.list().map((room) => room.roomId)).toEqual(['legacy-room']);
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
