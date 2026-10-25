import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { ServerMessage } from '@arena/shared';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { PresenceRegistry } from '../src/core/presence';
import { attachWebSocket } from '../src/http/ws';
import { GameRoom } from '../src/rooms/room';
import { MemoryRoomRepository } from '../src/rooms/repository';
import { RoomManager } from '../src/rooms/room-manager';

/**
 * P1c: the lobby. The phase machine is derived, never stored, so these tests
 * drive it through its public surface — join, setReady, newGame — and read
 * the phase back the way clients do.
 */
describe('room phase (lobby/waiting/playing)', () => {
  // R5 first, on purpose: it is the compatibility contract. If this one
  // breaks, every existing script, the duel runner and the REST clients are
  // already broken — the rest of the file is meaningless.
  it('R5: the legacy new_game path still starts immediately', () => {
    const room = new GameRoom('r5');
    expect(room.getPhase()).toBe('lobby');

    const state = room.newGame();
    expect(state.status).toBe('playing');
    expect(room.getPhase()).toBe('playing');
    expect(room.getView().phase).toBe('playing');
    expect(room.getSummary().phase).toBe('playing');
  });

  it('R5b: a legacy start marks seated participants ready', () => {
    const room = new GameRoom('r5b');
    room.join({ name: 'a', kind: 'agent', seat: 'black' });
    room.join({ name: 'h', kind: 'human', seat: 'white' });
    room.newGame();
    // A game in progress must not read as "still gathering".
    expect(room.getRoster().every((participant) => participant.ready)).toBe(
      true,
    );
  });

  it('R1: a fresh room is in the lobby', () => {
    const room = new GameRoom('r1');
    expect(room.getPhase()).toBe('lobby');
    expect(room.getView().phase).toBe('lobby');
  });

  it('R2: one ready voice moves the room to waiting', () => {
    const room = new GameRoom('r2');
    const a = room.join({ name: 'a', kind: 'agent', seat: 'black' });
    room.join({ name: 'b', kind: 'agent', seat: 'white' });

    const result = room.setReady(a.id, true);
    expect(result.ok).toBe(true);
    expect(room.getPhase()).toBe('waiting');
  });

  it('R2b: even alone, a ready participant means waiting', () => {
    const room = new GameRoom('r2b');
    room.join({ name: 'solo', kind: 'agent', seat: 'black', ready: true });
    expect(room.getPhase()).toBe('waiting');
  });

  it('R3: both sides ready starts the game from the roster seats', () => {
    const room = new GameRoom('r3');
    const a = room.join({ name: 'dsh', kind: 'agent', seat: 'black' });
    const b = room.join({ name: 'codex', kind: 'agent', seat: 'white' });

    room.setReady(a.id, true);
    expect(room.getPhase()).toBe('waiting');

    room.setReady(b.id, true);
    expect(room.getPhase()).toBe('playing');
    expect(room.getState().status).toBe('playing');
    // The started game keeps the identities the lobby gathered.
    expect(room.getState().seats.black.name).toBe('dsh');
    expect(room.getState().seats.white.name).toBe('codex');
  });

  it('R3b: a second join carrying ready=true starts the game', () => {
    const room = new GameRoom('r3b');
    room.join({ name: 'x', kind: 'agent', seat: 'black', ready: true });
    expect(room.getPhase()).toBe('waiting');

    room.join({ name: 'y', kind: 'agent', seat: 'white', ready: true });
    expect(room.getPhase()).toBe('playing');
  });

  it('R4: cancelling ready falls back to lobby when nobody else is ready', () => {
    const room = new GameRoom('r4');
    const a = room.join({ name: 'a', kind: 'agent', seat: 'black' });

    room.setReady(a.id, true);
    expect(room.getPhase()).toBe('waiting');

    room.setReady(a.id, false);
    expect(room.getPhase()).toBe('lobby');
  });

  it('ready during a running game is an idempotent no-op', () => {
    const room = new GameRoom('r4b');
    const a = room.join({ name: 'a', kind: 'agent', seat: 'black' });
    room.join({ name: 'b', kind: 'agent', seat: 'white' });
    room.newGame();

    const result = room.setReady(a.id, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.phase).toBe('playing');
    }
    // The flag itself is untouched: a running game has no gathering state.
    expect(room.getRoster().every((participant) => participant.ready)).toBe(
      true,
    );
  });

  it('reports an unknown participant on setReady', () => {
    const room = new GameRoom('r4c');
    const result = room.setReady('p_nope00', true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PARTICIPANT_NOT_FOUND');
    }
  });

  it('R6: views carry the phase and per-seat ready flags', () => {
    const room = new GameRoom('r6');
    const a = room.join({ name: 'a', kind: 'agent', seat: 'black' });
    room.join({ name: 'b', kind: 'agent', seat: 'white' });
    room.setReady(a.id, true);

    const view = room.getView();
    expect(view.phase).toBe('waiting');
    const black = view.participants.find((p) => p.seat === 'black');
    const white = view.participants.find((p) => p.seat === 'white');
    expect(black?.ready).toBe(true);
    expect(white?.ready).toBe(false);
  });
});

// ------------------------------------------------------------------ wire

let server: Server;
let wss: WebSocketServer;
let baseUrl: string;
let wsUrl: string;

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error('condition was not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  const presence = new PresenceRegistry();
  const manager = new RoomManager({
    repository: new MemoryRoomRepository(),
    presence,
  });
  manager.initializeDefaultRoom();

  server = createServer(createApp(manager, loadConfig({})));
  wss = attachWebSocket(server, manager, { presence });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  wsUrl = `ws://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const socket of wss.clients) {
    socket.terminate();
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('lobby over HTTP and WS', () => {
  it('POST /ready seats the web human and reports the phase', async () => {
    const created = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'lobbyrest' }),
    });
    expect(created.status).toBe(201);

    const response = await fetch(`${baseUrl}/api/rooms/lobbyrest/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ready: true }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      phase: string;
      state: { status: string };
      participants: Array<{ seat: string; ready?: boolean }>;
    };
    expect(payload.phase).toBe('waiting');
    expect(payload.state.status).toBe('idle');
    // The human never joined through any API; ready seats them at the human
    // seat on first press.
    const human = payload.participants.find((p) => p.seat === 'black');
    expect(human?.ready).toBe(true);
  });

  it('R7: a watcher receives phase events as the room gathers and starts', async () => {
    const created = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'r7room' }),
    });
    expect(created.status).toBe(201);

    const socket = new WebSocket(`${wsUrl}/ws?roomId=r7room`);
    const messages: ServerMessage[] = [];
    socket.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()) as ServerMessage);
    });

    await waitUntil(() => messages.some((message) => message.type === 'hello'));
    const hello = messages.find((message) => message.type === 'hello');
    expect(hello).toMatchObject({ type: 'hello', phase: 'lobby' });

    // Human readies (auto-seated at the human seat) → waiting.
    const readyHuman = await fetch(`${baseUrl}/api/rooms/r7room/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ready: true }),
    });
    expect(readyHuman.ok).toBe(true);

    // Agent joins the white seat, then readies → the game starts.
    const join = await fetch(`${baseUrl}/api/rooms/r7room/participants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'agent', name: 'late-agent', seat: 'white' }),
    });
    const joined = (await join.json()) as { participantId: string };
    await fetch(`${baseUrl}/api/rooms/r7room/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantId: joined.participantId, ready: true }),
    });

    await waitUntil(() =>
      messages.some(
        (message) => message.type === 'phase' && message.phase === 'playing',
      ),
    );
    const phases = messages
      .filter(
        (message): message is Extract<ServerMessage, { type: 'phase' }> =>
          message.type === 'phase',
      )
      .map((message) => message.phase);
    expect(phases).toContain('waiting');
    expect(phases).toContain('playing');

    socket.close();
  });
});
