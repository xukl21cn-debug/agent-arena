import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ArenaDatabase } from '../src/db/database.js';
import { ChatManager } from '../src/chat/manager.js';
import { SqliteChatStore } from '../src/chat/store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-sqlite-chat-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('persists chat rooms and restores them from SQLite', () => {
  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  const chat = new ChatManager(dir, new SqliteChatStore(database));
  chat.create('chat-sqlite', { title: 'SQLite chat' });
  expect(chat.list()).toMatchObject([{ id: 'chat-sqlite', title: 'SQLite chat' }]);
  database.close();

  const reopened = new ArenaDatabase(path.join(dir, 'arena.db'));
  const restored = new ChatManager(dir, new SqliteChatStore(reopened));
  restored.restoreAll();
  expect(restored.get('chat-sqlite')?.snapshot().title).toBe('SQLite chat');
  reopened.close();
});

it('imports legacy chat JSON once when the SQLite table is empty', () => {
  const legacy = new ChatManager(dir);
  legacy.create('legacy-chat', { title: 'Legacy chat' });

  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  const chat = new ChatManager(dir, new SqliteChatStore(database, dir));
  chat.restoreAll();
  expect(chat.get('legacy-chat')?.snapshot().title).toBe('Legacy chat');
  database.close();

  const reopened = new ArenaDatabase(path.join(dir, 'arena.db'));
  expect(new SqliteChatStore(reopened, dir).loadAll().map((entry) => entry.roomId)).toEqual(['legacy-chat']);
  reopened.close();
});

it('deletes a chat room from SQLite', () => {
  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  const chat = new ChatManager(dir, new SqliteChatStore(database));
  chat.create('delete-chat');
  chat.remove('delete-chat');
  expect(new SqliteChatStore(database).loadAll()).toHaveLength(0);
  database.close();
});

it('does not recreate the legacy chat directory when a store is used', () => {
  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  new ChatManager(dir, new SqliteChatStore(database));
  expect(existsSync(path.join(dir, 'chat'))).toBe(false);
  database.close();
});
