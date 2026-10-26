import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { ROOM_ID_PATTERN, type ArchiveSummary, type RoomSummary } from '@arena/shared';
import type {
  AnyGameState,
  AnyMove,
  Commentary,
  GameState,
  Move,
} from '@arena/shared';
import { RoomError, type GameRoom } from './room.js';

/** Serializable snapshot of a room, the unit the repository persists. */
export interface PersistedRoom {
  id: string;
  state: AnyGameState;
  history: AnyMove[];
  commentary: Commentary[];
}

/**
 * Archive ids are `<roomId>__<gameId>` and become file names, so they are
 * validated everywhere they enter: the pattern forbids `/`, `\` and `..`,
 * which is the whole traversal surface. `__` (not `-`) separates the parts
 * because room ids may contain `-` themselves.
 */
export const ARCHIVE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

/** How many archived games one room keeps before the oldest is deleted. */
export const DEFAULT_ARCHIVE_LIMIT = 20;

export interface RepositoryOptions {
  archiveLimit?: number;
}

function archiveIdOf(persisted: PersistedRoom): string {
  return `${persisted.id}__${persisted.state.gameId}`;
}

/** The list entry: every judgement field is read off the archived state. */
export function archiveSummaryOf(persisted: PersistedRoom): ArchiveSummary {
  const { state } = persisted;
  return {
    archiveId: archiveIdOf(persisted),
    roomId: persisted.id,
    game: state.game,
    gameId: state.gameId,
    moveCount: state.moveCount,
    winner: state.winner,
    endReason: state.endReason,
    // The last move's time is when the game was actually played; a state
    // without moves falls back to its own updatedAt.
    playedAt: persisted.history.at(-1)?.at ?? state.updatedAt,
    seats: state.seats,
  };
}

function assertArchiveId(archiveId: string): void {
  if (!ARCHIVE_ID_PATTERN.test(archiveId)) {
    throw new RoomError(
      'INVALID_REQUEST',
      `Invalid archiveId "${String(archiveId)}": expected 1-80 characters of [a-zA-Z0-9_-].`,
    );
  }
}

/**
 * A v1 snapshot: written before the `game` discriminant existed, when the
 * only game was gomoku and schemaVersion was 1.
 */
export interface PersistedRoomV1 {
  id: string;
  state: Omit<GameState, 'game' | 'schemaVersion'> & { schemaVersion: 1 };
  history: Move[];
  commentary: Commentary[];
}

/**
 * v1 → v2: a snapshot without the `game` field predates Go entirely, so it
 * is gomoku by definition — the field is filled in, schemaVersion bumps to 2,
 * and nothing else changes. v2 snapshots pass through untouched.
 */
export function migrateSnapshot(snapshot: PersistedRoomV1 | PersistedRoom): PersistedRoom {
  const { state } = snapshot;
  // schemaVersion is the discriminant here: 1 marks the pre-game-field era.
  if (state.schemaVersion === 1) {
    return {
      id: snapshot.id,
      state: { ...state, game: 'gomoku', schemaVersion: 2 },
      history: snapshot.history,
      commentary: snapshot.commentary,
    };
  }
  return {
    id: snapshot.id,
    state,
    history: snapshot.history,
    commentary: snapshot.commentary,
  };
}

/**
 * Persistence seam. v1 ships with the in-memory implementation; swapping in
 * SQLite or JSON files later touches only this module.
 *
 * Archives are a side channel beside the live rooms: `newGame` writes one
 * before replacing the old game, and nothing else depends on them — least
 * of all boot, which never loads archives back into memory.
 */
export interface RoomRepository {
  load(roomId: string): PersistedRoom | null;
  save(room: GameRoom): void;
  list(): RoomSummary[];
  delete(roomId: string): void;
  /** Persist a finished-or-abandoned game; must never throw into newGame's caller for cleanup reasons, only for write failures the room catches. */
  archive(persisted: PersistedRoom): void;
  /** One archive by id, or null when absent/corrupt (corrupt files stay on disk). */
  loadArchive(archiveId: string): PersistedRoom | null;
  /** All archives, newest played first. */
  listArchives(): ArchiveSummary[];
}

export function summarize(persisted: PersistedRoom): RoomSummary {
  const { state } = persisted;
  // A persisted snapshot carries the game but not the roster, so ready
  // flags are gone with it: an idle restored room is honestly a lobby.
  const phase =
    state.status === 'playing'
      ? 'playing'
      : state.status === 'finished'
        ? 'finished'
        : 'lobby';
  return {
    roomId: persisted.id,
    game: state.game,
    status: state.status,
    phase,
    gameId: state.gameId,
    moveCount: state.moveCount,
    version: state.version,
    updatedAt: state.updatedAt,
  };
}

export class MemoryRoomRepository implements RoomRepository {
  private readonly rooms = new Map<string, PersistedRoom>();
  private readonly archives = new Map<string, PersistedRoom[]>();
  private readonly archiveLimit: number;

  constructor(options: RepositoryOptions = {}) {
    this.archiveLimit = options.archiveLimit ?? DEFAULT_ARCHIVE_LIMIT;
  }

  load(roomId: string): PersistedRoom | null {
    const persisted = this.rooms.get(roomId);
    return persisted ? migrateSnapshot(structuredClone(persisted)) : null;
  }

  save(room: GameRoom): void {
    this.rooms.set(room.id, structuredClone(room.toSnapshot()));
  }

  list(): RoomSummary[] {
    return [...this.rooms.values()]
      .map(migrateSnapshot)
      .map(summarize)
      .sort((a, b) => a.roomId.localeCompare(b.roomId));
  }

  delete(roomId: string): void {
    this.rooms.delete(roomId);
  }

  archive(persisted: PersistedRoom): void {
    const entry = structuredClone(persisted);
    const list = this.archives.get(persisted.id) ?? [];
    // Newest last; the head is dropped once the per-room budget is exceeded.
    list.push(entry);
    while (list.length > this.archiveLimit) {
      list.shift();
    }
    this.archives.set(persisted.id, list);
  }

  loadArchive(archiveId: string): PersistedRoom | null {
    assertArchiveId(archiveId);
    for (const list of this.archives.values()) {
      for (const entry of list) {
        if (archiveIdOf(entry) === archiveId) {
          return structuredClone(entry);
        }
      }
    }
    return null;
  }

  listArchives(): ArchiveSummary[] {
    return [...this.archives.values()]
      .flat()
      .map(archiveSummaryOf)
      .sort((a, b) => b.playedAt.localeCompare(a.playedAt));
  }
}

/**
 * One JSON file per room under `<dataDir>/rooms/<roomId>.json`.
 *
 * A corrupt file takes down one room, never the server: load/list skip it
 * with a logged error and the file stays on disk for manual inspection.
 * Writes go through a temp file and rename — a half-written snapshot would
 * otherwise break the room on every future boot.
 */
export class FileRoomRepository implements RoomRepository {
  private readonly roomsDir: string;
  private readonly archiveDir: string;
  private readonly archiveLimit: number;

  constructor(dataDir: string, options: RepositoryOptions = {}) {
    this.roomsDir = path.join(dataDir, 'rooms');
    mkdirSync(this.roomsDir, { recursive: true });
    this.archiveDir = path.join(dataDir, 'archive');
    mkdirSync(this.archiveDir, { recursive: true });
    this.archiveLimit = options.archiveLimit ?? DEFAULT_ARCHIVE_LIMIT;
  }

  /** Where room files live, for boot logs and diagnostics. */
  get roomsDirectory(): string {
    return this.roomsDir;
  }

  /**
   * Room ids are validated at every API boundary, but this module also
   * builds paths from them, so re-check here: the pattern forbids `/`,
   * `\` and `..`, which is the whole traversal surface.
   */
  private fileFor(roomId: string): string {
    if (!ROOM_ID_PATTERN.test(roomId)) {
      throw new RoomError(
        'INVALID_ROOM_ID',
        `Invalid roomId "${String(roomId)}": expected 1-32 characters of [a-zA-Z0-9_-].`,
      );
    }
    return path.join(this.roomsDir, `${roomId}.json`);
  }

  load(roomId: string): PersistedRoom | null {
    const file = this.fileFor(roomId);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      // Absent file is the normal "no such room" answer, not an error.
      return null;
    }
    try {
      return migrateSnapshot(JSON.parse(raw) as PersistedRoom);
    } catch (error) {
      console.error(
        `[repository] skipping corrupt room file ${file}:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  save(room: GameRoom): void {
    this.writeJson(this.fileFor(room.id), room.toSnapshot());
  }

  /**
   * Atomic JSON write: temp file + rename, so a reader never sees a partial
   * file and a half-written archive cannot poison the next boot's listing.
   */
  private writeJson(file: string, payload: unknown): void {
    const tmp = `${file}.tmp`;
    const json = JSON.stringify(payload);
    // Synchronous on purpose: a move must be durable before the response
    // goes out, and at 9x9 the write is a few milliseconds. Revisit if
    // boards grow or writes become high-frequency.
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, json);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // rename replaces the destination atomically within one filesystem —
    // a reader never sees a partial file.
    renameSync(tmp, file);
  }

  list(): RoomSummary[] {
    const summaries: RoomSummary[] = [];
    if (!existsSync(this.roomsDir)) {
      return summaries;
    }
    for (const entry of readdirSync(this.roomsDir)) {
      if (!entry.endsWith('.json') || entry.endsWith('.json.tmp')) {
        continue;
      }
      const roomId = entry.slice(0, -'.json'.length);
      const persisted = this.load(roomId);
      if (persisted) {
        summaries.push(summarize(persisted));
      }
    }
    return summaries.sort((a, b) => a.roomId.localeCompare(b.roomId));
  }

  delete(roomId: string): void {
    const file = this.fileFor(roomId);
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }

  // ---- archives -----------------------------------------------------------

  archive(persisted: PersistedRoom): void {
    const archiveId = archiveIdOf(persisted);
    assertArchiveId(archiveId);
    this.writeJson(path.join(this.archiveDir, `${archiveId}.json`), persisted);
    this.pruneArchives(persisted.id);
  }

  loadArchive(archiveId: string): PersistedRoom | null {
    assertArchiveId(archiveId);
    const file = path.join(this.archiveDir, `${archiveId}.json`);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    try {
      return migrateSnapshot(JSON.parse(raw) as PersistedRoom);
    } catch (error) {
      // Skip, log, keep the file: it is evidence, and deleting it would
      // hide whatever corruption happened (AGENTS §7.3).
      console.error(
        `[repository] skipping corrupt archive file ${file}:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  listArchives(): ArchiveSummary[] {
    const summaries: ArchiveSummary[] = [];
    for (const entry of this.archiveFileNames()) {
      const archiveId = entry.slice(0, -'.json'.length);
      const persisted = this.loadArchive(archiveId);
      if (persisted) {
        summaries.push(archiveSummaryOf(persisted));
      }
    }
    return summaries.sort((a, b) => b.playedAt.localeCompare(a.playedAt));
  }

  private archiveFileNames(): string[] {
    if (!existsSync(this.archiveDir)) {
      return [];
    }
    return readdirSync(this.archiveDir).filter(
      (entry) => entry.endsWith('.json') && !entry.endsWith('.json.tmp'),
    );
  }

  /**
   * Keep the newest `archiveLimit` games of ONE room. The limit is per room,
   * not global — a busy room must not evict everybody else's history.
   *
   * A file name prefix is not proof of ownership (a room id may itself
   * contain `__`), so each candidate is opened and its own `id` field
   * decides. Files that fail to parse are skipped and left alone: they are
   * not counted against the budget, and deleting them would destroy
   * evidence. Every deletion failure is logged and swallowed — pruning is
   * part of the archive side channel and must never break a new game.
   */
  private pruneArchives(roomId: string): void {
    const owned: Array<{ file: string; mtimeMs: number; playedAt: string }> = [];
    for (const entry of this.archiveFileNames()) {
      if (!entry.startsWith(`${roomId}__`)) {
        continue;
      }
      const archiveId = entry.slice(0, -'.json'.length);
      const persisted = this.loadArchive(archiveId);
      if (!persisted || persisted.id !== roomId) {
        continue;
      }
      const file = path.join(this.archiveDir, entry);
      try {
        owned.push({
          file,
          mtimeMs: statSync(file).mtimeMs,
          // The games' own clock, not the file system's: mtimes can tie at
          // millisecond resolution, and pruning must stay deterministic.
          playedAt: archiveSummaryOf(persisted).playedAt,
        });
      } catch {
        continue;
      }
    }
    if (owned.length <= this.archiveLimit) {
      return;
    }
    owned.sort(
      (a, b) =>
        b.playedAt.localeCompare(a.playedAt) || b.mtimeMs - a.mtimeMs,
    );
    for (const { file } of owned.slice(this.archiveLimit)) {
      try {
        unlinkSync(file);
      } catch (error) {
        console.error(
          `[repository] failed to prune archive ${file}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}
