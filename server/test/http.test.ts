import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  ErrorResponse,
  ServerMessage,
  WaitForTurnResponse,
} from '@arena/shared';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { attachWebSocket } from '../src/http/ws';
import { MemoryRoomRepository } from '../src/rooms/repository';
import { RoomManager } from '../src/rooms/room-manager';

let server: Server;
let wss: WebSocketServer;
let baseUrl: string;
let wsUrl: string;

const TOOL_NAMES = [
  'confirm_score',
  'get_state',
  'join_game',
  'leave_room',
  'mark_dead',
  'new_game',
  'pass',
  'place_stone',
  'resign',
  'resume_play',
  'say',
  'wait_for_turn',
];

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition was not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type ToolPayload = Record<string, any>;

function toolPayload(result: Awaited<ReturnType<Client['callTool']>>): ToolPayload {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === 'text')?.text;
  if (!text) {
    throw new Error('tool returned no text content');
  }
  return JSON.parse(text) as ToolPayload;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolPayload> {
  return toolPayload(await client.callTool({ name, arguments: args }));
}

beforeAll(async () => {
  const manager = new RoomManager({
    repository: new MemoryRoomRepository(),
  });
  manager.initializeDefaultRoom();

  server = createServer(createApp(manager, loadConfig({})));
  wss = attachWebSocket(server, manager);

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

describe('REST API', () => {
  it('serves health and validates rooms, moves and commentary', async () => {
    const health = await get('/api/health');
    expect(health.status).toBe(200);
    expect(await readJson(health)).toEqual({ ok: true });

    const rooms = await get('/api/rooms');
    expect(await readJson(rooms)).toMatchObject([{ roomId: 'default' }]);

    const missing = await get('/api/rooms/nope');
    expect(missing.status).toBe(404);
    expect(await readJson<ErrorResponse>(missing)).toMatchObject({
      error: { code: 'ROOM_NOT_FOUND' },
    });

    const duplicate = await post('/api/rooms', { roomId: 'default' });
    expect(duplicate.status).toBe(409);
    expect(await readJson<ErrorResponse>(duplicate)).toMatchObject({
      error: { code: 'ROOM_EXISTS' },
    });

    const badRoomId = await post('/api/rooms', { roomId: 'bad id!' });
    expect(badRoomId.status).toBe(400);
    expect(await readJson<ErrorResponse>(badRoomId)).toMatchObject({
      error: { code: 'INVALID_ROOM_ID' },
    });

    const idleMove = await post('/api/rooms/default/moves', { row: 1, col: 1 });
    expect(idleMove.status).toBe(409);
    const idlePayload = await readJson<ErrorResponse>(idleMove);
    expect(idlePayload.error?.code).toBe('GAME_NOT_PLAYING');
    expect(idlePayload.state?.status).toBe('idle');

    const badCoordinate = await post('/api/rooms/default/moves', {
      row: 1.5,
      col: 1,
    });
    expect(badCoordinate.status).toBe(400);
    expect((await readJson<ErrorResponse>(badCoordinate)).error?.code).toBe(
      'INVALID_REQUEST',
    );

    const emptyCommentary = await post('/api/rooms/default/commentary', {
      text: '   ',
    });
    expect(emptyCommentary.status).toBe(400);
    expect((await readJson<ErrorResponse>(emptyCommentary)).error?.code).toBe(
      'INVALID_COMMENTARY',
    );
  });

  it('times out a long poll without an agent seat', async () => {
    const created = await post('/api/rooms', {
      roomId: 'human-room',
      seats: { black: { kind: 'human' }, white: { kind: 'human' } },
    });
    expect(created.status).toBe(201);

    const response = await get(
      '/api/rooms/human-room/wait-for-turn?actor=agent&timeoutMs=1000',
    );
    expect(response.status).toBe(400);
    // No agent seat and no participant claim: the caller cannot be identified,
    // which is what IDENTITY_REQUIRED names.
    expect((await readJson<ErrorResponse>(response)).error?.code).toBe(
      'IDENTITY_REQUIRED',
    );
  });

  it('returns timeout as a normal long-poll result', async () => {
    await post('/api/rooms', { roomId: 'timeout-room' });
    await post('/api/rooms/timeout-room/games', {});

    const startedAt = Date.now();
    const response = await get(
      '/api/rooms/timeout-room/wait-for-turn?actor=agent&timeoutMs=1000',
    );
    const payload = await readJson<WaitForTurnResponse>(response);

    expect(response.status).toBe(200);
    expect(payload.reason).toBe('timeout');
    expect(payload.state.status).toBe('playing');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
  });
});

describe('WebSocket', () => {
  it('sends hello, then state and commentary events', async () => {
    await post('/api/rooms', { roomId: 'ws-room' });

    const socket = new WebSocket(`${wsUrl}/ws?roomId=ws-room`);
    const messages: ServerMessage[] = [];
    socket.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()) as ServerMessage);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    await waitUntil(() =>
      messages.some((message) => message.type === 'hello'),
    );

    const hello = messages.find(
      // `state` picks the game hello; the chat variant greets with a room
      // snapshot and has no board.
      (message): message is Extract<
        ServerMessage,
        { type: 'hello'; state: { status: string } }
      > => message.type === 'hello' && 'state' in message,
    );
    expect(hello?.state.status).toBe('idle');
    expect(hello?.commentary).toEqual([]);

    await post('/api/rooms/ws-room/games', { agentColor: 'white' });
    await post('/api/rooms/ws-room/moves', { row: 7, col: 7 });
    await post('/api/rooms/ws-room/commentary', {
      text: '广播测试',
      kind: 'banter',
      mood: 'happy',
    });

    await waitUntil(() =>
      messages.some(
        (message) => message.type === 'state' && message.state.moveCount === 1,
      ),
    );
    await waitUntil(() =>
      messages.some((message) => message.type === 'commentary'),
    );

    const commentaryMessage = messages.find(
      (message): message is Extract<ServerMessage, { type: 'commentary' }> =>
        message.type === 'commentary',
    );
    expect(commentaryMessage?.commentary).toMatchObject({
      text: '广播测试',
      kind: 'banter',
    });

    socket.send(JSON.stringify({ type: 'ping' }));
    await waitUntil(() =>
      messages.some((message) => message.type === 'pong'),
    );

    socket.close();
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
  });

  it('rejects unknown rooms with an error frame', async () => {
    const socket = new WebSocket(`${wsUrl}/ws?roomId=ghost`);
    const messages: ServerMessage[] = [];
    socket.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()) as ServerMessage);
    });

    await waitUntil(() =>
      messages.some(
        (message) =>
          message.type === 'error' && message.code === 'ROOM_NOT_FOUND',
      ),
    );

    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      socket.once('close', () => resolve());
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});

describe('MCP over Streamable HTTP', () => {
  it('plays a full turn loop through the MCP tools', async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
    );
    const client = new Client({ name: 'http-integration', version: '0.0.0' });

    try {
      await client.connect(transport);

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);

      const started = await callTool(client, 'new_game', {
        roomId: 'mcp-room',
        agentColor: 'white',
      });
      expect(started).toMatchObject({
        state: { status: 'playing' },
        yourColor: 'white',
      });

      const early = await client.callTool({
        name: 'place_stone',
        arguments: { roomId: 'mcp-room', row: 7, col: 7 },
      });
      expect(early.isError).toBe(true);
      expect(toolPayload(early).code).toBe('NOT_YOUR_TURN');

      const human = await post('/api/rooms/mcp-room/moves', {
        row: 7,
        col: 7,
      });
      expect(human.status).toBe(200);

      const turn = await callTool(client, 'wait_for_turn', {
        roomId: 'mcp-room',
        timeoutMs: 1_000,
      });
      expect(turn.reason).toBe('your_turn');
      expect(turn.yourColor).toBe('white');

      const said = await callTool(client, 'say', {
        roomId: 'mcp-room',
        text: '还不赖。',
        kind: 'evaluation',
        mood: 'confident',
      });
      expect(said.commentary.text).toBe('还不赖。');

      const placed = await callTool(client, 'place_stone', {
        roomId: 'mcp-room',
        row: 7,
        col: 8,
      });
      expect(placed.ok).toBe(true);
      expect(placed.state.moveCount).toBe(2);
      // Agent view replaces the nested board array with compact artefacts.
      expect(placed.state.board).toBeUndefined();
      expect(placed.state.boardText).toContain('o');
      expect(placed.state.moves).toHaveLength(2);
      expect(placed.state.hotPoints.black).toBeInstanceOf(Array);

      // Long poll across transports: MCP waits, REST moves.
      const waiting = client.callTool({
        name: 'wait_for_turn',
        arguments: { roomId: 'mcp-room', timeoutMs: 5_000 },
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const secondHuman = await post('/api/rooms/mcp-room/moves', {
        row: 8,
        col: 8,
      });
      expect(secondHuman.status).toBe(200);

      const woken = toolPayload(await waiting);
      expect(woken.reason).toBe('your_turn');
      expect(woken.state.moveCount).toBe(3);

      // Error responses stay self-consistent: the carried state includes
      // the move history, matching moveCount.
      const occupied = await client.callTool({
        name: 'place_stone',
        arguments: { roomId: 'mcp-room', row: 7, col: 7 },
      });
      expect(occupied.isError).toBe(true);
      const occupiedPayload = toolPayload(occupied);
      expect(occupiedPayload.code).toBe('CELL_OCCUPIED');
      expect(occupiedPayload.state.moveCount).toBe(3);
      expect(occupiedPayload.state.moves).toHaveLength(3);
      expect(occupiedPayload.state.movesOmitted).toBe(0);

      const resigned = await callTool(client, 'resign', {
        roomId: 'mcp-room',
      });
      expect(resigned.state).toMatchObject({
        status: 'finished',
        winner: 'black',
        endReason: 'resign',
      });
    } finally {
      await client.close();
    }
  }, 20_000);
});
