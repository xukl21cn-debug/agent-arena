import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it } from 'vitest';
import { sessionGone, WorkClient } from '../src/work-client.js';

/**
 * An MCP client that does whatever a test scripts, so that failures can be
 * made to arrive in any order.
 */
function scriptedClient(script: (name: string) => Promise<unknown>): { client: Client; connects: unknown[] } {
  const connects: unknown[] = [];
  const client = {
    connect: async (transport: unknown) => { connects.push(transport); },
    close: async () => undefined,
    // What a tool answers with; whatever the script throws is thrown on.
    callTool: async (request: { name: string }) => ({
      content: [{ type: 'text', text: JSON.stringify(await script(request.name)) }],
    }),
  };
  return { client: client as unknown as Client, connects };
}

const sessionLost = (): never => { throw new StreamableHTTPError(404, 'Session not found.'); };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

it('recognises a lost session by what the error is, not by what it is called', () => {
  // The SDK leaves the error's name as "Error"; looking at the name never matches.
  expect(new StreamableHTTPError(404, 'Session not found.').name).toBe('Error');
  expect(sessionGone(new StreamableHTTPError(404, 'Session not found.'))).toBe(true);
  expect(sessionGone(new StreamableHTTPError(400, 'Bad request.'))).toBe(false);
  expect(sessionGone(new Error('Session not found.'))).toBe(false);
});

it('reconnects once per lost session, even when one failure arrives after the reconnect', async () => {
  // A reconnect while a round is running closes the live session, and the
  // server then takes the task away from the runner; so a failure that turns
  // up after the session was replaced must not set off a second one.
  let calls = 0;
  const { client, connects } = scriptedClient(async (name) => {
    if (name === 'join_work') return { participantId: 'w_1', role: 'worker', name: 'runner-wire', workspace: '/tmp/ws' };
    calls += 1;
    if (calls === 1) sessionLost();
    if (calls === 2) {
      await sleep(150);
      sessionLost();
    }
    return { ok: true };
  });
  const runner = new WorkClient('http://127.0.0.1:1', 'runner-wire', undefined, client);
  await runner.connect();
  const [first, late] = await Promise.all([runner.getTask('a'), runner.getTask('b')]);
  expect(first).toEqual({ ok: true });
  expect(late).toEqual({ ok: true });
  // The first session, and one replacement.
  expect(connects).toHaveLength(2);
});
