import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { ROOM_ID_PATTERN } from '@arena/shared';
import type { ChatStore } from './store.js';
import { ChatRoom } from './chat-room.js';
import {
  ChatError,
  DEFAULT_CHAT_POLICY,
  type ChatPolicy,
  type ChatRoomSnapshot,
  type ChatRoomSnapshotFile,
} from './model.js';

export function assertChatRoomId(roomId: unknown): asserts roomId is string {
  if (typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) {
    throw new ChatError(
      'INVALID_ROOM_ID',
      `Invalid roomId "${String(roomId)}": expected 1-32 characters of [a-zA-Z0-9_-].`,
    );
  }
}

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
  /** Detaches each room's persistence listener; a deleted room must not save. */
  private readonly unsubscribes = new Map<string, () => void>();
  private readonly chatDir: string;

  constructor(
    dataDir: string,
    private readonly store?: ChatStore,
  ) {
    this.chatDir = path.join(dataDir, 'chat');
    // Only the file mode owns this directory. With a store the JSON tree is a
    // read-only import source, so recreating it would leave an empty `chat/`
    // behind after the legacy files were deleted.
    if (this.store === undefined) {
      mkdirSync(this.chatDir, { recursive: true });
    }
  }

  get chatDirectory(): string {
    return this.chatDir;
  }

  private fileFor(roomId: string): string {
    // Chat room ids go through the same validator as game rooms — the
    // pattern already forbids `/`, `\` and `..`, which is the whole
    // traversal surface for a filename built from the id.
    assertChatRoomId(roomId);
    return path.join(this.chatDir, `${roomId}.json`);
  }

  private save(room: ChatRoom): void {
    if (this.store) {
      this.store.save(room);
      return;
    }
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

  create(
    roomId: string,
    options: { title?: string; policy?: Partial<ChatPolicy> } = {},
  ): ChatRoom {
    assertChatRoomId(roomId);
    if (this.rooms.has(roomId)) {
      throw new ChatError(
        'ROOM_EXISTS',
        `Chat room "${roomId}" already exists.`,
      );
    }

    const room = new ChatRoom(roomId, options.title?.trim() || roomId, {
      ...DEFAULT_CHAT_POLICY,
      ...options.policy,
    });
    this.track(room);
    room.humanMember();
    this.rooms.set(roomId, room);
    this.save(room);
    return room;
  }

  /** Wire a room's mutations to its snapshot file. Both creation paths need it. */
  private track(room: ChatRoom): void {
    this.unsubscribes.get(room.id)?.();
    this.unsubscribes.set(room.id, room.subscribe(() => this.save(room)));
  }

  get(roomId: string): ChatRoom | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * The room if it exists, otherwise a fresh one.
   *
   * The game domain has always created rooms on demand — an agent naming a new
   * id gets a room. Chat only ever answered ROOM_NOT_FOUND, which made
   * "an agent opens a room by saying so" impossible in this domain. Both
   * domains now behave the same; `created` tells the caller which happened.
   */
  getOrCreate(
    roomId: string,
    options: { title?: string; policy?: Partial<ChatPolicy> } = {},
  ): ChatRoom {
    return this.rooms.get(roomId) ?? this.create(roomId, options);
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
          // The room's own clock, not "now": a lobby sorts by this, and a
          // timestamp that moves with every request would reshuffle itself.
          updatedAt: room.lastActivityAt(),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Remove the persisted room and the in-memory entry. */
  remove(roomId: string): void {
    this.unsubscribes.get(roomId)?.();
    this.unsubscribes.delete(roomId);
    this.rooms.delete(roomId);
    if (this.store) {
      this.store.delete(roomId);
      return;
    }
    const file = this.fileFor(roomId);
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }

  /**
   * Settle expired turn leases across every room. Settlement is lazy by
   * design — it fires when someone touches the room (send / pass / wait) —
   * so a room whose agents all left holds its dead lease forever; this
   * background pass closes that hole. One room's failure must not stop
   * the others from settling: the sweep is a side channel, not a critical
   * path (same posture as the archive prune).
   */
  sweep(now: number): void {
    for (const room of this.rooms.values()) {
      try {
        room.settleExpiredTurn(now);
      } catch (error) {
        console.error(
          `[chat] sweep failed for room "${room.id}":`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  /**
   * Rebuild every persisted chat room on boot. Closed rooms come back too —
   * their transcripts stay queryable. Corrupt files are skipped by load.
   */
  restoreAll(): void {
    if (this.store) {
      for (const { roomId, snapshot } of this.store.loadAll()) {
        if (this.rooms.has(roomId)) continue;
        const room = this.fromSnapshot(snapshot, roomId, 'sqlite');
        if (room) this.rooms.set(roomId, room);
      }
      return;
    }
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
    if (this.store) {
      const snapshot = this.store.load(roomId);
      return snapshot === null ? null : this.fromSnapshot(snapshot, roomId, 'sqlite');
    }
    const file = path.join(this.chatDir, `${roomId}.json`);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    let parsed: ChatRoomSnapshotFile;
    try {
      parsed = JSON.parse(raw) as ChatRoomSnapshotFile;
    } catch (error) {
      console.error(
        `[chat] skipping corrupt chat room file ${file}:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
    return this.fromSnapshot(parsed, roomId, file);
  }

  private fromSnapshot(
    parsed: ChatRoomSnapshotFile,
    roomId: string,
    source: string,
  ): ChatRoom | null {
    try {
      if (Object.hasOwn(parsed, 'tasks')) console.warn('[chat] 忽略旧任务字段', roomId);
      // The snapshot's own id wins as the identity — a renamed file must not
      // resurrect a room under the wrong name.
      const room = ChatRoom.fromSnapshotFile(parsed);
      // Both wiring points (create and restore) must subscribe, or a room
      // recovered on boot stops persisting its later messages.
      this.track(room);
      return room;
    } catch (error) {
      console.error(
        `[chat] skipping corrupt chat room ${source}:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }
}
