import { describe, expect, it } from 'vitest';
import type { ErrorCode } from '@arena/shared';
import { MemoryRoomRepository } from '../src/rooms/repository';
import { RoomManager } from '../src/rooms/room-manager';

function expectRoomError(fn: () => unknown, code: ErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected a RoomError with code ${code}`);
}

describe('RoomManager', () => {
  it('creates a default room with human on black and agent on white', () => {
    const manager = new RoomManager();
    const room = manager.initializeDefaultRoom();

    expect(room.id).toBe('default');
    expect(room.getState().status).toBe('idle');
    expect(room.getState().seats).toEqual({
      black: { kind: 'human' },
      white: { kind: 'agent' },
    });
    expect(manager.get('default')).toBe(room);
  });

  it('is idempotent when initializing the default room', () => {
    const manager = new RoomManager();
    const first = manager.initializeDefaultRoom();
    const second = manager.initializeDefaultRoom();

    expect(second).toBe(first);
    expect(manager.list()).toHaveLength(1);
  });

  it('supports a custom default room id', () => {
    const manager = new RoomManager({ defaultRoomId: 'lobby' });
    manager.initializeDefaultRoom();

    expect(manager.defaultRoomId).toBe('lobby');
    expect(manager.get('lobby')?.id).toBe('lobby');
  });

  it('applies seats and rules when creating a room', () => {
    const manager = new RoomManager();
    const room = manager.create('custom', {
      seats: { black: { kind: 'agent' }, white: { kind: 'human' } },
      rules: { boardSize: 9, winLength: 4 },
    });

    expect(room.getAgentSeat()).toBe('black');
    expect(room.getState().rules.boardSize).toBe(9);
    expect(room.getState().board).toHaveLength(9);
  });

  it('rejects duplicate rooms', () => {
    const manager = new RoomManager();
    manager.create('room-1');

    expectRoomError(() => manager.create('room-1'), 'ROOM_EXISTS');
  });

  it.each(['', 'has space', 'bad/slash', '..', 'a'.repeat(33)])(
    'rejects invalid room id %j',
    (roomId) => {
      const manager = new RoomManager();
      expectRoomError(() => manager.create(roomId), 'INVALID_ROOM_ID');
    },
  );

  it('returns undefined for unknown rooms and can get-or-create', () => {
    const manager = new RoomManager();

    expect(manager.get('missing')).toBeUndefined();
    const room = manager.getOrCreate('missing');
    expect(manager.get('missing')).toBe(room);
    expect(manager.getOrCreate('missing')).toBe(room);
  });

  it('lists rooms sorted with their current summary', () => {
    const manager = new RoomManager();
    manager.create('zeta');
    manager.create('alpha');

    const summaries = manager.list();
    expect(summaries.map((summary) => summary.roomId)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(summaries[0]).toMatchObject({
      status: 'idle',
      moveCount: 0,
      version: 0,
    });
  });

  it('removes rooms from both the manager and the repository', () => {
    const repository = new MemoryRoomRepository();
    const manager = new RoomManager({ repository });
    manager.create('room-1');

    manager.remove('room-1');

    expect(manager.get('room-1')).toBeUndefined();
    expect(repository.load('room-1')).toBeNull();
    expect(manager.list()).toEqual([]);
  });

  it('isolates game state between rooms', () => {
    const manager = new RoomManager();
    const a = manager.create('a');
    const b = manager.create('b');

    a.newGame();
    b.newGame();
    a.moveBy('human', 7, 7);

    expect(a.getState().moveCount).toBe(1);
    expect(b.getState().moveCount).toBe(0);
    expect(a.getState().lastMove).not.toBeNull();
    expect(b.getState().lastMove).toBeNull();
    expect(a.getState().gameId).not.toBe(b.getState().gameId);
  });

  it('restores a room from the repository on re-creation', () => {
    const repository = new MemoryRoomRepository();
    const first = new RoomManager({ repository });
    const room = first.create('persisted');
    room.newGame();
    room.moveBy('human', 7, 7);
    room.say('still here');

    const second = new RoomManager({ repository });
    const restored = second.getOrCreate('persisted');

    expect(restored.getState().moveCount).toBe(1);
    expect(restored.getView().commentary).toHaveLength(1);
  });
});

describe('MemoryRoomRepository', () => {
  it('starts empty', () => {
    const repository = new MemoryRoomRepository();

    expect(repository.load('default')).toBeNull();
    expect(repository.list()).toEqual([]);
  });

  it('stores clones so callers cannot mutate persisted data', () => {
    const repository = new MemoryRoomRepository();
    const manager = new RoomManager({ repository });
    const room = manager.create('room-1');
    room.newGame();
    room.moveBy('human', 7, 7);

    const snapshot = repository.load('room-1');
    expect(snapshot).not.toBeNull();

    snapshot!.history.push({
      row: 0,
      col: 0,
      color: 'black',
      index: 99,
      at: '2026-01-01T00:00:00.000Z',
    });
    snapshot!.state.board[0]![0] = 'black';

    const reloaded = repository.load('room-1');
    expect(reloaded?.history).toHaveLength(1);
    expect(reloaded?.state.board[0]?.[0]).toBeNull();
  });

  it('lists summaries and deletes rooms', () => {
    const manager = new RoomManager();
    const room = manager.create('room-1');
    room.newGame();
    room.moveBy('human', 3, 3);

    const summary = manager.repository.list()[0];
    expect(summary).toMatchObject({ roomId: 'room-1', moveCount: 1 });

    manager.repository.delete('room-1');
    expect(manager.repository.list()).toEqual([]);
    expect(manager.repository.load('room-1')).toBeNull();
  });
});
