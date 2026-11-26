import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatRoom } from './chat-room.js';
import type { ChatRoomSnapshotFile } from './model.js';
import { ArenaDatabase } from '../db/database.js';

export interface StoredChatRoom {
  roomId: string;
  snapshot: ChatRoomSnapshotFile;
}

/** Persistence seam for chat rooms; domain logic stays in ChatManager/ChatRoom. */
export interface ChatStore {
  loadAll(): StoredChatRoom[];
  load(roomId: string): ChatRoomSnapshotFile | null;
  save(room: ChatRoom): void;
  delete(roomId: string): void;
}

interface PayloadRow {
  id: string;
  payload: string;
}

function parseSnapshot(row: PayloadRow | undefined, label: string): ChatRoomSnapshotFile | null {
  if (row === undefined) return null;
  try {
    return JSON.parse(row.payload) as ChatRoomSnapshotFile;
  } catch (error) {
    console.error(`[chat-store] skipping corrupt ${label}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** SQLite-backed chat snapshots. Messages stay inside the snapshot payload. */
export class SqliteChatStore implements ChatStore {
  constructor(
    private readonly database: ArenaDatabase,
    importFrom?: string,
  ) {
    if (importFrom !== undefined) this.importLegacy(importFrom);
  }

  loadAll(): StoredChatRoom[] {
    const rows = this.database.db.prepare('SELECT id, payload FROM chat_rooms').all() as unknown as PayloadRow[];
    const result: StoredChatRoom[] = [];
    for (const row of rows) {
      const snapshot = parseSnapshot(row, `chat room ${row.id}`);
      if (snapshot) result.push({ roomId: row.id, snapshot });
    }
    return result;
  }

  load(roomId: string): ChatRoomSnapshotFile | null {
    const row = this.database.db.prepare('SELECT id, payload FROM chat_rooms WHERE id = ?').get(roomId) as
      | PayloadRow
      | undefined;
    return parseSnapshot(row, `chat room ${roomId}`);
  }

  save(room: ChatRoom): void {
    const payload = JSON.stringify(room.toSnapshotFile());
    const updatedAt = room.lastActivityAt();
    this.database.db.prepare(`
      INSERT INTO chat_rooms(id, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(room.id, payload, updatedAt);
  }

  delete(roomId: string): void {
    this.database.db.prepare('DELETE FROM chat_rooms WHERE id = ?').run(roomId);
  }

  private importLegacy(dataDir: string): void {
    const count = Number((this.database.db.prepare('SELECT COUNT(*) AS count FROM chat_rooms').get() as { count: number }).count);
    if (count > 0) return;
    const directory = path.join(dataDir, 'chat');
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    let imported = 0;
    this.database.transaction(() => {
      for (const entry of entries) {
        if (!entry.endsWith('.json') || entry.endsWith('.json.tmp')) continue;
        const roomId = entry.slice(0, -'.json'.length);
        try {
          const snapshot = JSON.parse(readFileSync(path.join(directory, entry), 'utf8')) as ChatRoomSnapshotFile;
          this.database.db.prepare(`
            INSERT INTO chat_rooms(id, payload, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(id) DO NOTHING
          `).run(roomId, JSON.stringify(snapshot), snapshot.createdAt ?? new Date().toISOString());
          imported += 1;
        } catch (error) {
          console.warn(`[chat-store] skipping corrupt legacy chat room ${entry}:`, error instanceof Error ? error.message : error);
        }
      }
    });
    if (imported > 0) console.log(`[chat-store] imported ${imported} chat rooms from legacy JSON.`);
  }
}
