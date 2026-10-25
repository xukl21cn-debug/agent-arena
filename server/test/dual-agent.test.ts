import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { PresenceRegistry } from '../src/core/presence';
import { MemoryRoomRepository } from '../src/rooms/repository';
import { RoomManager } from '../src/rooms/room-manager';

let server: Server;
let baseUrl: string;

type ToolPayload = Record<string, any>;

function payloadOf(result: Awaited<ReturnType<Client['callTool']>>): ToolPayload {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === 'text')?.text;
  if (!text) {
    throw new Error('tool returned no text content');
  }
  return JSON.parse(text) as ToolPayload;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolPayload> {
  return payloadOf(await client.callTool({ name, arguments: args }));
}

async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: '0.0.1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)),
  );
  return client;
}

beforeAll(async () => {
  const presence = new PresenceRegistry();
  const manager = new RoomManager({
    repository: new MemoryRoomRepository(),
    presence,
  });
  manager.initializeDefaultRoom();

  server = createServer(createApp(manager, loadConfig({})));
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
});

describe('two agents in one room', () => {
  it('lets each agent join a different color and move its own stones', async () => {
    // The capability the seat-keyed model could not express: both seats say
    // `agent`, and each session still moves only its own color.
    const black = await connect('agent-black');
    const white = await connect('agent-white');

    try {
      const blackJoin = await call(black, 'join_game', {
        roomId: 'duo',
        name: 'dsh',
        seat: 'black',
      });
      expect(blackJoin.participantId).toMatch(/^p_/);
      expect(blackJoin.seat).toBe('black');

      const whiteJoin = await call(white, 'join_game', {
        roomId: 'duo',
        name: 'codex',
        seat: 'white',
      });
      expect(whiteJoin.seat).toBe('white');
      expect(whiteJoin.participantId).not.toBe(blackJoin.participantId);

      // Both see each other.
      expect(whiteJoin.participants).toHaveLength(2);
      const names = whiteJoin.participants.map((p: { name: string }) => p.name);
      expect(names.sort()).toEqual(['codex', 'dsh']);

      // Start a game; black moves first. Seats come from the roster, so both
      // agents keep the identity they joined with.
      await call(black, 'new_game', { roomId: 'duo', agentColor: 'black' });

      // place_stone returns { ok, state }.
      const blackMove = await call(black, 'place_stone', {
        roomId: 'duo',
        row: 7,
        col: 7,
      });
      expect(blackMove.ok).toBe(true);
      expect(blackMove.state.boardText).toContain('x');

      const whiteMove = await call(white, 'place_stone', {
        roomId: 'duo',
        row: 8,
        col: 8,
      });
      expect(whiteMove.ok).toBe(true);
      expect(whiteMove.state.boardText).toContain('o');
      expect(whiteMove.state.moveCount).toBe(2);

      // Each stone landed in its own color, and the seats kept their identity
      // through new_game.
      const state = await call(black, 'get_state', { roomId: 'duo' });
      expect(state.state.seats.black.name).toBe('dsh');
      expect(state.state.seats.white.name).toBe('codex');

      // The rendered RoomView names both participants, so the UI can tell the
      // two agents apart: ids differ and match what join_game handed out.
      const response = await fetch(`${baseUrl}/api/rooms/duo`);
      const view = (await response.json()) as {
        participants: Array<{ seat: string; participantId?: string }>;
      };
      const ids = Object.fromEntries(
        view.participants.map((item) => [item.seat, item.participantId]),
      );
      expect(ids.black).toBe(blackJoin.participantId);
      expect(ids.white).toBe(whiteJoin.participantId);
    } finally {
      await black.close().catch(() => undefined);
      await white.close().catch(() => undefined);
    }
  });

  it('reconnects to the same participant when the name repeats', async () => {
    const first = await connect('reconnect-a');
    const joined = await call(first, 'join_game', {
      roomId: 'rejoin',
      name: 'steady',
      seat: 'black',
    });
    await first.close().catch(() => undefined);

    const second = await connect('reconnect-b');
    try {
      const again = await call(second, 'join_game', {
        roomId: 'rejoin',
        name: 'steady',
        seat: 'black',
      });
      // Same identity, so the seat and history survive the reconnect.
      expect(again.participantId).toBe(joined.participantId);
      expect(again.participants).toHaveLength(1);
    } finally {
      await second.close().catch(() => undefined);
    }
  });

  it('frees the seat when an agent leaves', async () => {
    const client = await connect('leaver');
    try {
      await call(client, 'join_game', {
        roomId: 'leaving',
        name: 'temp',
        seat: 'white',
      });
      const left = await call(client, 'leave_room', { roomId: 'leaving' });
      expect(left.ok).toBe(true);

      const state = await call(client, 'get_state', { roomId: 'leaving' });
      expect(state.state.seats.white.id).toBeUndefined();
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('reports each agent its own color from get_state and say', async () => {
    // Regression: get_state / say / new_game answered `yourColor` with
    // `getAgentSeat()`, which returns the *first* agent seat. With two agents
    // the white one was told it played black — and its presence got attached
    // to the black seat, so the black tab showed the white agent's client.
    const black = await connect('color-black');
    const white = await connect('color-white');

    try {
      await call(black, 'join_game', { roomId: 'colors', name: 'b', seat: 'black' });
      await call(white, 'join_game', { roomId: 'colors', name: 'w', seat: 'white' });
      await call(black, 'new_game', { roomId: 'colors', agentColor: 'black' });

      const blackState = await call(black, 'get_state', { roomId: 'colors' });
      expect(blackState.yourColor).toBe('black');

      const whiteState = await call(white, 'get_state', { roomId: 'colors' });
      expect(whiteState.yourColor).toBe('white');

      // The white agent speaking must not rebrand the black seat's presence.
      await call(white, 'say', {
        roomId: 'colors',
        text: 'hi',
        kind: 'banter',
      });
      const room = await fetch(`${baseUrl}/api/rooms/colors`).then((res) =>
        res.json(),
      );
      const bySeat = Object.fromEntries(
        (room.participants as Array<Record<string, any>>).map((item) => [
          item.seat,
          item,
        ]),
      );
      expect(bySeat.black.client).toBe('color-black');
      expect(bySeat.white.client).toBe('color-white');
    } finally {
      await black.close().catch(() => undefined);
      await white.close().catch(() => undefined);
    }
  });

  it('routes wait_for_turn to the caller seat, not "the agent seat"', async () => {
    const black = await connect('waiter-black');
    const white = await connect('waiter-white');

    try {
      await call(black, 'join_game', {
        roomId: 'waiters',
        name: 'b',
        seat: 'black',
      });
      await call(white, 'join_game', {
        roomId: 'waiters',
        name: 'w',
        seat: 'white',
      });
      await call(black, 'new_game', { roomId: 'waiters', agentColor: 'black' });

      // Black is to move, so black returns immediately; white parks.
      const blackWait = await call(black, 'wait_for_turn', {
        roomId: 'waiters',
        timeoutMs: 1_000,
      });
      expect(blackWait.reason).toBe('your_turn');
      expect(blackWait.yourColor).toBe('black');

      const whiteWait = await call(white, 'wait_for_turn', {
        roomId: 'waiters',
        timeoutMs: 1_000,
      });
      // White is not to move and nothing changed, so it times out.
      expect(whiteWait.reason).toBe('timeout');
      expect(whiteWait.yourColor).toBe('white');
    } finally {
      await black.close().catch(() => undefined);
      await white.close().catch(() => undefined);
    }
  });

  it('runs the Go scoring flow across two real sessions', async () => {
    // The scoring phase has no turn order: both sessions must be answered by
    // their OWN confirmation state, not by turn order. Single-session tests
    // cannot catch a seat mix-up here — this is the P2 lesson applied to M3.
    const black = await connect('scoring-black');
    const white = await connect('scoring-white');

    try {
      await call(black, 'join_game', {
        roomId: 'go-duo',
        name: 'b',
        seat: 'black',
      });
      await call(white, 'join_game', {
        roomId: 'go-duo',
        name: 'w',
        seat: 'white',
      });
      const started = await call(black, 'new_game', {
        roomId: 'go-duo',
        game: 'go',
        agentColor: 'black',
      });
      expect(started.state.game).toBe('go');

      // A stone each, then two passes move the game to scoring.
      await call(black, 'place_stone', { roomId: 'go-duo', row: 4, col: 4 });
      await call(white, 'place_stone', { roomId: 'go-duo', row: 2, col: 2 });
      await call(black, 'pass', { roomId: 'go-duo' });
      const afterPasses = await call(white, 'pass', { roomId: 'go-duo' });
      expect(afterPasses.state.status).toBe('scoring');

      // Both seats are asked to act, regardless of turn order (black passed
      // first, so turn points at black — white must still be asked too).
      const blackWait = await call(black, 'wait_for_turn', {
        roomId: 'go-duo',
        timeoutMs: 1_000,
      });
      expect(blackWait.reason).toBe('scoring');
      expect(blackWait.yourColor).toBe('black');

      const whiteWait = await call(white, 'wait_for_turn', {
        roomId: 'go-duo',
        timeoutMs: 1_000,
      });
      expect(whiteWait.reason).toBe('scoring');
      expect(whiteWait.yourColor).toBe('white');

      // Black marks white's stone dead; both confirm. Black first: its own
      // second wait would park — white confirms and finishes the game.
      const marked = await call(black, 'mark_dead', {
        roomId: 'go-duo',
        row: 2,
        col: 2,
      });
      expect(marked.state.deadStones).toEqual([{ row: 2, col: 2 }]);
      expect(marked.state.scorePreview).not.toBeNull();

      await call(black, 'confirm_score', { roomId: 'go-duo' });
      const finished = await call(white, 'confirm_score', {
        roomId: 'go-duo',
      });
      expect(finished.state.status).toBe('finished');
      expect(finished.state.endReason).toBe('scored');
      expect(finished.state.score.winner).toBe('black');
      expect(finished.state.deadStones).toEqual([{ row: 2, col: 2 }]);

      // A parked wait on the finished game answers game_over, per seat.
      const over = await call(black, 'wait_for_turn', {
        roomId: 'go-duo',
        timeoutMs: 1_000,
      });
      expect(over.reason).toBe('game_over');
      expect(over.yourColor).toBe('black');
    } finally {
      await black.close().catch(() => undefined);
      await white.close().catch(() => undefined);
    }
  });

  it('exposes the scoring endpoints over REST', async () => {
    const post = async (
      path: string,
      body: Record<string, unknown>,
    ): Promise<Record<string, any>> => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as Record<string, any>;
      if (!response.ok) {
        throw new Error(`${path} -> ${response.status} ${JSON.stringify(payload)}`);
      }
      return payload;
    };

    await post('/api/rooms', { roomId: 'go-rest' });
    await post('/api/rooms/go-rest/games', { game: 'go' });
    await post('/api/rooms/go-rest/moves', { row: 4, col: 4, actor: 'human' });
    await post('/api/rooms/go-rest/moves', { row: 2, col: 2, actor: 'agent' });
    const firstPass = await post('/api/rooms/go-rest/pass', { actor: 'human' });
    expect(firstPass.state.status).toBe('playing');
    const secondPass = await post('/api/rooms/go-rest/pass', { actor: 'agent' });
    expect(secondPass.state.status).toBe('scoring');

    const marked = await post('/api/rooms/go-rest/dead-stones', {
      row: 2,
      col: 2,
      actor: 'human',
    });
    expect(marked.state.deadStones).toEqual([{ row: 2, col: 2 }]);

    // An empty point is an INVALID_DEAD_STONE while scoring.
    const invalid = await fetch(`${baseUrl}/api/rooms/go-rest/dead-stones`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ row: 8, col: 8, actor: 'human' }),
    });
    expect(invalid.status).toBe(400);
    const invalidPayload = (await invalid.json()) as {
      error: { code: string };
    };
    expect(invalidPayload.error.code).toBe('INVALID_DEAD_STONE');

    // The confirmations are per seat: one leaves the game scoring, both
    // finish it.
    const oneConfirm = await post('/api/rooms/go-rest/score/confirm', {
      actor: 'human',
    });
    expect(oneConfirm.state.status).toBe('scoring');

    const bothConfirm = await post('/api/rooms/go-rest/score/confirm', {
      actor: 'agent',
    });
    expect(bothConfirm.state.status).toBe('finished');
    expect(bothConfirm.state.endReason).toBe('scored');
    expect(bothConfirm.state.score.winner).toBe('black');

    // Scoring-only actions answer NOT_SCORING on a finished game, with the
    // state riding along for the caller's view.
    const resume = await fetch(`${baseUrl}/api/rooms/go-rest/score/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'human' }),
    });
    expect(resume.status).toBe(400);
  });
});
