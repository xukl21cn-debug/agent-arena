import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  ParticipantView,
  RoomView,
  ServerMessage,
} from '@arena/shared';import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { PresenceRegistry } from '../src/game/rooms/presence';
import { attachWebSocket } from '../src/ws';
import { MemoryRoomRepository } from '../src/game/rooms/repository';
import { RoomManager } from '../src/game/rooms/room-manager';

let server: Server;
let wss: WebSocketServer;
let baseUrl: string;
let wsUrl: string;
let presence: PresenceRegistry;

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

async function readParticipants(): Promise<ParticipantView[]> {
  const response = await fetch(`${baseUrl}/api/rooms/default`);
  const view = (await response.json()) as RoomView;
  return view.participants;
}

function presenceOf(
  participants: ParticipantView[],
  seat: 'black' | 'white',
): string | undefined {
  return participants.find((item) => item.seat === seat)?.presence;
}

beforeAll(async () => {
  presence = new PresenceRegistry();
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

describe('presence over the wire', () => {
  it('starts with both seats unknown and no agent attached', async () => {
    const participants = await readParticipants();
    expect(participants).toHaveLength(2);
    expect(presenceOf(participants, 'black')).toBe('unknown');
    expect(presenceOf(participants, 'white')).toBe('unknown');
  });

  it('marks the human seat idle while a browser socket watches', async () => {
    const socket = new WebSocket(`${wsUrl}/ws?roomId=default`);
    const messages: ServerMessage[] = [];
    socket.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()) as ServerMessage);
    });

    await waitUntil(
      () => messages.some((message) => message.type === 'hello'),
    );

    const hello = messages.find(
      // `participants` picks the game hello — chat rooms greet with a room
      // snapshot instead and never reach this socket anyway.
      (message): message is Extract<
        ServerMessage,
        { type: 'hello'; participants: ParticipantView[] }
      > => message.type === 'hello' && 'participants' in message,
    );
    // hello carries presence, so the first paint already knows the seats.
    expect(presenceOf(hello?.participants ?? [], 'black')).toBe('idle');

    await waitUntil(async () => {
      const participants = await readParticipants();
      return presenceOf(participants, 'black') === 'idle';
    });

    socket.close();
  });

  it('shows the agent seat waiting while its long-poll is parked', async () => {
    // Drive a real MCP session so the seat is bound to an actual session id.
    const client = new Client({ name: 'test-agent', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/game/mcp`),
    );
    await client.connect(transport);

    try {
      await client.callTool({
        name: 'new_game',
        arguments: { roomId: 'default', agentColor: 'white' },
      });

      await waitUntil(async () => {
        const participants = await readParticipants();
        return presenceOf(participants, 'white') === 'idle';
      });

      // Park a wait in the background: while it hangs, presence must read
      // `waiting`, which is the whole point of the signal.
      const pending = client.callTool({
        name: 'wait_for_turn',
        arguments: { roomId: 'default', timeoutMs: 2_000 },
      });
      // Closing the client mid-request rejects the SDK's own promise chain;
      // keep that from surfacing as an unhandled rejection in the runner.
      pending.catch(() => {});

      await waitUntil(async () => {
        const participants = await readParticipants();
        return presenceOf(participants, 'white') === 'waiting';
      });

      const participants = await readParticipants();
      const agent = participants.find((item) => item.seat === 'white');
      expect(agent?.waiting).toBe(true);
      expect(agent?.client).toBe('test-agent');

      await pending.catch(() => undefined);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('reports thinking for the agent seat while it is the agent turn', async () => {
    const client = new Client({ name: 'turn-agent', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/game/mcp`),
    );
    await client.connect(transport);

    try {
      // Agent takes black so it moves first, then waits: it is on turn.
      await client.callTool({
        name: 'new_game',
        arguments: { roomId: 'default', agentColor: 'black' },
      });

      await waitUntil(async () => {
        const participants = await readParticipants();
        return presenceOf(participants, 'black') === 'thinking';
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

/**
 * REST-only participants must count as present after their own successful
 * mutations. The identity can arrive either in `X-Arena-Participant` or in the
 * body `participantId`; a rejected request must not touch any seat.
 */
describe('REST participant presence', () => {
  async function createRoom(roomId: string): Promise<void> {
    const response = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId }),
    });
    expect(response.status).toBe(201);
  }

  async function joinAgent(
    roomId: string,
    seat: 'black' | 'white',
  ): Promise<string> {
    const response = await fetch(`${baseUrl}/api/rooms/${roomId}/participants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'agent', seat, name: `rest-agent-${seat}` }),
    });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { participantId: string };
    return payload.participantId;
  }

  async function restPost(
    roomId: string,
    action: string,
    body: Record<string, unknown> = {},
    participantId?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (participantId !== undefined) {
      headers['x-arena-participant'] = participantId;
    }
    return fetch(`${baseUrl}/api/rooms/${roomId}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  async function view(roomId: string): Promise<RoomView> {
    return (await (await fetch(`${baseUrl}/api/rooms/${roomId}`)).json()) as RoomView;
  }

  function seatOf(
    participants: ParticipantView[],
    seat: 'black' | 'white',
  ): ParticipantView | undefined {
    return participants.find((item) => item.seat === seat);
  }

  const tick = (ms = 20): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it('join and ready refresh the REST participant seat', async () => {
    await createRoom('presence-rest-join');
    const participantId = await joinAgent('presence-rest-join', 'black');

    let black = seatOf((await view('presence-rest-join')).participants, 'black');
    expect(black?.presence).toBe('idle');
    expect(black?.lastSeenAt).toEqual(expect.any(Number));
    const afterJoin = black!.lastSeenAt!;

    await tick();
    const ready = await restPost('presence-rest-join', 'ready', {
      participantId,
      ready: true,
    });
    expect(ready.status).toBe(200);

    black = seatOf((await view('presence-rest-join')).participants, 'black');
    expect(black?.presence).toBe('idle');
    expect(black!.lastSeenAt!).toBeGreaterThan(afterJoin);
  });

  it('move with header or body participantId refreshes presence', async () => {
    for (const mode of ['header', 'body'] as const) {
      const roomId = `presence-rest-move-${mode}`;
      await createRoom(roomId);
      const participantId = await joinAgent(roomId, 'black');
      expect((await restPost(roomId, 'games', { agentColor: 'black' })).status).toBe(200);

      // Starting a game rebinds seats: the join stamp was cleared because the
      // seat has no session, which is exactly the REST-only situation.
      let black = seatOf((await view(roomId)).participants, 'black');
      expect(black?.presence).toBe('unknown');

      await tick();
      const moved =
        mode === 'header'
          ? await restPost(roomId, 'moves', { row: 7, col: 7 }, participantId)
          : await restPost(roomId, 'moves', { row: 7, col: 7, participantId });
      expect(moved.status).toBe(200);

      black = seatOf((await view(roomId)).participants, 'black');
      expect(black?.presence).toBe('idle');
      expect(black?.lastSeenAt).toEqual(expect.any(Number));
    }
  });

  it('pass refreshes presence in a Go room', async () => {
    await createRoom('presence-rest-pass');
    const participantId = await joinAgent('presence-rest-pass', 'white');
    expect(
      (await restPost('presence-rest-pass', 'games', { game: 'go', agentColor: 'white' })).status,
    ).toBe(200);
    expect((await restPost('presence-rest-pass', 'moves', { row: 0, col: 0 })).status).toBe(200);

    await tick();
    const passed = await restPost(
      'presence-rest-pass',
      'pass',
      { participantId },
    );
    expect(passed.status).toBe(200);

    const white = seatOf((await view('presence-rest-pass')).participants, 'white');
    expect(white?.presence).toBe('idle');
    expect(white?.lastSeenAt).toEqual(expect.any(Number));
  });

  it('resign refreshes presence', async () => {
    await createRoom('presence-rest-resign');
    const participantId = await joinAgent('presence-rest-resign', 'white');
    expect(
      (await restPost('presence-rest-resign', 'games', { agentColor: 'white' })).status,
    ).toBe(200);
    expect((await restPost('presence-rest-resign', 'moves', { row: 7, col: 7 })).status).toBe(200);

    await tick();
    const resigned = await restPost(
      'presence-rest-resign',
      'resign',
      { participantId },
    );
    expect(resigned.status).toBe(200);

    const white = seatOf(
      (await view('presence-rest-resign')).participants,
      'white',
    );
    expect(white?.presence).toBe('idle');
    expect(white?.lastSeenAt).toEqual(expect.any(Number));
  });

  it('dead-stones, score confirm and score resume each refresh presence', async () => {
    await createRoom('presence-rest-score');
    const participantId = await joinAgent('presence-rest-score', 'white');
    expect(
      (await restPost('presence-rest-score', 'games', { game: 'go', agentColor: 'white' })).status,
    ).toBe(200);
    expect((await restPost('presence-rest-score', 'moves', { row: 0, col: 0 })).status).toBe(200);
    expect(
      (await restPost('presence-rest-score', 'moves', { row: 8, col: 8, participantId })).status,
    ).toBe(200);
    expect((await restPost('presence-rest-score', 'pass', { actor: 'human' })).status).toBe(200);
    expect((await restPost('presence-rest-score', 'pass', { participantId })).status).toBe(200);
    expect((await view('presence-rest-score')).state.status).toBe('scoring');

    let white = seatOf((await view('presence-rest-score')).participants, 'white');
    const afterPass = white!.lastSeenAt!;
    await tick();

    const marked = await restPost('presence-rest-score', 'dead-stones', {
      row: 0,
      col: 0,
      participantId,
    });
    expect(marked.status).toBe(200);
    white = seatOf((await view('presence-rest-score')).participants, 'white');
    expect(white!.lastSeenAt!).toBeGreaterThan(afterPass);
    const afterMark = white!.lastSeenAt!;

    await tick();
    const confirmed = await restPost('presence-rest-score', 'score/confirm', {
      participantId,
    });
    expect(confirmed.status).toBe(200);
    white = seatOf((await view('presence-rest-score')).participants, 'white');
    expect(white!.lastSeenAt!).toBeGreaterThan(afterMark);
    const afterConfirm = white!.lastSeenAt!;

    await tick();
    const resumed = await restPost('presence-rest-score', 'score/resume', {
      participantId,
    });
    expect(resumed.status).toBe(200);
    white = seatOf((await view('presence-rest-score')).participants, 'white');
    expect(white!.lastSeenAt!).toBeGreaterThan(afterConfirm);
  });

  it('failed requests do not touch any seat', async () => {
    await createRoom('presence-rest-ambiguous');
    await joinAgent('presence-rest-ambiguous', 'black');
    await joinAgent('presence-rest-ambiguous', 'white');
    const beforeAmbiguous = (await view('presence-rest-ambiguous')).participants;
    const ambiguous = await restPost('presence-rest-ambiguous', 'moves', {
      actor: 'agent',
      row: 7,
      col: 7,
    });
    expect(ambiguous.status).toBe(409);
    expect(((await ambiguous.json()) as any).error.code).toBe('AMBIGUOUS_ACTOR');
    const afterAmbiguous = (await view('presence-rest-ambiguous')).participants;
    expect(seatOf(afterAmbiguous, 'black')?.lastSeenAt).toBe(
      seatOf(beforeAmbiguous, 'black')?.lastSeenAt,
    );
    expect(seatOf(afterAmbiguous, 'white')?.lastSeenAt).toBe(
      seatOf(beforeAmbiguous, 'white')?.lastSeenAt,
    );

    await createRoom('presence-rest-noturn');
    const blackId = await joinAgent('presence-rest-noturn', 'black');
    await joinAgent('presence-rest-noturn', 'white');
    expect(
      (await restPost('presence-rest-noturn', 'games', { agentColor: 'black' })).status,
    ).toBe(200);
    expect(
      (await restPost('presence-rest-noturn', 'moves', { row: 7, col: 7 }, blackId)).status,
    ).toBe(200);

    const beforeNotTurn = (await view('presence-rest-noturn')).participants;
    await tick();
    const notTurn = await restPost(
      'presence-rest-noturn',
      'moves',
      { row: 8, col: 8 },
      blackId,
    );
    expect(notTurn.status).toBe(409);
    expect(((await notTurn.json()) as any).error.code).toBe('NOT_YOUR_TURN');
    const afterNotTurn = (await view('presence-rest-noturn')).participants;
    expect(seatOf(afterNotTurn, 'black')?.lastSeenAt).toBe(
      seatOf(beforeNotTurn, 'black')?.lastSeenAt,
    );
    expect(seatOf(afterNotTurn, 'white')?.lastSeenAt).toBe(
      seatOf(beforeNotTurn, 'white')?.lastSeenAt,
    );
  });
});
