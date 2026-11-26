import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { ArchiveSummary, RoomSummary } from '@arena/shared';
import { ROOM_ID_PATTERN } from '@arena/shared';
import { ArenaDatabase } from '../../db/database.js';
import { RoomError, type GameRoom } from './room.js';
import {
  ARCHIVE_ID_PATTERN,
  DEFAULT_ARCHIVE_LIMIT,
  FileRoomRepository,
  archiveSummaryOf,
  migrateSnapshot,
  summarize,
  type PersistedRoom,
  type RepositoryOptions,
  type RoomRepository,
} from './repository.js';

export interface SqliteRoomRepositoryOptions extends RepositoryOptions {
  /** When set, import the legacy rooms/archive JSON files unless that already happened. */
  importFrom?: string;
}

/** One-shot import marker; see `ArenaDatabase.metaFlag`. */
const LEGACY_IMPORTED_FLAG = 'legacy_imported:rooms';

/** A row as the reader sees it: the key it is stored under plus the JSON snapshot. */
interface KeyedRow {
  id: string;
  payload: string;
}

/**
 * Ids of the `*.json` files in a legacy directory. Names that cannot be a
 * valid id are skipped with a warning: `FileRoomRepository` builds paths from
 * ids and throws on the first bad one, and a single stray file used to abort
 * the whole import (and with it, the boot).
 */
function legacyIdsIn(directory: string, pattern: RegExp, label: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.endsWith('.json.tmp')) continue;
    const id = entry.slice(0, -'.json'.length);
    if (pattern.test(id)) {
      ids.push(id);
      continue;
    }
    console.warn(`[sqlite-repository] skipping legacy ${label} file ${entry}: name is not a valid id`);
  }
  return ids;
}

/**
 * Everything `GameRoom` needs to restore a snapshot: it copies `history` and
 * `commentary` with spread, and `migrateSnapshot` reads `state`, so a row
 * without them would throw on every boot. Strict comparisons on purpose —
 * `ROOM_ID_PATTERN.test(undefined)` matches the string "undefined".
 */
function isRestorableRoom(persisted: unknown): persisted is PersistedRoom {
  if (typeof persisted !== 'object' || persisted === null) return false;
  const room = persisted as Partial<PersistedRoom>;
  return (
    typeof room.id === 'string' &&
    typeof room.state?.updatedAt === 'string' &&
    Array.isArray(room.history) &&
    Array.isArray(room.commentary)
  );
}

/** A room row is keyed by the snapshot's own id, and `restoreAll` creates a room under it, so it must be a valid one. */
const roomKey = (room: PersistedRoom): string => (ROOM_ID_PATTERN.test(room.id) ? room.id : '');

/** An archive row is keyed by the id `archive()` derives from the payload. */
const archiveKey = (room: PersistedRoom): string => archiveSummaryOf(room).archiveId;

/**
 * Read one row. A row the app could not have written — unparsable, not a room
 * snapshot, or stored under another id — is logged and skipped, never thrown:
 * a throw from here is a failed boot, on every start, until someone edits the
 * database by hand.
 */
function parseRoom(
  row: KeyedRow | undefined,
  label: string,
  keyOf: (room: PersistedRoom) => string,
): PersistedRoom | null {
  if (row === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch (error) {
    console.error(`[sqlite-repository] skipping corrupt ${label}:`, error instanceof Error ? error.message : error);
    return null;
  }
  if (!isRestorableRoom(parsed) || keyOf(parsed) !== row.id) {
    console.error(`[sqlite-repository] skipping corrupt ${label}: not a room snapshot written under this id`);
    return null;
  }
  return migrateSnapshot(parsed);
}

/**
 * SQLite-backed room repository. Domain code still sees PersistedRoom; the
 * payload stays JSON while id/updated_at/played_at are indexed columns.
 */
export class SqliteRoomRepository implements RoomRepository {
  private readonly archiveLimit: number;

  constructor(
    private readonly database: ArenaDatabase,
    options: SqliteRoomRepositoryOptions = {},
  ) {
    this.archiveLimit = options.archiveLimit ?? DEFAULT_ARCHIVE_LIMIT;
    if (options.importFrom !== undefined) this.importLegacy(options.importFrom);
  }

  load(roomId: string): PersistedRoom | null {
    this.assertRoomId(roomId);
    const row = this.database.db.prepare('SELECT id, payload FROM rooms WHERE id = ?').get(roomId) as KeyedRow | undefined;
    return parseRoom(row, `room ${roomId}`, roomKey);
  }

  save(room: GameRoom): void {
    this.assertRoomId(room.id);
    this.upsertRoom(room.toSnapshot());
  }

  list(): RoomSummary[] {
    const rows = this.database.db.prepare('SELECT id, payload FROM rooms').all() as unknown as KeyedRow[];
    const summaries: RoomSummary[] = [];
    for (const row of rows) {
      const persisted = parseRoom(row, `room ${row.id}`, roomKey);
      if (persisted) summaries.push(summarize(persisted));
    }
    return summaries.sort((a, b) => a.roomId.localeCompare(b.roomId));
  }

  delete(roomId: string): void {
    this.assertRoomId(roomId);
    this.database.db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
  }

  archive(persisted: PersistedRoom): void {
    const archiveId = archiveSummaryOf(persisted).archiveId;
    if (!ARCHIVE_ID_PATTERN.test(archiveId)) {
      throw new RoomError('INVALID_REQUEST', `Invalid archiveId "${String(archiveId)}".`);
    }
    this.upsertArchive(persisted);
    this.pruneArchives(persisted.id);
  }

  loadArchive(archiveId: string): PersistedRoom | null {
    if (!ARCHIVE_ID_PATTERN.test(archiveId)) {
      throw new RoomError('INVALID_REQUEST', `Invalid archiveId "${String(archiveId)}".`);
    }
    const row = this.database.db
      .prepare('SELECT archive_id AS id, payload FROM archives WHERE archive_id = ?')
      .get(archiveId) as KeyedRow | undefined;
    return parseRoom(row, `archive ${archiveId}`, archiveKey);
  }

  listArchives(): ArchiveSummary[] {
    const rows = this.database.db.prepare('SELECT archive_id AS id, payload FROM archives').all() as unknown as KeyedRow[];
    const summaries: ArchiveSummary[] = [];
    for (const row of rows) {
      const persisted = parseRoom(row, `archive ${row.id}`, archiveKey);
      if (persisted) summaries.push(archiveSummaryOf(persisted));
    }
    return summaries.sort((a, b) => b.playedAt.localeCompare(a.playedAt));
  }

  /**
   * One-time import of the legacy room/archive JSON. Two rules keep it safe:
   * one bad file must not abort the import (the transaction would roll back
   * and the next boot would hit the same file forever), and "already
   * imported" is a stored marker rather than "the table happens to be empty" —
   * otherwise deleting the last room would let the next boot resurrect it.
   */
  private importLegacy(dataDir: string): void {
    if (this.database.metaFlag(LEGACY_IMPORTED_FLAG)) return;
    // A populated database already holds the authoritative state; importing
    // over it would overwrite newer rows with stale JSON. Mark it done so the
    // question is never asked again.
    const existing = this.database.db
      .prepare('SELECT (SELECT COUNT(*) FROM rooms) + (SELECT COUNT(*) FROM archives) AS count')
      .get() as { count: number };
    if (Number(existing.count) > 0) {
      this.database.setMetaFlag(LEGACY_IMPORTED_FLAG);
      return;
    }

    const roomIds = legacyIdsIn(path.join(dataDir, 'rooms'), ROOM_ID_PATTERN, 'room');
    const archiveIds = legacyIdsIn(path.join(dataDir, 'archive'), ARCHIVE_ID_PATTERN, 'archive');
    if (roomIds.length === 0 && archiveIds.length === 0) return;

    // `createDirs: false`: the legacy tree is read-only here, and creating the
    // directories would undo a cleanup the user just did.
    const legacy = new FileRoomRepository(dataDir, {
      archiveLimit: this.archiveLimit,
      createDirs: false,
    });
    let rooms = 0;
    let archives = 0;
    this.database.transaction(() => {
      for (const roomId of roomIds) if (this.importRoom(legacy, roomId)) rooms += 1;
      for (const archiveId of archiveIds) if (this.importArchive(legacy, archiveId)) archives += 1;
      this.database.setMetaFlag(LEGACY_IMPORTED_FLAG);
    });
    if (rooms > 0 || archives > 0) {
      console.log(`[sqlite-repository] imported ${rooms} rooms and ${archives} archives from legacy JSON.`);
    }
  }

  private importRoom(legacy: FileRoomRepository, roomId: string): boolean {
    try {
      const persisted = legacy.load(roomId);
      if (persisted === null) return false;
      // The app wrote `<room.id>.json`, so a payload whose id is not its own
      // file name was renamed or hand-edited, and one that cannot be restored
      // would fail every boot after this one.
      if (persisted.id !== roomId || !isRestorableRoom(persisted)) {
        console.warn(`[sqlite-repository] skipping legacy room ${roomId}: not a room snapshot written under this id`);
        return false;
      }
      this.upsertRoom(persisted);
      return true;
    } catch (error) {
      console.warn(
        `[sqlite-repository] skipping legacy room ${roomId}:`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  private importArchive(legacy: FileRoomRepository, archiveId: string): boolean {
    try {
      const persisted = legacy.loadArchive(archiveId);
      if (persisted === null) return false;
      // `archive()` names a row `<room.id>__<gameId>` from the payload, which is
      // also the legacy file name; a mismatch means the file was moved or edited.
      if (!isRestorableRoom(persisted) || archiveSummaryOf(persisted).archiveId !== archiveId) {
        console.warn(`[sqlite-repository] skipping legacy archive ${archiveId}: not an archive written under this id`);
        return false;
      }
      this.upsertArchive(persisted);
      return true;
    } catch (error) {
      console.warn(
        `[sqlite-repository] skipping legacy archive ${archiveId}:`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  private upsertRoom(persisted: PersistedRoom): void {
    const updatedAt = Date.parse(String(persisted.state.updatedAt));
    this.database.db.prepare(`
      INSERT INTO rooms(id, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(persisted.id, JSON.stringify(persisted), Number.isFinite(updatedAt) ? updatedAt : Date.now());
  }

  private upsertArchive(persisted: PersistedRoom): void {
    const summary = archiveSummaryOf(persisted);
    const playedAt = Date.parse(String(summary.playedAt));
    this.database.db.prepare(`
      INSERT INTO archives(archive_id, room_id, played_at, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(archive_id) DO UPDATE SET room_id = excluded.room_id, played_at = excluded.played_at, payload = excluded.payload
    `).run(
      summary.archiveId,
      summary.roomId,
      Number.isFinite(playedAt) ? playedAt : Date.now(),
      JSON.stringify(persisted),
    );
  }

  private pruneArchives(roomId: string): void {
    const rows = this.database.db.prepare(
      'SELECT archive_id AS id, payload FROM archives WHERE room_id = ? ORDER BY played_at DESC, rowid DESC',
    ).all(roomId) as unknown as KeyedRow[];
    // Corrupt rows are neither counted nor pruned: they are evidence, and
    // deleting them would hide whatever happened (same as the file store).
    const owned = rows
      .map((row) => parseRoom(row, `archive ${row.id}`, archiveKey))
      .filter((entry): entry is PersistedRoom => entry !== null)
      .map((entry) => archiveSummaryOf(entry));
    const stale = owned.slice(this.archiveLimit);
    if (stale.length === 0) return;
    this.database.transaction(() => {
      const remove = this.database.db.prepare('DELETE FROM archives WHERE archive_id = ?');
      for (const entry of stale) remove.run(entry.archiveId);
    });
  }

  private assertRoomId(roomId: string): void {
    if (!ROOM_ID_PATTERN.test(roomId)) {
      throw new RoomError('INVALID_ROOM_ID', `Invalid roomId "${String(roomId)}".`);
    }
  }
}
