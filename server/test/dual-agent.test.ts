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
});
