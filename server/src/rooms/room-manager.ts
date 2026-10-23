import {
  DEFAULT_ROOM_ID,
  ROOM_ID_PATTERN,
  type RoomSummary,
} from '@gomoku/shared';
import { RoomError, GameRoom, type RoomConfig } from './room.js';
import {
  MemoryRoomRepository,
  type RoomRepository,
} from './repository.js';

export interface RoomManagerOptions {
  repository?: RoomRepository;
  defaultRoomId?: string;
  defaultRoomConfig?: RoomConfig;
}

export function assertRoomId(roomId: unknown): asserts roomId is string {
  if (typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) {
    throw new RoomError(
      'INVALID_ROOM_ID',
      `Invalid roomId "${String(roomId)}": expected 1-32 characters of [a-zA-Z0-9_-].`,
    );
  }
}

/**
 * Registry of GameRooms. Rooms are isolated from each other; `default` is
 * created at startup so the web UI and MCP agents can meet there.
 */
export class RoomManager {
  readonly repository: RoomRepository;
  private readonly rooms = new Map<string, GameRoom>();
  private readonly defaultRoomConfig: RoomConfig;
  private readonly defaultRoomIdValue: string;

  constructor(options: RoomManagerOptions = {}) {
    this.repository = options.repository ?? new MemoryRoomRepository();
    this.defaultRoomIdValue = options.defaultRoomId ?? DEFAULT_ROOM_ID;
    this.defaultRoomConfig = options.defaultRoomConfig ?? {};
  }

  get defaultRoomId(): string {
    return this.defaultRoomIdValue;
  }

  get(roomId: string): GameRoom | undefined {
    return this.rooms.get(roomId);
  }

  getOrCreate(roomId: string, config: RoomConfig = {}): GameRoom {
    return this.get(roomId) ?? this.create(roomId, config);
  }

  create(roomId: string, config: RoomConfig = {}): GameRoom {
    assertRoomId(roomId);

    if (this.rooms.has(roomId)) {
      throw new RoomError('ROOM_EXISTS', `Room "${roomId}" already exists.`);
    }

    const room = new GameRoom(roomId, {
      seats: config.seats,
      rules: config.rules,
      repository: this.repository,
    });

    this.rooms.set(roomId, room);
    this.repository.save(room);
    return room;
  }

  list(): RoomSummary[] {
    return [...this.rooms.values()]
      .map((room) => room.getSummary())
      .sort((a, b) => a.roomId.localeCompare(b.roomId));
  }

  remove(roomId: string): void {
    this.rooms.delete(roomId);
    this.repository.delete(roomId);
  }

  /** Idempotently create the configured default room. */
  initializeDefaultRoom(): GameRoom {
    return (
      this.get(this.defaultRoomIdValue) ??
      this.create(this.defaultRoomIdValue, this.defaultRoomConfig)
    );
  }
}
