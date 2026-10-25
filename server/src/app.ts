import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import type { ErrorResponse } from '@arena/shared';
import type { ServerConfig } from './config.js';
import { apiErrorHandler, createApiRouter } from './http/routes.js';
import { mountMcpHttp } from './mcp/http.js';
import type { RoomManager } from './rooms/room-manager.js';

export interface AppOptions {
  /** Directory holding the built web UI. Omit to run API/MCP only. */
  webDist?: string | null;
}

function sendNotFound(res: express.Response): void {
  const payload: ErrorResponse = {
    error: { code: 'INVALID_REQUEST', message: 'Route not found.' },
  };
  res.status(404).json(payload);
}

/**
 * Builds the Express app (REST + MCP + optional static web UI). Kept separate
 * from `index.ts` so integration tests can mount it on an ephemeral port.
 */
export function createApp(
  manager: RoomManager,
  config: ServerConfig,
  options: AppOptions = {},
): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use('/api', createApiRouter(manager, config));
  mountMcpHttp(app, manager, config);

  const webDist = options.webDist ?? null;
  const webIndex = webDist ? path.join(webDist, 'index.html') : null;

  if (webDist && webIndex && existsSync(webIndex)) {
    app.use(express.static(webDist, { index: false }));
    // SPA fallback for everything that is not an API / MCP / WS route.
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      if (
        req.path.startsWith('/api') ||
        req.path.startsWith('/mcp') ||
        req.path.startsWith('/ws')
      ) {
        next();
        return;
      }
      res.sendFile(webIndex);
    });
  }

  app.use(apiErrorHandler());
  app.use((_req, res) => {
    sendNotFound(res);
  });

  return app;
}
