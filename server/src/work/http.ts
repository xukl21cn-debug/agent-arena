import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Router, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { isWorkLoopback } from './mcp.js';
import { createInput, id, readArtifact, reason, WorkError } from './model.js';
import { HUMAN_COORDINATOR_ID } from './store.js';
import type { WorkStore } from './store.js';

export function isLocalWorkOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && isWorkLoopback(url.hostname);
  } catch {
    return false;
  }
}

const text = (max: number) => z.string().trim().min(1).max(max);
const createBody = createInput.omit({ requestId: true }).extend({ requestId: text(200).optional() });
const reviewBody = z.object({
  decision: z.enum(['approve', 'rework']),
  summary: text(8000),
  findings: text(8000).optional(),
});

function gitContext(workspace: string): { branch: string | null; base: string | null } {
  try {
    const git = (args: string[]): string =>
      execFileSync('git', ['-C', workspace, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    return {
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      base: git(['rev-parse', 'HEAD']),
    };
  } catch {
    return { branch: null, base: null };
  }
}

/** What the work page needs from the runner registry to stop a running task. */
export interface TaskKillSwitch {
  list(): Array<{ id: string; currentTask: { id: string } | null }>;
  enqueue(id: string, kind: 'cancel', taskId?: string): unknown;
}

export function createWorkRouter(store: WorkStore, runners?: TaskKillSwitch): Router {
  const router = Router();
  router.use((req, res, next) => {
    if (!isWorkLoopback(req.hostname) || !isLocalWorkOrigin(req.headers.origin)) {
      res.status(403).json({ error: { code: 'INVALID_REQUEST', message: '工作看板只接受本机访问。' } });
      return;
    }
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/context', (_req, res) => {
    res.json({
      workspace: store.workspace,
      humanCoordinatorId: HUMAN_COORDINATOR_ID,
      ...gitContext(store.workspace),
    });
  });
  router.post('/tasks', (req, res) => {
    if (!req.is('application/json')) throw new WorkError('INVALID_REQUEST', '请发送 JSON 请求。');
    const body = createBody.parse(req.body);
    const input = createInput.parse({
      ...body,
      requestId: body.requestId ?? `web-${randomUUID()}`,
    });
    res.status(201).json(store.createForHuman(input));
  });
  router.get('/tasks', (_req, res) => res.json(store.list()));
  router.get('/tasks/:id', (req, res) => res.json(store.get(id.parse(req.params.id))));
  router.post('/tasks/:id/review', (req, res) => {
    if (!req.is('application/json')) throw new WorkError('INVALID_REQUEST', '请发送 JSON 请求。');
    const body = reviewBody.parse(req.body);
    res.json(store.reviewForHuman(id.parse(req.params.id), body));
  });
  router.get('/tasks/:id/artifact', (req, res) => {
    const task = store.get(id.parse(req.params.id));
    const docs = [...task.docs];
    for (const round of task.rounds) {
      docs.push(...(round.work?.docs ?? []));
      if (round.review) docs.push(round.review.doc);
    }
    const ref = docs.find((doc) => doc.path === req.query.path && doc.hash === req.query.hash);
    if (!ref) throw new WorkError('INVALID_ARTIFACT', '该文档没有记录在此任务中。');
    const { content } = readArtifact(store.workspace, ref);
    res.attachment(path.posix.basename(ref.path.replaceAll('\\', '/')));
    res.type('application/octet-stream').send(content);
  });
  router.post('/tasks/:id/approve-merge', (req, res) => {
    if (!req.is('application/json')) throw new WorkError('INVALID_REQUEST', '请发送 JSON 请求。');
    res.json(store.approveMerge(id.parse(req.params.id)));
  });
  router.post('/tasks/:id/takeover', (req, res) => {
    const body = z.object({ reason }).parse(req.body);
    res.json(store.takeover(id.parse(req.params.id), body.reason));
  });
  router.post('/tasks/:id/cancel', (req, res) => {
    const body = z.object({ reason }).parse(req.body);
    const taskId = id.parse(req.params.id);
    const task = store.cancelForHuman(taskId, body.reason);
    // The task is cancelled whatever the process does. A runner still executing
    // it also gets the command, named for this task: one queued while the runner
    // was offline must not stop a different task it runs later.
    if (runners) {
      for (const runner of runners.list()) {
        if (runner.currentTask?.id === taskId) runners.enqueue(runner.id, 'cancel', taskId);
      }
    }
    res.json(task);
  });
  router.post('/tasks/:id/resume', (req, res) => {
    res.json(store.resumeRound(id.parse(req.params.id)));
  });
  router.use(workErrorHandler());
  return router;
}

export function workErrorHandler(): ErrorRequestHandler {
  return (error, _req, res, next) => {
    if (!(error instanceof WorkError) && !(error instanceof z.ZodError)) {
      next(error);
      return;
    }
    const code = error instanceof WorkError ? error.code : 'INVALID_REQUEST';
    const status = code === 'TASK_NOT_FOUND' ? 404 : code === 'INVALID_STATE' ? 409 : 400;
    res.status(status).json({ error: { code, message: error instanceof WorkError ? error.message : '工作请求参数无效。' } });
  };
}
