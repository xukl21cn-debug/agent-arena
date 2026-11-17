import { createHash, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import express, { type Express } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { deliveryResultSchema, WorkError, WorkStore, workRequestSchema } from './store.js';

const endpoint = '/work/mcp';
const taskId = z.uuid();
const claimId = z.uuid();
type Role = 'coordinator' | 'runner';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function execute(action: () => unknown): CallToolResult {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(action()) }] };
  } catch (error) {
    if (!(error instanceof WorkError)) console.error('[work-mcp] tool failed', error);
    const value = error instanceof WorkError
      ? { code: error.code, message: error.message }
      : { code: 'INTERNAL_ERROR', message: '无法保存或读取接力任务。' };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }] };
  }
}

function workServer(store: WorkStore, role: Role): McpServer {
  const server = new McpServer({ name: 'arena-work', version: '0.1.0' });
  if (role === 'coordinator') {
    server.registerTool('create_task', {
      description: '把工作单交给本项目绑定的 DSH 会话。等待原轮次结束后，runner 会把结果投回本 Codex 会话。',
      inputSchema: workRequestSchema,
    }, (request) => execute(() => ({ taskId: store.create(request).id })));
    server.registerTool('get_task', {
      description: '读取工作任务、执行结果和复审回报。',
      inputSchema: { taskId },
    }, ({ taskId }) => execute(() => store.get(taskId)));
    server.registerTool('cancel_task', {
      description: '取消排队中的任务。取消待接管任务前，先确认原执行已停止。',
      inputSchema: { taskId, stoppedExecutionConfirmed: z.literal(true) },
    }, ({ taskId }) => execute(() => store.cancel(taskId)));
  } else {
    server.registerTool('claim_delivery', {
      description: '串行领取当前项目绑定的下一次执行或复审。',
      inputSchema: { requestId: workRequestSchema.shape.requestId.optional() },
    }, ({ requestId }) => execute(() => store.claimNext(requestId)));
    server.registerTool('renew_delivery', {
      description: '延长当前领取的执行租约。',
      inputSchema: { taskId, claimId },
    }, ({ taskId, claimId }) => execute(() => store.renew(taskId, claimId)));
    server.registerTool('complete_delivery', {
      description: '保存已绑定会话的最终回复，推进到下一阶段。',
      inputSchema: { taskId, claimId, result: deliveryResultSchema },
    }, ({ taskId, claimId, result }) => execute(() => store.complete(taskId, claimId, result)));
    server.registerTool('flag_delivery', {
      description: '登记失败或不明的投递结果，等待接管。',
      inputSchema: { taskId, claimId, reason: z.string().min(1).max(1000) },
    }, ({ taskId, claimId, reason }) => execute(() => store.flag(taskId, claimId, reason)));
  }
  return server;
}

/** Work mode has one explicitly configured project and session pair. */
export function mountWorkMcp(app: Express, config: ServerConfig, env = process.env): boolean {
  const coordinatorToken = env.ARENA_WORK_CODEX_TOKEN;
  const runnerToken = env.ARENA_WORK_RUNNER_TOKEN;
  const codexSession = env.ARENA_WORK_CODEX_SESSION;
  const workerSession = env.ARENA_WORK_DSH_SESSION;
  const workspace = env.ARENA_WORK_WORKSPACE;
  if (![coordinatorToken, runnerToken, codexSession, workerSession, workspace].some(Boolean)) return false;
  if (!coordinatorToken || coordinatorToken.length < 32 || !runnerToken || runnerToken.length < 32
      || runnerToken === coordinatorToken || !codexSession || !workerSession || !workspace
      || !path.isAbsolute(workspace) || !['127.0.0.1', '::1'].includes(config.host)) {
    throw new Error('Work MCP requires a local listener, two distinct tokens, two session IDs and an absolute workspace.');
  }

  const store = new WorkStore(config.dataDir, { codexSession, workerSession, workspace: realpathSync(workspace) });
  const coordinator = digest(`Bearer ${coordinatorToken}`);
  const runner = digest(`Bearer ${runnerToken}`);
  app.all(endpoint, express.json({ limit: '256kb' }), async (req, res) => {
    if (req.headers.origin !== undefined) {
      res.status(403).json({ error: 'Browser origins are not accepted by this local endpoint.' });
      return;
    }
    const supplied = digest(req.headers.authorization ?? '');
    const role = timingSafeEqual(supplied, coordinator) ? 'coordinator'
      : timingSafeEqual(supplied, runner) ? 'runner' : null;
    if (role === null) {
      res.set('WWW-Authenticate', 'Bearer').status(401).json({ error: 'Work MCP requires a binding token.' });
      return;
    }
    const server = workServer(store, role);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      await server.close();
    }
  });
  return true;
}
