import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOM_ID_PATTERN } from '@arena/shared';
import type { ChatRoom } from './chat-room.js';
import type { ChatRoomSnapshotFile } from './model.js';
import { ArenaDatabase } from '../db/database.js';

/** One-shot import marker; see `ArenaDatabase.metaFlag`. */
const LEGACY_IMPORTED_FLAG = 'legacy_imported:chat';

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

/** ISO timestamp to epoch milliseconds; an unparsable value falls back to now. */
function epochOf(iso: string | undefined): number {
  const parsed = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Mirrors `ChatRoom.lastActivityAt()` for a raw snapshot: newest message wins. */
function lastActivityOf(snapshot: ChatRoomSnapshotFile): string {
  const createdAt = typeof snapshot.createdAt === 'string' ? snapshot.createdAt : '';
  const last = snapshot.messages?.at(-1)?.at;
  if (typeof last !== 'string') return createdAt;
  return last > createdAt ? last : createdAt;
}

function parseSnapshot(row: PayloadRow | undefined, label: string): ChatRoomSnapshotFile | null {
  if (row === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch (error) {
    console.error(`[chat-store] skipping corrupt ${label}:`, error instanceof Error ? error.message : error);
    return null;
  }
  // A stored `null` parses fine but is not a snapshot; logging it keeps the
  // "skip and log" promise from silently dropping the row.
  if (parsed === null || typeof parsed !== 'object') {
    console.error(`[chat-store] skipping corrupt ${label}: payload is not an object`);
    return null;
  }
  return parsed as ChatRoomSnapshotFile;
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
    this.database.db.prepare(`
      INSERT INTO chat_rooms(id, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(room.id, payload, epochOf(room.lastActivityAt()));
  }

  delete(roomId: string): void {
    this.database.db.prepare('DELETE FROM chat_rooms WHERE id = ?').run(roomId);
  }

  /**
   * One-time import of `data/chat/*.json`. `updated_at` comes from the newest
   * message (not from `createdAt`), so a room imported from an old transcript
   * sorts like the live one would.
   */
  private importLegacy(dataDir: string): void {
    if (this.database.metaFlag(LEGACY_IMPORTED_FLAG)) return;
    // A populated table already holds the authoritative state; importing over
    // it would overwrite newer transcripts with stale JSON.
    const existing = this.database.db.prepare('SELECT COUNT(*) AS count FROM chat_rooms').get() as { count: number };
    if (Number(existing.count) > 0) {
      this.database.setMetaFlag(LEGACY_IMPORTED_FLAG);
      return;
    }
    const directory = path.join(dataDir, 'chat');
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    const files = entries.filter((entry) => entry.endsWith('.json') && !entry.endsWith('.json.tmp'));
    if (files.length === 0) return;

    let imported = 0;
    this.database.transaction(() => {
      for (const entry of files) {
        const roomId = entry.slice(0, -'.json'.length);
        if (!ROOM_ID_PATTERN.test(roomId)) {
          console.warn(`[chat-store] skipping legacy chat room ${entry}: name is not a valid id`);
          continue;
        }
        try {
          const parsed = JSON.parse(readFileSync(path.join(directory, entry), 'utf8')) as unknown;
          if (parsed === null || typeof parsed !== 'object') throw new Error('payload is not an object');
          const snapshot = parsed as ChatRoomSnapshotFile;
          this.database.db.prepare(`
            INSERT INTO chat_rooms(id, payload, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(id) DO NOTHING
          `).run(roomId, JSON.stringify(snapshot), epochOf(lastActivityOf(snapshot)));
          imported += 1;
        } catch (error) {
          console.warn(`[chat-store] skipping corrupt legacy chat room ${entry}:`, error instanceof Error ? error.message : error);
        }
      }
      this.database.setMetaFlag(LEGACY_IMPORTED_FLAG);
    });
    if (imported > 0) console.log(`[chat-store] imported ${imported} chat rooms from legacy JSON.`);
  }
}
