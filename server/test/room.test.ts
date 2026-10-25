import { describe, expect, it, vi } from 'vitest';
import type { Actor, PlayerSpec, StoneColor } from '@arena/shared';
import { GameRoom, RoomError } from '../src/rooms/room';
import { MemoryRoomRepository } from '../src/rooms/repository';

const SEATS: Record<StoneColor, PlayerSpec> = {
  black: { kind: 'human' },
  white: { kind: 'agent' },
};

function newRoom(
  options: {
    repository?: MemoryRoomRepository;
    seats?: Record<StoneColor, PlayerSpec>;
  } = {},
): GameRoom {
  return new GameRoom('room-1', {
    repository: options.repository,
    seats: options.seats ?? SEATS,
  });
}

function newPlayingRoom(): GameRoom {
  const room = newRoom();
  room.newGame();
  return room;
}

function playMoves(
  room: GameRoom,
  moves: ReadonlyArray<readonly [Actor, number, number]>,
): void {
  for (const [actor, row, col] of moves) {
    const result = room.moveBy(actor, row, col);
    if (!result.ok) {
      throw new Error(`Unexpected ${actor} failure: ${result.code}`);
    }
  }
}

/** Four black threats and four white replies; black is to move. */
const BLACK_FOUR_READY: ReadonlyArray<readonly [Actor, number, number]> = [
  ['human', 7, 3],
  ['agent', 0, 0],
  ['human', 7, 4],
  ['agent', 0, 1],
  ['human', 7, 5],
  ['agent', 0, 2],
  ['human', 7, 6],
  ['agent', 0, 3],
];

describe('GameRoom lifecycle', () => {
  it('starts idle with human on black and agent on white', () => {
    const room = newRoom();
    const state = room.getState();

    expect(room.id).toBe('room-1');
    expect(state.status).toBe('idle');
    expect(state.gameId).toBe('');
    expect(state.seats).toEqual(SEATS);
    expect(room.getAgentSeat()).toBe('white');
    expect(room.getHumanSeat()).toBe('black');
  });

  it('starts a game and bumps the version', () => {
    const room = newRoom();
    const before = room.getState().version;
    const state = room.newGame();

    expect(state.status).toBe('playing');
    expect(state.gameId).not.toBe('');
    expect(state.version).toBe(before + 1);
    expect(state.turn).toBe('black');
  });

  it('lets the agent take black', () => {
    const room = newRoom();
    const state = room.newGame({ agentColor: 'black' });

    expect(state.seats).toEqual({
      black: { kind: 'agent' },
      white: { kind: 'human' },
    });
    expect(room.getAgentSeat()).toBe('black');
    expect(room.getHumanSeat()).toBe('white');
  });

  it('records history and clears it on a new game', () => {
    const room = newPlayingRoom();
    room.moveBy('human', 7, 7);
    room.moveBy('agent', 7, 8);

    expect(room.getHistory()).toHaveLength(2);
    expect(room.getHistory()[1]).toMatchObject({
      row: 7,
      col: 8,
      color: 'white',
    });

    room.newGame();
    expect(room.getHistory()).toHaveLength(0);
  });

  it('serializes competing moves: only the correct seat succeeds', () => {
    const room = newPlayingRoom();
    const first = room.moveBy('human', 7, 7);
    const second = room.moveBy('human', 7, 8);

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    if (!second.ok) {
      expect(second.state.moveCount).toBe(1);
    }
  });

  it('returns the current state with move errors', () => {
    const room = newPlayingRoom();
    room.moveBy('human', 7, 7);

    const occupied = room.moveBy('agent', 7, 7);
    expect(occupied).toMatchObject({ ok: false, code: 'CELL_OCCUPIED' });
    if (!occupied.ok) {
      expect(occupied.state.moveCount).toBe(1);
    }

    const outOfBounds = room.moveBy('agent', 15, 15);
    expect(outOfBounds).toMatchObject({ ok: false, code: 'OUT_OF_BOUNDS' });
  });

  it('rejects moves when no game is running', () => {
    const room = newRoom();
    expect(room.moveBy('human', 7, 7)).toMatchObject({
      ok: false,
      code: 'GAME_NOT_PLAYING',
    });
    expect(room.resignBy('human')).toMatchObject({
      ok: false,
      code: 'GAME_NOT_PLAYING',
    });
  });

  it('reports NO_AGENT_SEAT for rooms without an agent', () => {
    const room = newRoom({
      seats: { black: { kind: 'human' }, white: { kind: 'human' } },
    });

    expect(room.getAgentSeat()).toBeNull();
    expect(room.moveBy('agent', 7, 7)).toMatchObject({
      ok: false,
      code: 'NO_AGENT_SEAT',
    });
  });

  it('records a resign by the agent', () => {
    const room = newPlayingRoom();
    const result = room.resignBy('agent');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected resign to succeed');
    }
    expect(result.state.status).toBe('finished');
    expect(result.state.winner).toBe('black');
    expect(result.state.endReason).toBe('resign');
  });
});

describe('GameRoom waiters', () => {
  it('returns immediately when the game is idle', async () => {
    const room = newRoom();
    await expect(room.waitForSeat('white', 5000)).resolves.toMatchObject({
      reason: 'idle',
    });
  });

  it('returns immediately when it is already the agent turn', async () => {
    const room = newRoom();
    room.newGame({ agentColor: 'black' });

    await expect(room.waitForSeat('black', 5000)).resolves.toMatchObject({
      reason: 'your_turn',
    });
  });

  it('resolves with your_turn after the human moves', async () => {
    const room = newPlayingRoom();
    const waiting = room.waitForSeat('white', 5000);

    room.moveBy('human', 7, 7);
    const result = await waiting;

    expect(result.reason).toBe('your_turn');
    expect(result.state.turn).toBe('white');
    expect(result.state.lastMove).toMatchObject({ row: 7, col: 7 });
  });

  it('resolves every waiter on the same state change', async () => {
    const room = newPlayingRoom();
    const first = room.waitForSeat('white', 5000);
    const second = room.waitForSeat('white', 5000);

    room.moveBy('human', 7, 7);
    const [a, b] = await Promise.all([first, second]);

    expect(a.reason).toBe('your_turn');
    expect(b.reason).toBe('your_turn');
  });

  it('resolves with timeout without throwing', async () => {
    const room = newPlayingRoom();
    const result = await room.waitForSeat('white', 10);

    expect(result.reason).toBe('timeout');
    expect(result.state.status).toBe('playing');
  });

  it('resolves with game_over when the human wins', async () => {
    const room = newPlayingRoom();
    playMoves(room, BLACK_FOUR_READY);

    const waiting = room.waitForSeat('white', 5000);
    room.moveBy('human', 7, 7);
    const result = await waiting;

    expect(result.reason).toBe('game_over');
    expect(result.state.status).toBe('finished');
    expect(result.state.winner).toBe('black');
  });

  it('resolves with new_game when a new game starts on the human turn', async () => {
    const room = newPlayingRoom();
    const waiting = room.waitForSeat('white', 5000);

    const oldGameId = room.getState().gameId;
    room.newGame();
    const result = await waiting;

    expect(result.reason).toBe('new_game');
    expect(result.state.gameId).not.toBe(oldGameId);
    expect(result.state.status).toBe('playing');
    expect(result.state.turn).toBe('black');
  });

  it('resolves with your_turn when a new game starts on the agent turn', async () => {
    const room = newPlayingRoom();
    room.newGame({ agentColor: 'black' });
    const waiting = room.waitForSeat('black', 5000);

    room.newGame({ agentColor: 'black' });
    const result = await waiting;

    expect(result.reason).toBe('your_turn');
  });

  it('clears the pending timer once resolved', async () => {
    vi.useFakeTimers();
    try {
      const room = newPlayingRoom();
      const waiting = room.waitForSeat('white', 5000);
      room.moveBy('human', 7, 7);

      const result = await waiting;
      expect(result.reason).toBe('your_turn');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GameRoom commentary', () => {
  it('stores commentary with defaults and game metadata', () => {
    const room = newPlayingRoom();
    room.moveBy('human', 7, 7);

    const commentary = room.say('这步想抢中路？');

    expect(commentary).toMatchObject({
      roomId: 'room-1',
      gameId: room.getState().gameId,
      text: '这步想抢中路？',
      kind: 'reaction',
      mood: 'neutral',
      moveIndex: 1,
    });
    expect(room.getView().commentary).toHaveLength(1);
  });

  it('keeps the most recent 50 entries', () => {
    const room = newRoom();
    for (let index = 0; index < 55; index += 1) {
      room.say(`line ${index}`);
    }

    const log = room.getView().commentary;
    expect(log).toHaveLength(50);
    expect(log[0]?.text).toBe('line 5');
    expect(log.at(-1)?.text).toBe('line 54');
  });

  it('truncates text to 2000 characters without splitting surrogate pairs', () => {
    const room = newRoom();
    const commentary = room.say('😀'.repeat(2500));

    expect(Array.from(commentary.text)).toHaveLength(2000);
    expect(commentary.text.endsWith('😀')).toBe(true);
  });

  it('rejects empty commentary', () => {
    const room = newRoom();

    expect(() => room.say('   ')).toThrow(RoomError);
    try {
      room.say('');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_COMMENTARY' });
    }
  });

  it('does not change the game version', () => {
    const room = newPlayingRoom();
    const before = room.getState();

    room.say('hello');

    expect(room.getState().version).toBe(before.version);
    expect(room.getState()).toEqual(before);
  });

  it('clears commentary on a new game', () => {
    const room = newPlayingRoom();
    room.say('hello');
    room.newGame();

    expect(room.getView().commentary).toHaveLength(0);
  });

  it('notifies and unsubscribes commentators', () => {
    const room = newRoom();
    const seen: string[] = [];
    const unsubscribe = room.onCommentary((commentary) => {
      seen.push(commentary.text);
    });

    room.say('first');
    unsubscribe();
    room.say('second');

    expect(seen).toEqual(['first']);
  });
});

describe('GameRoom events', () => {
  it('emits state changes with a cause', () => {
    const room = newRoom();
    const events: string[] = [];
    room.onState((_state, cause) => {
      events.push(cause);
    });

    room.newGame();
    room.moveBy('human', 7, 7);
    room.resignBy('agent');

    expect(events).toEqual(['new_game', 'move', 'resign']);
  });

  it('stops emitting after unsubscribe', () => {
    const room = newRoom();
    let count = 0;
    const unsubscribe = room.onState(() => {
      count += 1;
    });

    room.newGame();
    unsubscribe();
    room.moveBy('human', 7, 7);

    expect(count).toBe(1);
  });
});

describe('GameRoom persistence', () => {
  it('restores state, history and commentary from the repository', () => {
    const repository = new MemoryRoomRepository();
    const room = newRoom({ repository });
    room.newGame();
    room.moveBy('human', 7, 7);
    room.say('remember me');

    const restored = new GameRoom('room-1', { repository });

    expect(restored.getState()).toEqual(room.getState());
    expect(restored.getHistory()).toEqual([...room.getHistory()]);
    expect(restored.getView().commentary).toEqual(room.getView().commentary);
  });

  it('writes a snapshot after every mutation', () => {
    const repository = new MemoryRoomRepository();
    const room = newRoom({ repository });
    room.newGame();
    room.moveBy('human', 7, 7);

    expect(repository.load('room-1')?.state.moveCount).toBe(1);
  });
});
