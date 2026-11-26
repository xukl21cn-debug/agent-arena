import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

it('takes an imported room’s updated_at from its last message', () => {
  const legacy = new ChatManager(dir);
  legacy.create('dated-chat');
  legacy.get('dated-chat')!.sendMessage(legacy.get('dated-chat')!.humanMember(), 'hello', {}, Date.now());
  const lastAt = legacy.get('dated-chat')!.toSnapshotFile().messages.at(-1)!.at;

  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  new ChatManager(dir, new SqliteChatStore(database, dir));
  const row = database.db.prepare('SELECT updated_at FROM chat_rooms WHERE id = ?').get('dated-chat') as { updated_at: number };
  expect(row.updated_at).toBe(Date.parse(lastAt));
  database.close();
});

it('skips legacy chat files that are not snapshots written under their own id', () => {
  const legacy = new ChatManager(dir);
  legacy.create('good-chat');
  const valid = JSON.parse(readFileSync(path.join(dir, 'chat', 'good-chat.json'), 'utf8')) as object;
  // The payload belongs to another file name...
  writeFileSync(path.join(dir, 'chat', 'renamed.json'), JSON.stringify(valid));
  // ...and this one parses but cannot be rebuilt into a room.
  writeFileSync(path.join(dir, 'chat', 'broken.json'), JSON.stringify({ ...valid, id: 'broken', members: undefined, messages: undefined }));

  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  new ChatManager(dir, new SqliteChatStore(database, dir));
  // The rows are what matters: the restore path would skip an unreadable one
  // and hide that it was imported at all.
  expect(database.db.prepare('SELECT id FROM chat_rooms').all().map((row) => row.id)).toEqual(['good-chat']);
  const chat = new ChatManager(dir, new SqliteChatStore(database, dir));
  chat.restoreAll();
  expect(chat.list().map((room) => room.id)).toEqual(['good-chat']);
  database.close();
});

it('never imports legacy JSON over live rows, even without the import marker', () => {
  // A room the user has since deleted; its file stays on disk.
  new ChatManager(dir).create('gone-chat');
  const file = path.join(dir, 'arena.db');

  const first = new ArenaDatabase(file);
  new ChatManager(dir, new SqliteChatStore(first)).create('live-chat');
  // A database written before the marker existed has rows but no marker.
  first.db.prepare('DELETE FROM meta').run();
  first.close();

  const second = new ArenaDatabase(file);
  const restored = new ChatManager(dir, new SqliteChatStore(second, dir));
  restored.restoreAll();
  expect(restored.list().map((room) => room.id)).toEqual(['live-chat']);
  second.close();
});

it('does not recreate the legacy chat directory when a store is used', () => {
  const database = new ArenaDatabase(path.join(dir, 'arena.db'));
  new ChatManager(dir, new SqliteChatStore(database));
  expect(existsSync(path.join(dir, 'chat'))).toBe(false);
  database.close();
});

it('does not resurrect a deleted chat room from the legacy JSON', () => {
  const legacy = new ChatManager(dir);
  legacy.create('legacy-chat');
  const file = path.join(dir, 'arena.db');

  const first = new ArenaDatabase(file);
  const chat = new ChatManager(dir, new SqliteChatStore(first, dir));
  chat.restoreAll();
  chat.remove('legacy-chat');
  expect(chat.list()).toEqual([]);
  first.close();

  const second = new ArenaDatabase(file);
  const restored = new ChatManager(dir, new SqliteChatStore(second, dir));
  restored.restoreAll();
  expect(restored.list()).toEqual([]);
  second.close();
});
