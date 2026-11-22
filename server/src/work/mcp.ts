import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { WORK_STATUSES, type WorkStatus } from '@arena/shared';
import type { Express } from 'express';
import { z } from 'zod';
import { sessionContext, type SessionBindings } from '../session-context.js';
import { claimInput, createInput, id, mergeInput, name, reason, resultInput, reviewInput, role, WorkError } from './model.js';
import type { WorkStore } from './store.js';

const endpoint = '/work/mcp';
const bindingKey = 'work';

export const WORK_INSTRUCTIONS = [
  '开发任务接力。会话通过 join_work 声明统筹或执行角色，角色由工作职责决定。',
  '统筹先确认需求，再在一份 Proposal 或架构文档中写明方案与验收条件。派单引用已确认版本，附件类型为 brief。',
  '工作端用 wait_for_work 收件，执行后提交文件、提交号、测试及文档引用，再等复审。',
  '统筹用 wait_for_work 领取复审，将独立审核结论写回主文档，引用本轮版本并标为 review。已登记的附件路径和内容须保留，返工沿用同一任务。',
  '长时间工作或复审要在租约到期前调用 renew_claim。timeout 后可以继续等待。',
  '收到 finished 后，执行端确认收工。统筹等待网页放行后再执行合并和验证，推送前另等用户放行。',
  '任务阶段由领取、回报、复审和用户操作推进，本域不设聊天发言轮次、hop 或发言预算。',
].join('\n');

export function isWorkLoopback(host: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase());
}

const nextByStatus: Record<WorkStatus, string> = {
  queued: '等待执行者领取。',
  working: '执行者完成后回报，必要时续租。',
  pending_review: '统筹调用 wait_for_work 领取复审。',
  reviewing: '核对结果并提交复审。',
  rework_requested: '执行者领取下一轮返工。',
  pending_ack: '执行者收到结束通知后确认收工。',
  pending_merge_approval: '等待用户在网页放行。可带 afterStatus 继续等待。',
  merge_approved: '按用户放行执行合并和验证，再记录合并证据。',
  done: '任务已完成。',
  needs_attention: '核对工作区和实际执行状态，由用户接管。',
  cancelled: '任务已取消。',
};

function taskResult(task: { status: WorkStatus }) {
  return { ...task, hint: nextByStatus[task.status] };
}

async function run(action: () => unknown): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await action()) }] };
  } catch (error) {
    if (!(error instanceof WorkError)) console.error('[work-mcp] 工具调用失败', error);
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(error instanceof WorkError
        ? { code: error.code, message: error.message, hint: error.hint }
        : { code: 'INVALID_REQUEST', message: '工作任务请求失败。', hint: '查看服务端日志后重试。' }) }],
    };
  }
}

function registerTools(server: Server, store: WorkStore, bindings: SessionBindings): void {
  const tools = new Map<string, { definition: Tool; call: (args: unknown, signal: AbortSignal) => Promise<CallToolResult> }>();
  function registerTool<Schema extends z.ZodRawShape>(
    name: string,
    config: { description: string; inputSchema: Schema | z.ZodObject<Schema> },
    callback: (input: z.output<z.ZodObject<Schema>>, extra: { signal: AbortSignal }) => Promise<CallToolResult>,
  ): void {
    const schema = config.inputSchema instanceof z.ZodObject ? config.inputSchema : z.object(config.inputSchema);
    tools.set(name, {
      definition: {
        name, description: config.description,
        inputSchema: z.toJSONSchema(schema, { io: 'input' }) as Tool['inputSchema'],
        annotations: { readOnlyHint: name === 'get_task', destructiveHint: false, openWorldHint: false },
      },
      call: (args, signal) => {
        const parsed = schema.safeParse(args);
        if (parsed.success) return callback(parsed.data, { signal });
        return run(() => {
          const field = parsed.error.issues[0]?.path.join('.');
          throw new WorkError('INVALID_REQUEST', field ? `参数无效：${field}。` : '工作请求参数无效。');
        });
      },
    });
  }
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...tools.values()].map((tool) => tool.definition),
  }));
  server.setRequestHandler(CallToolRequestSchema, ({ params }, extra) => {
    const tool = tools.get(params.name);
    if (tool) return tool.call(params.arguments ?? {}, extra.signal);
    return run(() => { throw new WorkError('INVALID_REQUEST', '找不到工作工具。', '重新获取工具清单。'); });
  });
  const sessionId = () => {
    const current = sessionContext.getStore()?.sessionId;
    if (!current) throw new WorkError('IDENTITY_REQUIRED', '工作操作需要 MCP 会话。');
    return current;
  };
  const actorFor = (session: string) => {
    const actor = store.actorFor(session);
    if (!actor || actor.id !== bindings.participantOf(session, bindingKey)) {
      throw new WorkError('IDENTITY_REQUIRED', '请先调用 join_work。', '声明统筹或执行角色后重试。');
    }
    return actor;
  };
  const actor = () => actorFor(sessionId());

  registerTool('join_work', {
    description: '加入单项目工作域，声明统筹或执行角色。同名重连使用原身份。',
    inputSchema: { role, name: name.optional() },
  }, (input) => run(() => {
    const session = sessionId();
    const displayName = input.name ?? name.parse((sessionContext.getStore()?.client?.trim() || input.role).slice(0, 64));
    const member = store.join(input.role, displayName, session);
    bindings.bind(session, bindingKey, member.id);
    return { participantId: member.id, role: member.role, name: member.name, workspace: store.workspace,
      hint: member.role === 'worker' ? '调用 wait_for_work 收件。' : '用户确认需求后，用主文档的已确认版本派单。' };
  }));
  registerTool('leave_work', {
    description: '离开工作域。当前会话持有活跃执行、复审或合并时先完成操作。',
    inputSchema: {},
  }, () => run(() => {
    const session = sessionId();
    store.leave(actorFor(session), session);
    bindings.unbind(session, bindingKey);
    return { hint: '已离开工作域。' };
  }));
  registerTool('create_task', {
    description: '统筹派单，附分支、基线、验收标准。用 brief 引用主文档的已确认版本。',
    inputSchema: createInput,
  }, (input) => run(() => taskResult(store.create(actor(), input))));
  registerTool('get_task', {
    description: '查看自己参与的任务、轮次和证据。',
    inputSchema: { taskId: id },
  }, ({ taskId }) => run(() => taskResult(store.get(taskId, actor()))));
  registerTool('wait_for_work', {
    description: '长轮询。省略 taskId 才领取执行或复审。等待已见状态发生变化时，带 taskId 和 afterStatus。timeout 后继续等待。',
    inputSchema: {
      taskId: id.optional(),
      timeoutMs: z.number().int().min(1000).max(30000).optional(),
      afterStatus: z.enum(WORK_STATUSES).optional(),
    },
  }, (input, extra) => run(async () => {
    const session = sessionId();
    const member = actorFor(session);
    const value = await store.wait(member, {
      ...input, timeoutMs: input.timeoutMs ?? 20_000, signal: extra.signal,
      connected: () => bindings.participantOf(session, bindingKey) === member.id,
    });
    return { ...value, hint: value.task ? nextByStatus[value.task.status]
      : value.reason === 'timeout' ? '等待超时，可以继续等待。' : '会话已离开工作域。' };
  }));
  registerTool('submit_work_result', {
    description: '执行者提交当前轮次的执行回报。填写文件、提交、测试和文档。受阻时填写未解决项。',
    inputSchema: claimInput.extend({ result: resultInput }),
  }, ({ result, ...claim }) => run(() => taskResult(store.submitWork(actor(), claim, result))));
  registerTool('submit_review', {
    description: '统筹提交独立审核结论，用 review 引用主文档的本轮版本。返工时提供具体意见并开启下一轮。',
    inputSchema: reviewInput,
  }, (input) => run(() => taskResult(store.submitReview(actor(), input))));
  registerTool('ack_task_finished', {
    description: '执行者确认已收工，统筹随后等待用户在网页放行。',
    inputSchema: { taskId: id, round: claimInput.shape.round },
  }, ({ taskId, round }) => run(() => taskResult(store.acknowledge(actor(), taskId, round))));
  registerTool('renew_claim', {
    description: '续领当前执行或复审的租约。',
    inputSchema: claimInput,
  }, (input) => run(() => ({ ...store.renew(actor(), input), hint: '已续租。' })));
  registerTool('record_merge', {
    description: '统筹记录用户放行后的合并、测试与推送结果。失败或推送失败请如实记录。',
    inputSchema: mergeInput.extend({ taskId: id }),
  }, ({ taskId, ...input }) => run(() => taskResult(store.recordMerge(actor(), taskId, input))));
  registerTool('cancel_task', {
    description: '统筹取消任务。执行状态不明时先确认现场，再强制取消并说明原因。',
    inputSchema: { taskId: id, reason, force: z.boolean().optional() },
  }, (input) => run(() => taskResult(store.cancel(actor(), input.taskId, input.reason, input.force))));
}

export function mountWorkMcp(app: Express, store: WorkStore, bindings: SessionBindings): void {
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
  app.all(endpoint, async (req, res) => {
    const fail = (status: number, code: number, message: string) => {
      res.status(status).json({ jsonrpc: '2.0', id: null, error: { code, message } });
    };
    if (req.headers.origin !== undefined || !isWorkLoopback(req.hostname)) {
      fail(403, -32000, '工作 MCP 仅接收本机客户端连接。');
      return;
    }
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
      res.set('Allow', 'POST, GET, DELETE');
      fail(405, -32000, 'Method not allowed');
      return;
    }
    try {
      const supplied = req.headers['mcp-session-id'];
      const id = typeof supplied === 'string' ? supplied : undefined;
      if (id) {
        const session = sessions.get(id);
        if (!session) {
          fail(404, -32001, 'Session not found. 请重新连接并按原名 join_work。');
          return;
        }
        await sessionContext.run(
          { sessionId: id, client: session.server.getClientVersion()?.name },
          () => session.transport.handleRequest(req, res, req.body),
        );
        return;
      }
      if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
        fail(400, -32000, 'Missing MCP session. 请先初始化。');
        return;
      }
      const server = new Server({ name: 'arena-work', version: '0.2.0' }, {
        capabilities: { tools: {} }, instructions: WORK_INSTRUCTIONS,
      });
      registerTools(server, store, bindings);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sessionId) => { sessions.set(sessionId, { server, transport }); },
      });
      transport.onclose = () => {
        const sessionId = transport.sessionId;
        if (!sessionId) return;
        sessions.delete(sessionId);
        bindings.clear(sessionId);
        const actor = store.actorFor(sessionId);
        if (actor) {
          try { store.leave(actor, sessionId, true); }
          catch (error) { console.error('[work-mcp] 关闭会话失败', error); }
        }
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[work-mcp] 请求失败', error);
      if (!res.headersSent) fail(500, -32603, 'Internal server error');
    }
  });
}
