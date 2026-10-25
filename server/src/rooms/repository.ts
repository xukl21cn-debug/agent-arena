import type {
  Commentary,
  GameState,
  Move,
  RoomSummary,
} from '@arena/shared';
import type { GameRoom } from './room.js';

/** Serializable snapshot of a room, the unit the repository persists. */
export interface PersistedRoom {
  id: string;
  state: GameState;
  history: Move[];
  commentary: Commentary[];
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
    return persisted ? structuredClone(persisted) : null;
  }

  save(room: GameRoom): void {
    this.rooms.set(room.id, structuredClone(room.toSnapshot()));
  }

  list(): RoomSummary[] {
    return [...this.rooms.values()]
      .map(summarize)
      .sort((a, b) => a.roomId.localeCompare(b.roomId));
  }

  delete(roomId: string): void {
    this.rooms.delete(roomId);
  }
}
