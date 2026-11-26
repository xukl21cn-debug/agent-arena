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
  /** When set, import the legacy rooms/archive JSON files if the tables are empty. */
  importFrom?: string;
}

/** One-shot import marker; see `ArenaDatabase.metaFlag`. */
const LEGACY_IMPORTED_FLAG = 'legacy_imported:rooms';

interface PayloadRow {
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

function parsePayload<T>(row: PayloadRow | undefined, label: string): T | null {
  if (row === undefined) return null;
  try {
    return JSON.parse(row.payload) as T;
  } catch (error) {
    console.error(`[sqlite-repository] skipping corrupt ${label}:`, error instanceof Error ? error.message : error);
    return null;
  }
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
    const row = this.database.db.prepare('SELECT payload FROM rooms WHERE id = ?').get(roomId) as PayloadRow | undefined;
    const persisted = parsePayload<PersistedRoom>(row, `room ${roomId}`);
    return persisted === null ? null : migrateSnapshot(persisted);
  }

  save(room: GameRoom): void {
    this.assertRoomId(room.id);
    this.upsertRoom(room.toSnapshot());
  }

  list(): RoomSummary[] {
    const rows = this.database.db.prepare('SELECT payload FROM rooms').all() as unknown as PayloadRow[];
    const summaries: RoomSummary[] = [];
    for (const row of rows) {
      const persisted = parsePayload<PersistedRoom>(row, 'room');
      if (persisted) summaries.push(summarize(migrateSnapshot(persisted)));
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
    const row = this.database.db.prepare('SELECT payload FROM archives WHERE archive_id = ?').get(archiveId) as PayloadRow | undefined;
    const persisted = parsePayload<PersistedRoom>(row, `archive ${archiveId}`);
    return persisted === null ? null : migrateSnapshot(persisted);
  }

  listArchives(): ArchiveSummary[] {
    const rows = this.database.db.prepare('SELECT payload FROM archives').all() as unknown as PayloadRow[];
    const summaries: ArchiveSummary[] = [];
    for (const row of rows) {
      const persisted = parsePayload<PersistedRoom>(row, 'archive');
      if (persisted) summaries.push(archiveSummaryOf(migrateSnapshot(persisted)));
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
      // Validate before binding: a payload without a usable updatedAt throws
      // inside the transaction, which rolls the whole import back.
      if (!ROOM_ID_PATTERN.test(persisted.id) || typeof persisted.state?.updatedAt !== 'string') {
        console.warn(`[sqlite-repository] skipping legacy room ${roomId}: unexpected payload shape`);
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
      if (!ROOM_ID_PATTERN.test(persisted.id)) {
        console.warn(`[sqlite-repository] skipping legacy archive ${archiveId}: unexpected payload shape`);
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
      'SELECT payload FROM archives WHERE room_id = ? ORDER BY played_at DESC, rowid DESC',
    ).all(roomId) as unknown as PayloadRow[];
    const owned = rows
      .map((row) => parsePayload<PersistedRoom>(row, 'archive'))
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
