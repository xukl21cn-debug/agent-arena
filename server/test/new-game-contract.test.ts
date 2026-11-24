import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ErrorResponse, RoomView } from '@arena/shared';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { MemoryRoomRepository } from '../src/game/rooms/repository';
import { RoomManager } from '../src/game/rooms/room-manager';

/**
 * new_game error contract, shared by REST and MCP:
 * - INVALID_REQUEST for wrong type / enum / format;
 * - UNSUPPORTED_RULE for well-formed values v1 does not implement;
 * - never INTERNAL_ERROR / HTTP 500;
 * - a rejected request leaves no archive entry and no empty room.
 */

let server: Server;
let baseUrl: string;

function payloadOf(result: Awaited<ReturnType<Client['callTool']>>): any {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === 'text')?.text;
  if (!text) {
    throw new Error('tool returned no text content');
  }
  return JSON.parse(text);
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  return (await response.json()) as T;
}

beforeAll(async () => {
  const manager = new RoomManager({ repository: new MemoryRoomRepository() });
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

describe('new_game error contract', () => {
  it('MCP and REST agree on code and message for every invalid shape', async () => {
    await post('/api/rooms', { roomId: 'rules-rest' });

    const client = new Client({ name: 'rules-client', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/game/mcp`),
    );
    await client.connect(transport);

    const cases: Array<{ label: string; args: Record<string, unknown>; code: string; message: RegExp }> = [
      { label: 'go boardSize=13', args: { game: 'go', boardSize: 13 }, code: 'UNSUPPORTED_RULE', message: /9×9/ },
      { label: 'go boardSize=0', args: { game: 'go', boardSize: 0 }, code: 'INVALID_REQUEST', message: /between 1 and 36/ },
      { label: 'go boardSize=37', args: { game: 'go', boardSize: 37 }, code: 'INVALID_REQUEST', message: /between 1 and 36/ },
      { label: 'go boardSize=9.5', args: { game: 'go', boardSize: 9.5 }, code: 'INVALID_REQUEST', message: /integer/ },
      { label: 'go koRule=superko', args: { game: 'go', koRule: 'superko' }, code: 'UNSUPPORTED_RULE', message: /simple/ },
      { label: 'go koRule=5', args: { game: 'go', koRule: 5 }, code: 'INVALID_REQUEST', message: /string/ },
      { label: 'go komi=abc', args: { game: 'go', komi: 'abc' }, code: 'INVALID_REQUEST', message: /finite number/ },
      { label: 'go komi=-1', args: { game: 'go', komi: -1 }, code: 'INVALID_REQUEST', message: /between 0 and 36/ },
      { label: 'go komi=37', args: { game: 'go', komi: 37 }, code: 'INVALID_REQUEST', message: /between 0 and 36/ },
      { label: 'game=shogi', args: { game: 'shogi' }, code: 'INVALID_REQUEST', message: /gomoku/ },
      { label: 'gomoku boardSize=2', args: { boardSize: 2 }, code: 'INVALID_REQUEST', message: /between 3 and 36/ },
      { label: 'gomoku boardSize=40', args: { boardSize: 40 }, code: 'INVALID_REQUEST', message: /between 3 and 36/ },
      { label: 'gomoku komi=5', args: { komi: 5 }, code: 'UNSUPPORTED_RULE', message: /Go-only/ },
      { label: 'gomoku koRule=simple', args: { koRule: 'simple' }, code: 'UNSUPPORTED_RULE', message: /Go-only/ },
    ];

    try {
      for (const probe of cases) {
        const mcpResult = await client.callTool({
          name: 'new_game',
          arguments: { roomId: 'rules-rest', ...probe.args },
        });
        expect(mcpResult.isError, probe.label).toBe(true);
        const mcpPayload = payloadOf(mcpResult);
        expect(mcpPayload.code, probe.label).toBe(probe.code);
        expect(mcpPayload.code, probe.label).not.toBe('INTERNAL_ERROR');
        expect(mcpPayload.message, probe.label).toMatch(probe.message);

        const restResponse = await post('/api/rooms/rules-rest/games', probe.args);
        expect(restResponse.status, probe.label).toBe(400);
        const restPayload = (await restResponse.json()) as ErrorResponse;
        expect(restPayload.error.code, probe.label).toBe(probe.code);
        // The same input must read the same way over both transports.
        expect(restPayload.error.message, probe.label).toBe(mcpPayload.message);
      }
    } finally {
      await client.close();
    }
  });

  it('a valid new_game still works after rejected calls', async () => {
    const client = new Client({ name: 'rules-valid', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/game/mcp`),
    );
    await client.connect(transport);
    try {
      const started = payloadOf(
        await client.callTool({
          name: 'new_game',
          arguments: { roomId: 'rules-rest', game: 'go' },
        }),
      );
      expect(started.state.game).toBe('go');
      expect(started.state.rules.boardSize).toBe(9);
    } finally {
      await client.close();
    }
  });

  it('accepts komi at both ends of the documented 0-36 range', async () => {
    await post('/api/rooms', { roomId: 'komi-range' });

    const low = await post('/api/rooms/komi-range/games', {
      game: 'go',
      komi: 0,
    });
    expect(low.status).toBe(200);
    expect(((await low.json()) as { state: { rules: { komi: number } } }).state.rules.komi).toBe(0);

    const high = await post('/api/rooms/komi-range/games', {
      game: 'go',
      komi: 36,
    });
    expect(high.status).toBe(200);
    expect(((await high.json()) as { state: { rules: { komi: number } } }).state.rules.komi).toBe(36);
  });

  it('the new_game description states the precise rule contract and the komi range', async () => {
    // tools.ts text is model-facing documentation; this pins the exact
    // wording so it cannot quietly drift from the behaviour above.
    const client = new Client({ name: 'desc-reader', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/game/mcp`),
    );
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const description = tools.tools.find(
        (tool) => tool.name === 'new_game',
      )?.description;
      expect(description).toContain(
        '格式合法但 v1 不支持的值返回 UNSUPPORTED_RULE',
      );
      expect(description).toContain('类型/格式/范围错误返回 INVALID_REQUEST');
      expect(description).toContain('取值 0-36');
    } finally {
      await client.close();
    }
  });

  it('rejects a bad new_game without archiving the live game', async () => {
    await post('/api/rooms', { roomId: 'residual-rules' });
    expect((await post('/api/rooms/residual-rules/games', {})).status).toBe(200);
    expect((await post('/api/rooms/residual-rules/moves', { row: 7, col: 7 })).status).toBe(200);
    expect(await getJson<unknown[]>('/api/archive')).toHaveLength(0);

    const client = new Client({ name: 'residual-client', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/game/mcp`),
    );
    await client.connect(transport);
    try {
      const rejected = await client.callTool({
        name: 'new_game',
        arguments: { roomId: 'residual-rules', game: 'go', boardSize: 13 },
      });
      expect(rejected.isError).toBe(true);
      expect(payloadOf(rejected).code).toBe('UNSUPPORTED_RULE');
    } finally {
      await client.close();
    }

    expect(await getJson<unknown[]>('/api/archive')).toHaveLength(0);
    const room = await getJson<RoomView>('/api/rooms/residual-rules');
    expect(room.state.game).toBe('gomoku');
    expect(room.state.status).toBe('playing');
    expect(room.state.moveCount).toBe(1);
    expect(room.history).toHaveLength(1);
  });

  it('does not leave an empty room when new_game on a fresh id fails', async () => {
    const client = new Client({ name: 'fresh-client', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/game/mcp`),
    );
    await client.connect(transport);
    try {
      const rejected = await client.callTool({
        name: 'new_game',
        arguments: { roomId: 'created-by-bad', game: 'go', boardSize: 13 },
      });
      expect(rejected.isError).toBe(true);
      expect(payloadOf(rejected).code).toBe('UNSUPPORTED_RULE');
    } finally {
      await client.close();
    }

    const missing = await fetch(`${baseUrl}/api/rooms/created-by-bad`);
    expect(missing.status).toBe(404);
    const rooms = await getJson<Array<{ roomId: string }>>('/api/rooms');
    expect(rooms.some((room) => room.roomId === 'created-by-bad')).toBe(false);
  });
});
