import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { ChatRoom } from './chat-room.js';
import {
  ChatError,
  type ChatRoomSnapshot,
  type ChatRoomSnapshotFile,
} from './model.js';
import { assertRoomId } from '../rooms/room-manager.js';

/** Room list entries — lighter than a snapshot, enough for a lobby. */
export interface ChatRoomSummary {
  id: string;
  title: string;
  phase: ChatRoomSnapshot['phase'];
  memberCount: number;
  agentCount: number;
  messageCount: number;
  hop: number;
  maxHops: number;
  updatedAt: string;
}

/**
 * Registry of chat rooms plus their persistence.
 *
 * One JSON file per room under `<dataDir>/chat/<roomId>.json`, written
 * through a temp file and rename, same as the game rooms' repository: a
 * half-written transcript must not take the room down on the next boot, and
 * a corrupt file must never stop the server from starting — it is logged and
 * skipped, and the file stays on disk for inspection.
 */
export class ChatManager {
  private readonly rooms = new Map<string, ChatRoom>();
  private readonly chatDir: string;

  constructor(dataDir: string) {
    this.chatDir = path.join(dataDir, 'chat');
    mkdirSync(this.chatDir, { recursive: true });
  }

  get chatDirectory(): string {
    return this.chatDir;
  }

  private fileFor(roomId: string): string {
    // Chat room ids go through the same validator as game rooms — the
    // pattern already forbids `/`, `\` and `..`, which is the whole
    // traversal surface for a filename built from the id.
    assertRoomId(roomId);
    return path.join(this.chatDir, `${roomId}.json`);
  }

  private save(room: ChatRoom): void {
    const file = this.fileFor(room.id);
    const tmp = `${file}.tmp`;
    const json = JSON.stringify(room.toSnapshotFile());
    // Synchronous on purpose: a message must be durable before the send
    // answers, and chat volumes keep this in the few-milliseconds range.
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, json);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  }

  create(roomId: string, options: { title?: string } = {}): ChatRoom {
    assertRoomId(roomId);
    if (this.rooms.has(roomId)) {
      throw new ChatError(
        'ROOM_EXISTS',
        `Chat room "${roomId}" already exists.`,
      );
    }

    const room = new ChatRoom(roomId, options.title?.trim() || roomId, {
      // v1 implements relay; other modes are contract placeholders.
      mode: 'relay',
      maxHops: 16,
      maxMessagesPerMember: 8,
      turnTimeoutMs: 120_000,
      maxMessageChars: 4000,
    });
    room.onChange = () => this.save(room);
    room.humanMember();
    this.rooms.set(roomId, room);
    this.save(room);
    return room;
  }

  get(roomId: string): ChatRoom | undefined {
    return this.rooms.get(roomId);
  }

  getOrThrow(roomId: string): ChatRoom {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new ChatError('ROOM_NOT_FOUND', `Chat room "${roomId}" not found.`);
    }
    return room;
  }

  list(): ChatRoomSummary[] {
    return [...this.rooms.values()]
      .map((room) => {
        const snapshot = room.snapshot();
        return {
          id: snapshot.id,
          title: snapshot.title,
          phase: snapshot.phase,
          memberCount: snapshot.members.length,
          agentCount: snapshot.members.filter(
            (member) => member.kind === 'agent',
          ).length,
          messageCount: snapshot.messageCount,
          hop: snapshot.hop,
          maxHops: snapshot.policy.maxHops,
          updatedAt: new Date().toISOString(),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Remove the persisted file and the room from memory. */
  remove(roomId: string): void {
    this.rooms.delete(roomId);
    const file = this.fileFor(roomId);
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }

  /**
   * Rebuild every persisted chat room on boot. Closed rooms come back too —
   * their transcripts stay queryable. Corrupt files are skipped by load.
   */
  restoreAll(): void {
    if (!existsSync(this.chatDir)) {
      return;
    }
    for (const entry of readdirSync(this.chatDir)) {
      if (!entry.endsWith('.json') || entry.endsWith('.json.tmp')) {
        continue;
      }
      const roomId = entry.slice(0, -'.json'.length);
      if (this.rooms.has(roomId)) {
        continue;
      }
      const room = this.loadFile(roomId);
      if (room) {
        this.rooms.set(roomId, room);
      }
    }
  }

  private loadFile(roomId: string): ChatRoom | null {
    const file = path.join(this.chatDir, `${roomId}.json`);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as ChatRoomSnapshotFile;
      // The file's own id wins as the identity — a renamed file must not
      // resurrect a room under the wrong name.
      const room = ChatRoom.fromSnapshotFile(parsed);
      room.onChange = () => this.save(room);
      return room;
    } catch (error) {
      console.error(
        `[chat] skipping corrupt chat room file ${file}:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }
}
