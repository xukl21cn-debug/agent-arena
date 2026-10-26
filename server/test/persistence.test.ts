import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PersistedRoom } from '../src/rooms/repository';
import { FileRoomRepository } from '../src/rooms/repository';
import { RoomManager } from '../src/rooms/room-manager';

/**
 * Every test gets a fresh temp directory — never the repo's own data/,
 * which holds real games when the server runs from the checkout.
 */
const tempRoots: string[] = [];
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'arena-persist-test-'));
  tempRoots.push(dataDir);
});

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function roomsDir(): string {
  return path.join(dataDir, 'rooms');
}

function roomFile(roomId: string): string {
  // Tests that plant files by hand run ahead of any repository constructor,
  // so the directory has to exist first.
  mkdirSync(roomsDir(), { recursive: true });
  return path.join(roomsDir(), `${roomId}.json`);
}

function manager(): RoomManager {
  return new RoomManager({ repository: new FileRoomRepository(dataDir) });
}

function playMoves(roomId: string, moves: Array<[number, number]>): void {
  const room = manager().create(roomId);
  room.newGame({ agentColor: 'white' });
  // Human (black) and agent (white) alternate, like a real game.
  moves.forEach(([row, col], index) => {
    const actor = index % 2 === 0 ? 'human' : 'agent';
    const result = room.moveAs({ actor }, row, col);
    if (!result.ok) {
      throw new Error(`move ${index} (${row},${col}) failed: ${result.message}`);
    }
  });
  return;
}

describe('FileRoomRepository', () => {
  it('F1: save writes a JSON file whose content parses', () => {
    playMoves('f1room', [[7, 7], [8, 8]]);

    expect(existsSync(roomFile('f1room'))).toBe(true);
    const parsed = JSON.parse(readFileSync(roomFile('f1room'), 'utf8')) as PersistedRoom;
    expect(parsed.id).toBe('f1room');
    expect(parsed.state.gameId).toEqual(expect.any(String));
  });

  it('F2: load returns the full snapshot — state, history, commentary', () => {
    const room = manager().create('f2room');
    room.newGame({ agentColor: 'white' });
    room.moveBy('human', 7, 7);
    room.say('好开局', 'position');

    const repository = new FileRoomRepository(dataDir);
    const persisted = repository.load('f2room');

    expect(persisted).not.toBeNull();
    expect(persisted!.state.moveCount).toBe(1);
    expect(persisted!.history).toHaveLength(1);
    expect(persisted!.commentary).toHaveLength(1);
    expect(persisted!.commentary[0]!.text).toBe('好开局');
    expect(persisted!.state.seats.white.kind).toBe('agent');
  });

  it('F3: a fresh repository instance reads what an earlier one wrote (restart simulation)', () => {
    playMoves('f3room', [[7, 7]]);

    const second = new FileRoomRepository(dataDir);
    const persisted = second.load('f3room');

    expect(persisted).not.toBeNull();
    expect(persisted!.state.board[7]![7]).toBe('black');
    expect(persisted!.state.turn).toBe('white');
  });

  it('F4: a corrupt file makes load return null without throwing, and the file stays put', () => {
    writeFileSync(roomFile('f4room'), '{"id": "f4room", "state": {"hal', 'utf8');

    const repository = new FileRoomRepository(dataDir);
    expect(() => repository.load('f4room')).not.toThrow();
    expect(repository.load('f4room')).toBeNull();
    // The damaged file is kept for inspection, not deleted or replaced.
    expect(existsSync(roomFile('f4room'))).toBe(true);
    expect(repository.list()).toEqual([]);
  });

  it('F5: delete removes the file', () => {
    playMoves('f5room', []);
    expect(existsSync(roomFile('f5room'))).toBe(true);

    new FileRoomRepository(dataDir).delete('f5room');

    expect(existsSync(roomFile('f5room'))).toBe(false);
    // Idempotent: deleting a room that never existed is fine too.
    expect(() => new FileRoomRepository(dataDir).delete('f5room')).not.toThrow();
  });

  it('F6: list returns every room as a summary', () => {
    playMoves('f6a', [[7, 7]]);
    playMoves('f6b', [[3, 3], [3, 4]]);

    const list = new FileRoomRepository(dataDir).list();

    expect(list.map((item) => item.roomId)).toEqual(['f6a', 'f6b']);
    expect(list.every((item) => item.game === 'gomoku')).toBe(true);
    expect(list.find((item) => item.roomId === 'f6b')!.moveCount).toBe(2);
    expect(list.find((item) => item.roomId === 'f6b')!.status).toBe('playing');
  });

  it('F7: a save leaves no .tmp file behind', () => {
    const room = manager().create('f7room');
    room.newGame({ agentColor: 'white' });
    room.moveBy('human', 7, 7);
    room.moveBy('agent', 8, 8);

    const leftovers = readdirSync(roomsDir()).filter((name) =>
      name.endsWith('.tmp'),
    );

    expect(leftovers).toEqual([]);
  });

  it('F8: a v1 snapshot file migrates to v2 on load', () => {
    // What MemoryRoomRepository wrote before the `game` discriminant existed.
    const v1 = {
      id: 'f8room',
      state: {
        roomId: 'f8room',
        schemaVersion: 1,
        rules: { boardSize: 15, winLength: 5, overlineWin: true, forbidden: 'none' },
        board: [],
        turn: 'black',
        seats: { black: { kind: 'human' }, white: { kind: 'agent' } },
        status: 'playing',
        winner: null,
        endReason: null,
        winLine: null,
        lastMove: null,
        moveCount: 0,
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      history: [],
      commentary: [],
    };
    writeFileSync(roomFile('f8room'), JSON.stringify(v1), 'utf8');

    const persisted = new FileRoomRepository(dataDir).load('f8room');

    expect(persisted).not.toBeNull();
    expect(persisted!.state.game).toBe('gomoku');
    expect(persisted!.state.schemaVersion).toBe(2);
  });

  it('F9: restoreAll brings rooms back with their state; a corrupt neighbor is skipped', () => {
    const first = manager();
    const good = first.create('f9good');
    good.newGame({ agentColor: 'white' });
    good.moveBy('human', 7, 7);
    good.moveBy('agent', 8, 8);
    first.create('f9fresh'); // never played: idle snapshot

    writeFileSync(roomFile('f9broken'), 'not json at all', 'utf8');

    // A brand-new manager over the same directory: the restart.
    const restarted = manager();
    restarted.restoreAll();

    expect(restarted.get('f9good')).toBeDefined();
    expect(restarted.get('f9fresh')).toBeDefined();
    // The corrupt room is absent — not resurrected as an empty impostor.
    expect(restarted.get('f9broken')).toBeUndefined();

    const state = restarted.get('f9good')!.getState();
    expect(state.status).toBe('playing');
    expect(state.moveCount).toBe(2);
    expect(state.gameId).toBe(good.getState().gameId);
    // The game continues where it stopped: black is on turn again.
    expect(state.turn).toBe('black');
    // restoreAll is idempotent: rooms already in memory are not re-created.
    expect(() => restarted.restoreAll()).not.toThrow();
    expect(restarted.get('f9good')!.getState().version).toBe(state.version);
    // Actor routing survives the restart off the persisted seats: the agent
    // (white) may not move on black's turn, the human (black) may.
    expect(restarted.get('f9good')!.moveAs({ actor: 'agent' }, 6, 6).ok).toBe(false);
    const resumed = restarted.get('f9good')!.moveAs({ actor: 'human' }, 6, 6);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.state.board[6]![6]).toBe('black');
    }
  });
});
