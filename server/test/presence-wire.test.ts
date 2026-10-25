import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  ParticipantView,
  RoomView,
  ServerMessage,
} from '@arena/shared';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { PresenceRegistry } from '../src/core/presence';
import { attachWebSocket } from '../src/http/ws';
import { MemoryRoomRepository } from '../src/rooms/repository';
import { RoomManager } from '../src/rooms/room-manager';

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
      (message): message is Extract<ServerMessage, { type: 'hello' }> =>
        message.type === 'hello',
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
      new URL(`${baseUrl}/mcp`),
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
      new URL(`${baseUrl}/mcp`),
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
