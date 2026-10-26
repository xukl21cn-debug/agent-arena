import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { ChatManager } from './chat/manager.js';
import { loadConfig } from './config.js';
import { PresenceRegistry } from './core/presence.js';
import { attachWebSocket } from './http/ws.js';
import { FileRoomRepository } from './rooms/repository.js';
import { RoomManager } from './rooms/room-manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../../web/dist');

/** How often silent seats are re-checked for the stale fallback. */
const PRESENCE_SWEEP_MS = 15_000;

function main(): void {
  const config = loadConfig();

  const presence = new PresenceRegistry();
  const repository = new FileRoomRepository(config.dataDir);
  const manager = new RoomManager({
    repository,
    defaultRoomId: config.defaultRoomId,
    presence,
  });
  // Recover the previous session's rooms before the default room is ensured:
  // a persisted `default` is restored (not recreated), and the boot log can
  // report the count while it is still exact.
  manager.restoreAll();
  const restoredCount = manager.list().length;
  const defaultRoom = manager.initializeDefaultRoom();

  // Same recovery for the chat domain: transcripts survive a restart.
  const chat = new ChatManager(config.dataDir);
  chat.restoreAll();
  const restoredChats = chat.list().length;

  const app = createApp(manager, config, { webDist, chat });
  const server = createServer(app);
  const wss = attachWebSocket(server, manager, { presence });

  // Seats with no session, viewer, or parked wait flip to `disconnected` once
  // their last call ages out. This only refreshes what the UI shows.
  const sweepTimer = setInterval(() => presence.sweep(), PRESENCE_SWEEP_MS);
  sweepTimer.unref();

  const serveWeb = existsSync(path.join(webDist, 'index.html'));

  server.listen(config.port, config.host, () => {
    const base = `http://${config.host}:${config.port}`;
    console.log(`[arena] server ready at ${base}`);
    console.log(`[arena] REST  ${base}/api`);
    console.log(`[arena] MCP   ${base}/mcp`);
    console.log(`[arena] WS    ws://${config.host}:${config.port}/ws`);
    console.log(
      `[arena] room  "${defaultRoom.id}" (${defaultRoom.getState().status})`,
    );
    console.log(
      `[arena] rooms  ${restoredCount} restored from ${repository.roomsDirectory}`,
    );
    console.log(
      `[arena] chats  ${restoredChats} restored from ${chat.chatDirectory}`,
    );
    if (serveWeb) {
      console.log(`[arena] web   ${base}/`);
    } else {
      console.log(
        '[arena] web/dist not found - run "pnpm build" to serve the UI from here, or use "pnpm dev" with Vite on 5173',
      );
    }
  });

  const shutdown = (signal: string): void => {
    console.log(`[arena] ${signal} received, shutting down`);
    clearInterval(sweepTimer);
    wss.close();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 3_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
