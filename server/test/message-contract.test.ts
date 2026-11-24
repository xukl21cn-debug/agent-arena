import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatManager } from '../src/chat/manager';
import { ChatError, type ChatMember } from '../src/chat/model';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { MemoryRoomRepository } from '../src/game/rooms/repository';
import { RoomManager } from '../src/game/rooms/room-manager';

/**
 * 服务端英文 message 契约锁。
 *
 * web/src/errors.ts 的 MESSAGE_RULES 靠正则匹配服务端英文 `message` 来出中文
 * 文案；两边是隐式耦合，服务端一改措辞，前端翻译就静默失效（退回 code 文案）。
 * 本文件把 MESSAGE_RULES 对应的服务端 message 确切措辞锁死：
 * - 每条 message 由真实服务端路径产出，逐字与锁死值比对——服务端文案一改即红；
 * - 每条正则与锁死值互测，且正则原文必须仍出现在 web/src/errors.ts 里——
 *   两边任一漂移都会红。
 */

let server: Server;
let baseUrl: string;
let dataDir: string;
let chat: ChatManager;

function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/** Pull the `error.message` out of a refused REST answer. */
async function restError(route: string, init?: RequestInit): Promise<string> {
  const response = await fetch(`${baseUrl}${route}`, init);
  const body = (await response.json()) as {
    error?: { message?: string };
  };
  const message = body.error?.message;
  if (typeof message !== 'string') {
    throw new Error(
      `expected an error body from ${route}, got ${response.status} ${JSON.stringify(body)}`,
    );
  }
  return message;
}

/** Pull the `message` out of a refused domain call. */
function domainError(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ChatError) {
      return error.message;
    }
    throw error;
  }
  throw new Error('expected a ChatError, but nothing was thrown');
}

/** The live member record `sendMessage` needs (a snapshot clone would not do). */
function agentMember(roomId: string, name: string): ChatMember {
  const room = chat.getOrThrow(roomId);
  const member = room
    .snapshot()
    .members.find((item) => item.name === name && item.kind === 'agent');
  if (!member) {
    throw new Error(`no agent member "${name}" in room "${roomId}"`);
  }
  return room.memberRef(member.id)!;
}

interface LockedMessage {
  name: string;
  /** The rule regex copied from web/src/errors.ts MESSAGE_RULES. */
  pattern: RegExp;
  /** The exact server wording this rule must keep translating. */
  expected: string;
  /** Produces the live message straight from the server code. */
  produce: () => Promise<string> | string;
}

const LOCKED: LockedMessage[] = [
  // ---- game REST: room / participant / archive -----------------------------
  {
    name: 'ROOM_NOT_FOUND',
    pattern: /^Room "[^"]*" not found\.$/,
    expected: 'Room "contract-missing" not found.',
    produce: () => restError('/api/rooms/contract-missing'),
  },
  {
    name: 'ARCHIVE_NOT_FOUND',
    pattern: /^Archive "[^"]*" not found\.$/,
    expected: 'Archive "contract-nope" not found.',
    produce: () => restError('/api/archive/contract-nope/replay'),
  },
  {
    name: 'NO_MOVES',
    pattern: /^Room "[^"]*" has not played a game yet\.$/,
    expected: 'Room "contract-idle" has not played a game yet.',
    produce: () => restError('/api/rooms/contract-idle/replay'),
  },
  {
    name: 'PARTICIPANT_NOT_FOUND',
    pattern: /^Participant "[^"]*" is not in room "[^"]*"\.$/,
    expected: 'Participant "ghost" is not in room "contract-turn-not".',
    produce: () =>
      restError('/api/rooms/contract-turn-not/participants/ghost', {
        method: 'DELETE',
      }),
  },
  {
    name: 'ROOM_BUSY',
    pattern: /^Room "[^"]*" is playing; finish or abandon the game before deleting it\.$/,
    expected:
      'Room "contract-turn-not" is playing; finish or abandon the game before deleting it.',
    produce: () =>
      restError('/api/rooms/contract-turn-not', { method: 'DELETE' }),
  },

  // ---- request body series -------------------------------------------------
  {
    name: 'body not JSON',
    pattern: /^Request body is not valid JSON\.$/,
    expected: 'Request body is not valid JSON.',
    produce: () =>
      restError('/api/rooms/contract-idle/games', postJson('not json{{{')),
  },
  {
    name: 'body too large',
    pattern: /^Request body is too large\.$/,
    expected: 'Request body is too large.',
    produce: () =>
      restError(
        '/api/rooms/contract-idle/games',
        postJson({ note: 'x'.repeat(70_000) }),
      ),
  },
  {
    name: 'body not an object',
    pattern: /^Request body must be a JSON object\.$/,
    expected: 'Request body must be a JSON object.',
    produce: () =>
      restError('/api/rooms/contract-idle/games', postJson([1, 2, 3])),
  },
  {
    name: 'route not found',
    pattern: /^Route not found\.$/,
    expected: 'Route not found.',
    produce: () => restError('/api/definitely-not-a-route'),
  },

  // ---- game state machine --------------------------------------------------
  {
    name: 'GAME_NOT_PLAYING',
    pattern: /^Game is not in progress\.$/,
    expected: 'Game is not in progress.',
    produce: () =>
      restError(
        '/api/rooms/contract-idle/moves',
        postJson({ row: 7, col: 7, actor: 'human' }),
      ),
  },
  {
    name: 'NOT_YOUR_TURN',
    pattern: /^It is (black|white)'s turn\.$/,
    expected: "It is black's turn.",
    produce: () =>
      restError(
        '/api/rooms/contract-turn-not/moves',
        postJson({ row: 3, col: 3, actor: 'agent' }),
      ),
  },
  {
    name: 'CELL_OCCUPIED',
    pattern: /^(?:Cell|Point) \((\d+),(\d+)\) is (?:already )?occupied\.$/,
    expected: 'Cell (7,7) is already occupied.',
    produce: () =>
      restError(
        '/api/rooms/contract-turn-occ/moves',
        postJson({ row: 7, col: 7, actor: 'agent' }),
      ),
  },
  {
    name: 'GO occupied',
    pattern: /^(?:Cell|Point) \((\d+),(\d+)\) is (?:already )?occupied\.$/,
    expected: 'Point (0,0) is occupied.',
    produce: () =>
      restError(
        '/api/rooms/contract-go-occ/moves',
        postJson({ row: 0, col: 0, actor: 'human' }),
      ),
  },
  {
    name: 'scoring phase',
    pattern:
      /^The game is in the scoring phase; use mark_dead \/ confirm_score \/ resume_play\.$/,
    expected:
      'The game is in the scoring phase; use mark_dead / confirm_score / resume_play.',
    produce: () =>
      restError(
        '/api/rooms/contract-go-score/moves',
        postJson({ row: 4, col: 4, actor: 'human' }),
      ),
  },

  // ---- chat ----------------------------------------------------------------
  {
    name: 'MESSAGE_TOO_LONG',
    pattern: /^Message is (\d+) characters; the limit is (\d+)\.$/,
    expected: 'Message is 8 characters; the limit is 5.',
    produce: () =>
      restError(
        '/api/chat/rooms/contract-chat/messages',
        postJson({ text: '12345678' }),
      ),
  },
  {
    name: 'empty message',
    pattern: /^Message text must not be empty\.$/,
    expected: 'Message text must not be empty.',
    produce: () =>
      restError(
        '/api/chat/rooms/contract-chat/messages',
        postJson({ text: '   ' }),
      ),
  },
  {
    name: 'ROOM_CLOSED (chat)',
    pattern: /^Chat room "[^"]*" is closed\.$/,
    expected: 'Chat room "contract-closed" is closed.',
    produce: () =>
      restError(
        '/api/chat/rooms/contract-closed/messages',
        postJson({ text: '还在吗' }),
      ),
  },
  {
    name: 'ROOM_PAUSED (chat)',
    pattern: /^(?:The room|Chat room "[^"]*") is paused; wait for the host to resume it\.$/,
    expected: 'The room is paused; wait for the host to resume it.',
    produce: () =>
      domainError(() => {
        chat
          .getOrThrow('contract-paused')
          .sendMessage(agentMember('contract-paused', 'alpha'), 'hi', {}, Date.now());
      }),
  },
  {
    name: 'to must hold turns',
    pattern: /^"to" must name an agent member; "[^"]*" does not hold turns\.$/,
    expected: '"to" must name an agent member; "human" does not hold turns.',
    produce: () =>
      restError(
        '/api/chat/rooms/contract-chat/messages',
        postJson({ text: 'hi', to: 'human' }),
      ),
  },
  {
    name: 'MEMBER_NOT_FOUND',
    pattern: /^No member "[^"]*" in this room; check the member list in the snapshot\.$/,
    expected:
      'No member "nobody" in this room; check the member list in the snapshot.',
    produce: () =>
      restError(
        '/api/chat/rooms/contract-chat/messages',
        postJson({ text: 'hi', to: 'nobody' }),
      ),
  },
  {
    name: 'MEMBER_LIMIT_REACHED',
    pattern:
      /^You have sent \d+ messages, the per-member limit is \d+\. The turn moved on\.$/,
    expected:
      'You have sent 1 messages, the per-member limit is 1. The turn moved on.',
    produce: () =>
      domainError(() => {
        chat
          .getOrThrow('contract-cap')
          .sendMessage(agentMember('contract-cap', 'alpha'), '第二句', {}, Date.now());
      }),
  },
  {
    name: 'DUPLICATE_MESSAGE',
    pattern: /^Your last message is identical; rephrase instead of repeating\.$/,
    expected: 'Your last message is identical; rephrase instead of repeating.',
    produce: () =>
      domainError(() => {
        chat
          .getOrThrow('contract-dup')
          .sendMessage(agentMember('contract-dup', 'alpha'), 'hello', {}, Date.now());
      }),
  },
  {
    name: 'ROOM_BUSY (chat)',
    pattern: /^Chat room "[^"]*" holds \d+ messages and is \w+; close it before deleting\.$/,
    expected:
      'Chat room "contract-busy" holds 2 messages and is open; close it before deleting.',
    produce: () =>
      restError('/api/chat/rooms/contract-busy', { method: 'DELETE' }),
  },
];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'arena-message-contract-'));
  const manager = new RoomManager({ repository: new MemoryRoomRepository() });
  manager.initializeDefaultRoom();
  chat = new ChatManager(dataDir);

  server = createServer(
    createApp(manager, loadConfig({ ARENA_DATA_DIR: dataDir }), { chat }),
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

  // ---- game fixtures ------------------------------------------------------
  await fetch(`${baseUrl}/api/rooms`, postJson({ roomId: 'contract-idle' }));

  await fetch(`${baseUrl}/api/rooms`, postJson({ roomId: 'contract-turn-not' }));
  await fetch(`${baseUrl}/api/rooms/contract-turn-not/games`, postJson({}));

  await fetch(`${baseUrl}/api/rooms`, postJson({ roomId: 'contract-turn-occ' }));
  await fetch(`${baseUrl}/api/rooms/contract-turn-occ/games`, postJson({}));
  await fetch(
    `${baseUrl}/api/rooms/contract-turn-occ/moves`,
    postJson({ row: 7, col: 7, actor: 'human' }),
  );

  await fetch(`${baseUrl}/api/rooms`, postJson({ roomId: 'contract-go-occ' }));
  await fetch(
    `${baseUrl}/api/rooms/contract-go-occ/games`,
    postJson({ game: 'go' }),
  );
  await fetch(
    `${baseUrl}/api/rooms/contract-go-occ/moves`,
    postJson({ row: 0, col: 0, actor: 'human' }),
  );
  await fetch(
    `${baseUrl}/api/rooms/contract-go-occ/moves`,
    postJson({ row: 8, col: 8, actor: 'agent' }),
  );

  await fetch(`${baseUrl}/api/rooms`, postJson({ roomId: 'contract-go-score' }));
  await fetch(
    `${baseUrl}/api/rooms/contract-go-score/games`,
    postJson({ game: 'go' }),
  );
  await fetch(
    `${baseUrl}/api/rooms/contract-go-score/pass`,
    postJson({ actor: 'human' }),
  );
  await fetch(
    `${baseUrl}/api/rooms/contract-go-score/pass`,
    postJson({ actor: 'agent' }),
  );

  // ---- chat fixtures ------------------------------------------------------
  await fetch(
    `${baseUrl}/api/chat/rooms`,
    postJson({ roomId: 'contract-chat', policy: { maxMessageChars: 5 } }),
  );
  await fetch(
    `${baseUrl}/api/chat/rooms`,
    postJson({ roomId: 'contract-closed' }),
  );
  await fetch(`${baseUrl}/api/chat/rooms/contract-closed/close`, {
    method: 'POST',
  });
  await fetch(
    `${baseUrl}/api/chat/rooms`,
    postJson({ roomId: 'contract-busy' }),
  );
  await fetch(
    `${baseUrl}/api/chat/rooms/contract-busy/messages`,
    postJson({ text: '第一条' }),
  );
  await fetch(
    `${baseUrl}/api/chat/rooms/contract-busy/messages`,
    postJson({ text: '第二条' }),
  );

  // Agent-driven chat rooms: the paused / per-member / duplicate gates only
  // apply to agent members, so they are set up (and provoked) in the domain.
  const paused = chat.create('contract-paused');
  paused.join('alpha', undefined, Date.now());
  paused.pause(Date.now());

  const cap = chat.create('contract-cap', {
    policy: { maxMessagesPerMember: 1, maxHops: 50 },
  });
  cap.sendMessage(cap.join('alpha', undefined, Date.now()), '第一句', {}, Date.now());

  const dup = chat.create('contract-dup');
  dup.sendMessage(dup.join('alpha', undefined, Date.now()), 'hello', {}, Date.now());
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

describe('server English message contract', () => {
  it('every pinned pattern is still the one web/src/errors.ts matches with', () => {
    const webSource = readFileSync(
      new URL('../../web/src/errors.ts', import.meta.url),
      'utf8',
    );
    for (const rule of LOCKED) {
      expect(webSource, rule.name).toContain(String(rule.pattern));
    }
  });

  it('every pinned wording still matches its translation pattern', () => {
    for (const rule of LOCKED) {
      expect(rule.pattern.test(rule.expected), rule.name).toBe(true);
    }
  });

  for (const rule of LOCKED) {
    it(`${rule.name}: server wording is unchanged and still translates`, async () => {
      const message = await rule.produce();
      // Exact wording: changing the server text turns this red on purpose —
      // update web/src/errors.ts in the same change or the translation dies.
      expect(message, rule.name).toBe(rule.expected);
      expect(rule.pattern.test(message), rule.name).toBe(true);
    });
  }
});
