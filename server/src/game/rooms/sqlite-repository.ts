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

interface PayloadRow {
  payload: string;
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

  /** One-time import of legacy room/archive JSON; corrupt files are skipped by FileRoomRepository. */
  private importLegacy(dataDir: string): void {
    const rooms = Number((this.database.db.prepare('SELECT COUNT(*) AS count FROM rooms').get() as { count: number }).count);
    const archives = Number((this.database.db.prepare('SELECT COUNT(*) AS count FROM archives').get() as { count: number }).count);
    if (rooms > 0 || archives > 0) return;

    const legacy = new FileRoomRepository(dataDir, { archiveLimit: this.archiveLimit });
    const roomSummaries = legacy.list();
    const archiveSummaries = legacy.listArchives();
    this.database.transaction(() => {
      for (const summary of roomSummaries) {
        const persisted = legacy.load(summary.roomId);
        if (persisted) this.upsertRoom(persisted);
      }
      for (const summary of archiveSummaries) {
        const persisted = legacy.loadArchive(summary.archiveId);
        if (persisted) this.upsertArchive(persisted);
      }
    });
    if (roomSummaries.length > 0 || archiveSummaries.length > 0) {
      console.log(`[sqlite-repository] imported ${roomSummaries.length} rooms and ${archiveSummaries.length} archives from legacy JSON.`);
    }
  }

  private upsertRoom(persisted: PersistedRoom): void {
    this.database.db.prepare(`
      INSERT INTO rooms(id, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(persisted.id, JSON.stringify(persisted), persisted.state.updatedAt);
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
