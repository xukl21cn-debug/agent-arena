import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { ROOM_ID_PATTERN, type RoomSummary } from '@arena/shared';
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
 */
export interface RoomRepository {
  load(roomId: string): PersistedRoom | null;
  save(room: GameRoom): void;
  list(): RoomSummary[];
  delete(roomId: string): void;
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

  constructor(dataDir: string) {
    this.roomsDir = path.join(dataDir, 'rooms');
    mkdirSync(this.roomsDir, { recursive: true });
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
    const file = this.fileFor(room.id);
    const tmp = `${file}.tmp`;
    const json = JSON.stringify(room.toSnapshot());
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
}
