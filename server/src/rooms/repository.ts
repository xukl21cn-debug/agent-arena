import type {
  AnyGameState,
  AnyMove,
  Commentary,
  GameState,
  Move,
  RoomSummary,
} from '@arena/shared';
import type { GameRoom } from './room.js';

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
