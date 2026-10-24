import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { PresenceRegistry } from './core/presence.js';
import { attachWebSocket } from './http/ws.js';
import { MemoryRoomRepository } from './rooms/repository.js';
import { RoomManager } from './rooms/room-manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../../web/dist');

/** How often silent seats are re-checked for the stale fallback. */
const PRESENCE_SWEEP_MS = 15_000;

function main(): void {
  const config = loadConfig();

  const presence = new PresenceRegistry();
  const manager = new RoomManager({
    repository: new MemoryRoomRepository(),
    defaultRoomId: config.defaultRoomId,
    presence,
  });
  const defaultRoom = manager.initializeDefaultRoom();

  const app = createApp(manager, config, { webDist });
  const server = createServer(app);
  const wss = attachWebSocket(server, manager, { presence });

  // Seats with no session, viewer, or parked wait flip to `disconnected` once
  // their last call ages out. This only refreshes what the UI shows.
  const sweepTimer = setInterval(() => presence.sweep(), PRESENCE_SWEEP_MS);
  sweepTimer.unref();

  const serveWeb = existsSync(path.join(webDist, 'index.html'));

  server.listen(config.port, config.host, () => {
    const base = `http://${config.host}:${config.port}`;
    console.log(`[gomoku] server ready at ${base}`);
    console.log(`[gomoku] REST  ${base}/api`);
    console.log(`[gomoku] MCP   ${base}/mcp`);
    console.log(`[gomoku] WS    ws://${config.host}:${config.port}/ws`);
    console.log(
      `[gomoku] room  "${defaultRoom.id}" (${defaultRoom.getState().status})`,
    );
    if (serveWeb) {
      console.log(`[gomoku] web   ${base}/`);
    } else {
      console.log(
        '[gomoku] web/dist not found - run "pnpm build" to serve the UI from here, or use "pnpm dev" with Vite on 5173',
      );
    }
  });

  const shutdown = (signal: string): void => {
    console.log(`[gomoku] ${signal} received, shutting down`);
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
