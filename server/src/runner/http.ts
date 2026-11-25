import { Router, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { RUNNER_COMMAND_KINDS, RUNNER_EVENT_LEVELS, WORK_STATUSES } from '@arena/shared';
import { isLocalWorkOrigin } from '../work/http.js';
import { isWorkLoopback } from '../work/mcp.js';
import { RunnerError, type RunnerRegistry } from './registry.js';

const runnerId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u);
const runnerTask = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(120),
  status: z.enum(WORK_STATUSES),
  round: z.number().int().positive(),
  startedAt: z.number().int().nonnegative().optional(),
});
const registerInput = z.object({
  id: runnerId,
  name: z.string().trim().min(1).max(64),
  workspace: z.string().trim().min(1).max(1024),
  version: z.string().trim().min(1).max(100),
});
const heartbeatInput = z.object({ currentTask: runnerTask.nullable().optional() });
const eventInput = z.object({
  level: z.enum(RUNNER_EVENT_LEVELS),
  message: z.string().trim().min(1).max(2000),
  taskId: z.string().uuid().optional(),
});
const commandInput = z.object({
  kind: z.enum(RUNNER_COMMAND_KINDS),
  taskId: z.string().uuid().optional(),
});
const commandQuery = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
  timeoutMs: z.coerce.number().int().min(1_000).max(30_000).default(20_000),
});

export function createRunnerRouter(registry: RunnerRegistry): Router {
  const router = Router();
  router.use((req, res, next) => {
    if (!isWorkLoopback(req.hostname) || !isLocalWorkOrigin(req.headers.origin)) {
      res.status(403).json({ error: { code: 'INVALID_REQUEST', message: 'Runner 管理只接受本机访问。' } });
      return;
    }
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/', (_req, res) => res.json(registry.list()));
  router.post('/register', (req, res) => {
    if (!req.is('application/json')) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: '请发送 JSON 请求。' } });
      return;
    }
    res.json(registry.register(registerInput.parse(req.body)));
  });
  router.get('/:id', (req, res) => {
    const detail = registry.get(runnerId.parse(req.params.id));
    if (detail === undefined) {
      res.status(404).json({ error: { code: 'RUNNER_NOT_FOUND', message: '找不到该 runner。' } });
      return;
    }
    res.json(detail);
  });
  router.post('/:id/heartbeat', (req, res) => {
    if (!req.is('application/json')) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: '请发送 JSON 请求。' } });
      return;
    }
    res.json(registry.heartbeat(runnerId.parse(req.params.id), heartbeatInput.parse(req.body)));
  });
  router.post('/:id/events', (req, res) => {
    if (!req.is('application/json')) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: '请发送 JSON 请求。' } });
      return;
    }
    const id = runnerId.parse(req.params.id);
    res.json(registry.event(id, eventInput.parse(req.body)));
  });
  router.post('/:id/commands', (req, res) => {
    if (!req.is('application/json')) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: '请发送 JSON 请求。' } });
      return;
    }
    const id = runnerId.parse(req.params.id);
    const input = commandInput.parse(req.body);
    res.json(registry.enqueue(id, input.kind, input.taskId));
  });
  router.get('/:id/commands', async (req, res) => {
    const id = runnerId.parse(req.params.id);
    const query = commandQuery.parse(req.query);
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      res.json(await registry.waitForCommands(id, query.afterSeq, query.timeoutMs, controller.signal));
    } catch (error) {
      if (!res.headersSent) throw error;
    }
  });
  router.use(runnerErrorHandler());
  return router;
}

export function runnerErrorHandler(): ErrorRequestHandler {
  return (error, _req, res, next) => {
    if (!(error instanceof RunnerError) && !(error instanceof z.ZodError)) {
      next(error);
      return;
    }
    const code = error instanceof RunnerError ? error.code : 'INVALID_REQUEST';
    const status = code === 'RUNNER_NOT_FOUND' ? 404 : 400;
    res.status(status).json({
      error: {
        code,
        message: error instanceof RunnerError ? error.message : 'Runner 请求参数无效。',
      },
    });
  };
}
