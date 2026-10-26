import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ErrorResponse } from '@arena/shared';
import { startGame } from '../src/core/engine.js';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import {
  FileRoomRepository,
  type RoomRepository,
} from '../src/rooms/repository';
import { RoomManager } from '../src/rooms/room-manager';
import { GameRoom } from '../src/rooms/room';

/**
 * P5A: archives (a new game saves the one it replaces) and replay (the real
 * engines rebuild every intermediate state). A1–A8 pin the archive timing
 * and budget; R1–R13 pin the endpoints, the capture replay and the hostile
 * inputs.
 */

const dataDirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'arena-replay-'));
  dataDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Archive: repository-level behaviour, driven through real GameRooms.
// ---------------------------------------------------------------------------

describe('archive', () => {
  it('A1: starting a new game archives the previous one to data/archive', () => {
    const dir = freshDir();
    const repo = new FileRoomRepository(dir);
    const room = new GameRoom('a1', { repository: repo });

    room.newGame();
    const firstGame = room.getState().gameId;
    room.moveBy('human', 7, 7);
    room.moveBy('agent', 8, 7);
    room.moveBy('human', 7, 8);
    room.newGame();

    const files = readdirSync(path.join(dir, 'archive'));
    expect(files).toEqual([`a1__${firstGame}.json`]);
  });

  it('A2: what is archived is the game being left, not the new one', () => {
    const dir = freshDir();
    const repo = new FileRoomRepository(dir);
    const room = new GameRoom('a2', { repository: repo });

    room.newGame();
    const oldGame = room.getState().gameId;
    room.moveBy('human', 7, 7);
    room.moveBy('agent', 8, 7);
    room.newGame();
    const newGame = room.getState().gameId;
    expect(newGame).not.toBe(oldGame);

    const archived = JSON.parse(
      readFileSync(path.join(dir, 'archive', `a2__${oldGame}.json`), 'utf8'),
    );
    expect(archived.state.gameId).toBe(oldGame);
    expect(archived.state.moveCount).toBe(2);
    expect(archived.history).toHaveLength(2);
    expect(archived.history.map((move: any) => [move.color, move.row, move.col])).toEqual([
      ['black', 7, 7],
      ['white', 8, 7],
    ]);
  });

  it('A3: a room that never started (idle, gameId "") archives nothing', () => {
    const dir = freshDir();
    const repo = new FileRoomRepository(dir);
    const room = new GameRoom('a3', { repository: repo });

    room.newGame();
    expect(readdirSync(path.join(dir, 'archive'))).toEqual([]);
  });

  it('A4: a game that started but never moved archives nothing', () => {
    const dir = freshDir();
    const repo = new FileRoomRepository(dir);
    const room = new GameRoom('a4', { repository: repo });

    room.newGame();
    room.newGame();
    expect(readdirSync(path.join(dir, 'archive'))).toEqual([]);
  });

  it('A5: only the newest N games of a room are kept', () => {
    const dir = freshDir();
    const repo = new FileRoomRepository(dir, { archiveLimit: 2 });
    const room = new GameRoom('a5', { repository: repo });

    const games: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      room.newGame();
      games.push(room.getState().gameId);
      room.moveBy('human', 7, i);
    }
    room.newGame(); // archives game 3 and prunes game 1

    const files = readdirSync(path.join(dir, 'archive')).sort();
    expect(files).toHaveLength(2);
    expect(files).not.toContain(`a5__${games[0]}.json`);
    expect(files).toContain(`a5__${games[1]}.json`);
    expect(files).toContain(`a5__${games[2]}.json`);
  });

  it('A6: the budget is per room — one room filling up evicts nothing elsewhere', () => {
    const dir = freshDir();
    const repo = new FileRoomRepository(dir, { archiveLimit: 1 });
    const busy = new GameRoom('busy', { repository: repo });
    const quiet = new GameRoom('quiet', { repository: repo });

    for (let i = 0; i < 3; i += 1) {
      busy.newGame();
      busy.moveBy('human', 7, i);
    }
    busy.newGame();

    quiet.newGame();
    const quietGame = quiet.getState().gameId;
    quiet.moveBy('human', 3, 3);
    quiet.newGame();

    const files = readdirSync(path.join(dir, 'archive')).sort();
    // busy keeps exactly 1, quiet keeps its only one.
    expect(files).toHaveLength(2);
    expect(files).toContain(`quiet__${quietGame}.json`);
    expect(files.filter((name) => name.startsWith('busy__'))).toHaveLength(1);
  });

  it('A7: an archive failure is logged, not thrown — the new game proceeds', () => {
    class FailingArchive implements RoomRepository {
      load(): null {
        return null;
      }
      save(): void {}
      list(): [] {
        return [];
      }
      delete(): void {}
      archive(): void {
        throw new Error('disk full');
      }
      loadArchive(): null {
        return null;
      }
      listArchives(): [] {
        return [];
      }
    }
    const room = new GameRoom('a7', { repository: new FailingArchive() });
    room.newGame();
    const oldGame = room.getState().gameId;
    room.moveBy('human', 7, 7);

    expect(() => room.newGame()).not.toThrow();
    expect(room.getState().gameId).not.toBe(oldGame);
    expect(room.getState().status).toBe('playing');
  });

  it('A8: boot restores rooms only — archives never rise as rooms', () => {
    const dir = freshDir();
    const repo = new FileRoomRepository(dir);
    const room = new GameRoom('a8', { repository: repo });
    room.newGame();
    room.moveBy('human', 7, 7);
    room.newGame(); // one archive exists now

    // The room file goes away; the archive stays. A restart must see no room.
    unlinkSync(path.join(dir, 'rooms', 'a8.json'));
    const rebooted = new RoomManager({ repository: repo });
    rebooted.restoreAll();
    expect(rebooted.list().map((summary) => summary.roomId)).toEqual([]);
    expect(rebooted.get('a8')).toBeUndefined();
    expect(repo.listArchives()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Replay + archive endpoints over HTTP, with real rooms behind them.
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;
let manager: RoomManager;
let httpDir: string;

async function get(pathname: string): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`);
}

/**
 * A client that sends the path verbatim. WHATWG URL parsing (what fetch
 * uses) folds `..` and `%2E%2E` path segments away before the request ever
 * leaves, so the encoded traversal that survives into the route is `%2E..`
 * style mixtures — and the one client that can deliver a bare `..` is one
 * that skips URL parsing entirely.
 */
async function getRaw(pathname: string): Promise<{ status: number; body: any }> {
  const port = Number(new URL(baseUrl).port);
  const response = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const request = http.get(
        { host: '127.0.0.1', port, path: pathname },
        (res) => {
          let raw = '';
          res.on('data', (chunk: string) => (raw += chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: raw }),
          );
        },
      );
      request.once('error', reject);
    },
  );
  return { status: response.status, body: JSON.parse(response.body) };
}

async function getJson<T>(pathname: string): Promise<T> {
  const response = await get(pathname);
  return (await response.json()) as T;
}

async function expectError(
  pathname: string,
  status: number,
  code: string,
): Promise<void> {
  const response = await get(pathname);
  expect(response.status).toBe(status);
  const payload = (await response.json()) as ErrorResponse;
  expect(payload.error?.code).toBe(code);
}

beforeAll(async () => {
  httpDir = freshDir();
  const repository = new FileRoomRepository(httpDir);
  manager = new RoomManager({ repository });
  manager.initializeDefaultRoom();
  server = createServer(
    createApp(manager, loadConfig({ ARENA_DATA_DIR: httpDir })),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dataDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Black wins on the 7th row; white answers below. 9 moves, game over. */
function playGomokuWin(room: GameRoom): void {
  const blackMoves = [
    [7, 7],
    [7, 8],
    [7, 9],
    [7, 10],
    [7, 11],
  ];
  const whiteMoves = [
    [8, 7],
    [8, 8],
    [8, 9],
    [8, 10],
  ];
  for (let i = 0; i < blackMoves.length; i += 1) {
    expect(room.moveBy('human', blackMoves[i]![0]!, blackMoves[i]![1]!).ok).toBe(true);
    if (i < whiteMoves.length) {
      expect(room.moveBy('agent', whiteMoves[i]![0]!, whiteMoves[i]![1]!).ok).toBe(true);
    }
  }
}

describe('replay endpoints', () => {
  it('R1: a finished gomoku game has one frame per move plus the opening', async () => {
    const room = manager.create('r1');
    room.newGame();
    playGomokuWin(room);

    const payload = await getJson<any>('/api/rooms/r1/replay');
    expect(payload.frames).toHaveLength(10);
    expect(payload.game).toBe('gomoku');
    expect(payload.archiveId).toBeNull();
    expect(payload.final.status).toBe('finished');
    expect(payload.final.winner).toBe('black');
  });

  it('R2: every frame is the board exactly after its move', async () => {
    const room = manager.get('r1')!;
    const history = [...room.getHistory()];
    const payload = await getJson<any>('/api/rooms/r1/replay');

    expect(payload.frames[0].state.moveCount).toBe(0);
    expect(payload.frames[0].move).toBeNull();
    for (let k = 1; k < payload.frames.length; k += 1) {
      const frame = payload.frames[k];
      expect(frame.index).toBe(k);
      expect(frame.state.moveCount).toBe(k);
      expect(frame.state.lastMove.row).toBe(history[k - 1].row);
      expect(frame.state.lastMove.col).toBe(history[k - 1].col);
      // No captures in this game: k stones after k moves.
      const stones = frame.state.board
        .flat()
        .filter((cell: unknown) => cell !== null).length;
      expect(stones).toBe(k);
    }
    // The last frame's board is the board the room actually holds.
    expect(payload.frames.at(-1).state.board).toEqual(room.getState().board);
  });

  it('R3: a Go capture replays with the stone still on the board one frame earlier', async () => {
    const room = manager.create('r3');
    room.newGame({ game: 'go' });
    expect(room.moveBy('human', 0, 1).ok).toBe(true);
    expect(room.moveBy('agent', 0, 0).ok).toBe(true);
    expect(room.moveBy('human', 1, 0).ok).toBe(true);

    const payload = await getJson<any>('/api/rooms/r3/replay');
    expect(payload.game).toBe('go');
    expect(payload.frames).toHaveLength(4);

    const before = payload.frames[2].state;
    expect(before.board[0][0]).toBe('white');
    expect(before.captures).toEqual({ black: 0, white: 0 });

    const after = payload.frames[3].state;
    expect(after.board[0][0]).toBeNull();
    expect(after.captures.black).toBe(1);
    expect(after.lastCaptured).toEqual([{ row: 0, col: 0 }]);
  });

  it('R4: two consecutive passes replay into the scoring phase', async () => {
    const room = manager.create('r4');
    room.newGame({ game: 'go' });
    expect(room.passAs({ actor: 'human' }).ok).toBe(true);
    expect(room.passAs({ actor: 'agent' }).ok).toBe(true);

    const payload = await getJson<any>('/api/rooms/r4/replay');
    const last = payload.frames.at(-1).state;
    expect(last.status).toBe('scoring');
    expect(last.consecutivePasses).toBe(2);
  });

  it('R5: frames carry the recorded gameId, not a fresh one', async () => {
    const room = manager.get('r1')!;
    const payload = await getJson<any>('/api/rooms/r1/replay');
    expect(payload.gameId).toBe(room.getState().gameId);
    expect(payload.frames[0].state.gameId).toBe(payload.gameId);
    expect(payload.final.gameId).toBe(payload.gameId);
  });

  it('R6: frame timestamps are the moves own times, not now', async () => {
    const history = (await getJson<any>('/api/rooms/r1')).history;
    const payload = await getJson<any>('/api/rooms/r1/replay');
    expect(payload.frames[1].move.at).toBe(history[0].at);
    expect(payload.frames[1].state.updatedAt).toBe(history[0].at);
  });

  it('R7: an archived game replays with the same content, and /api/archive lists it', async () => {
    const room = manager.create('r7');
    room.newGame({ game: 'go' });
    const gameId = room.getState().gameId;
    expect(room.moveBy('human', 4, 4).ok).toBe(true);
    expect(room.moveBy('agent', 2, 2).ok).toBe(true);
    room.newGame(); // archives the go game

    const list = await getJson<any[]>('/api/archive');
    const entry = list.find(
      (item: any) => item.archiveId === `r7__${gameId}`,
    );
    expect(entry).toMatchObject({
      roomId: 'r7',
      game: 'go',
      gameId,
      moveCount: 2,
    });

    const payload = await getJson<any>(
      `/api/archive/${encodeURIComponent(`r7__${gameId}`)}/replay`,
    );
    expect(payload.archiveId).toBe(`r7__${gameId}`);
    expect(payload.gameId).toBe(gameId);
    expect(payload.frames).toHaveLength(3);
    expect(payload.final.moveCount).toBe(2);
  });

  it('R8: a room that never played answers NO_MOVES, not an error page', async () => {
    manager.create('r8');
    await expectError('/api/rooms/r8/replay', 400, 'NO_MOVES');
  });

  it('R9: unknown room and unknown archive are 404s of their own kind', async () => {
    await expectError('/api/rooms/ghost/replay', 404, 'ROOM_NOT_FOUND');
    await expectError(
      `/api/archive/${encodeURIComponent('nope__00000000-0000-0000-0000-000000000000')}/replay`,
      404,
      'ARCHIVE_NOT_FOUND',
    );
  });

  it('R10: a malformed archiveId is rejected before any file is touched', async () => {
    await expectError(
      `/api/archive/${encodeURIComponent('../rooms/r1')}/replay`,
      400,
      'INVALID_REQUEST',
    );
    await expectError(
      `/api/archive/${encodeURIComponent('a/b')}/replay`,
      400,
      'INVALID_REQUEST',
    );
    // URL parsing folds a bare `..` away before fetch can send it; a raw
    // socket is the client that can actually deliver it to the route.
    const raw = await getRaw('/api/archive/../replay');
    expect(raw.status).toBe(400);
    expect(raw.body.error?.code).toBe('INVALID_REQUEST');
  });

  it('R11: a history that breaks the rules fails with the move number', async () => {
    const state = startGame(
      { roomId: 'r11', version: 0 },
      { black: { kind: 'human' }, white: { kind: 'agent' } },
      { gameId: '11111111-1111-4111-8111-111111111111' },
    );
    const at = '2026-10-26T08:00:00.000Z';
    writeFileSync(
      path.join(httpDir, 'archive', 'r11__11111111-1111-4111-8111-111111111111.json'),
      JSON.stringify({
        id: 'r11',
        state,
        history: [
          { row: 7, col: 7, color: 'black', index: 1, at },
          { row: 7, col: 7, color: 'white', index: 2, at },
        ],
        commentary: [],
      }),
    );

    const response = await get(
      '/api/archive/r11__11111111-1111-4111-8111-111111111111/replay',
    );
    expect(response.status).toBe(500);
    const payload = (await response.json()) as ErrorResponse;
    expect(payload.error?.code).toBe('REPLAY_FAILED');
    expect(payload.error?.message).toContain('move 2');
  });

  it('R12: an oversized history is refused, never truncated', async () => {
    const state = startGame(
      { roomId: 'r12', version: 0 },
      { black: { kind: 'human' }, white: { kind: 'agent' } },
      { gameId: '22222222-2222-4222-8222-222222222222' },
    );
    const history = Array.from({ length: 1001 }, (_, i) => ({
      row: 0,
      col: 0,
      color: 'black',
      index: i + 1,
      at: '2026-10-26T08:00:00.000Z',
    }));
    writeFileSync(
      path.join(httpDir, 'archive', 'r12__22222222-2222-4222-8222-222222222222.json'),
      JSON.stringify({ id: 'r12', state, history, commentary: [] }),
    );
    await expectError(
      '/api/archive/r12__22222222-2222-4222-8222-222222222222/replay',
      400,
      'REPLAY_TOO_LONG',
    );
  });

  it('R13: the old room endpoint kept its exact shape', async () => {
    const response = await get('/api/rooms/r1');
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'commentary',
      'history',
      'participants',
      'phase',
      'state',
    ]);
  });

  it('RE: a started game with zero moves replays as the opening alone', async () => {
    const room = manager.create('re-zero');
    room.newGame(); // playing, but no moves yet
    const payload = await getJson<any>('/api/rooms/re-zero/replay');
    expect(payload.frames).toHaveLength(1);
    expect(payload.frames[0].move).toBeNull();
    expect(payload.frames[0].state.moveCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Archive listing details, straight against the repository.
// ---------------------------------------------------------------------------

describe('archive listing', () => {
  it('orders by playedAt descending and reads judgements off the state', () => {
    const dir = freshDir();
    const repo = new FileRoomRepository(dir);
    const older = startGame(
      { roomId: 'list', version: 0 },
      { black: { kind: 'human' }, white: { kind: 'agent' } },
      { gameId: '33333333-3333-4333-8333-333333333331' },
    );
    const newer = startGame(
      { roomId: 'list', version: 0 },
      { black: { kind: 'agent' }, white: { kind: 'human' } },
      { gameId: '33333333-3333-4333-8333-333333333332' },
    );
    writeFileSync(
      path.join(dir, 'archive', 'list__33333333-3333-4333-8333-333333333331.json'),
      JSON.stringify({
        id: 'list',
        state: { ...older, winner: 'black', endReason: 'resign', moveCount: 9 },
        history: [
          { row: 0, col: 0, color: 'black', index: 9, at: '2026-01-01T00:00:00.000Z' },
        ],
        commentary: [],
      }),
    );
    writeFileSync(
      path.join(dir, 'archive', 'list__33333333-3333-4333-8333-333333333332.json'),
      JSON.stringify({
        id: 'list',
        state: { ...newer, winner: 'white', endReason: 'five', moveCount: 3 },
        history: [
          { row: 0, col: 0, color: 'black', index: 3, at: '2026-01-02T00:00:00.000Z' },
        ],
        commentary: [],
      }),
    );

    const summaries = repo.listArchives();
    expect(summaries.map((summary) => summary.gameId)).toEqual([
      '33333333-3333-4333-8333-333333333332',
      '33333333-3333-4333-8333-333333333331',
    ]);
    expect(summaries[0]).toMatchObject({
      archiveId: 'list__33333333-3333-4333-8333-333333333332',
      roomId: 'list',
      game: 'gomoku',
      winner: 'white',
      endReason: 'five',
      moveCount: 3,
      playedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('skips a corrupt archive file in listings and leaves it on disk', () => {
    const dir = freshDir();
    const repo = new FileRoomRepository(dir);
    const corrupt = path.join(dir, 'archive', 'corrupt__bad.json');
    writeFileSync(corrupt, '{not json');

    expect(repo.listArchives()).toEqual([]);
    expect(readdirSync(path.join(dir, 'archive'))).toContain('corrupt__bad.json');
    expect(repo.loadArchive('corrupt__bad')).toBeNull();
  });

  it('config: ARENA_ARCHIVE_LIMIT defaults to 20 and clamps into 1–500', () => {
    expect(loadConfig({}).archiveLimit).toBe(20);
    expect(loadConfig({ ARENA_ARCHIVE_LIMIT: '0' }).archiveLimit).toBe(1);
    expect(loadConfig({ ARENA_ARCHIVE_LIMIT: '9999' }).archiveLimit).toBe(500);
    expect(loadConfig({ ARENA_ARCHIVE_LIMIT: '3' }).archiveLimit).toBe(3);
    expect(() => loadConfig({ ARENA_ARCHIVE_LIMIT: 'many' })).toThrow();
  });
});
