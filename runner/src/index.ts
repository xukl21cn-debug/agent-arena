#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DshHeadlessAdapter } from './adapters/dsh.js';
import { loadRunnerConfig } from './config.js';
import { RunnerManagementClient } from './management-client.js';
import { Runner } from './runner.js';
import { SessionStore } from './session-store.js';
import { WorkClient } from './work-client.js';

const COMMAND_POLL_TIMEOUT_MS = 20_000;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      once: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const config = loadRunnerConfig(values.config);
  const work = new WorkClient(config.serverUrl, config.name);
  const sessions = new SessionStore(config.stateFile);
  const adapter = new DshHeadlessAdapter(config.dsh);
  const management = new RunnerManagementClient(
    config.serverUrl,
    config.id,
    config.name,
    config.workspace,
  );
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.error(`[runner] 连接 ${config.serverUrl}/work/mcp，工作区 ${config.workspace}。`);
  await work.connect();
  try {
    const joined = await work.join();
    const joinedWorkspace = realpathSync(joined.workspace);
    if (joinedWorkspace !== config.workspace) {
      throw new Error(`工作域工作区（${joinedWorkspace}）与 runner 配置（${config.workspace}）不一致，拒绝启动。`);
    }
    await management.register();
    await management.event('info', 'runner started');
    console.error(`[runner] 已加入工作域：${joined.name}（${joined.participantId}），注册 id ${config.id}。`);
    const runner = new Runner(work, adapter, sessions, config.workspace);
    const heartbeatTimer = setInterval(() => {
      void management.heartbeat(runner.currentTask())
        .catch((error) => console.error('[runner] 心跳失败：', error instanceof Error ? error.message : error));
    }, config.heartbeatIntervalMs);
    heartbeatTimer.unref();
    const commandLoop = (async () => {
      let afterSeq = sessions.commandCursor();
      while (!controller.signal.aborted) {
        try {
          const batch = await management.pollCommands(afterSeq, COMMAND_POLL_TIMEOUT_MS, controller.signal);
          for (const command of batch.commands) {
            if (command.kind === 'cancel') {
              const cancelled = runner.cancelCurrent();
              await management.event(
                cancelled ? 'warn' : 'info',
                cancelled ? '收到取消命令，终止当前 DSH 进程。' : '收到取消命令，但当前没有执行中的任务。',
                command.taskId,
              ).catch((error) => console.error('[runner] 取消事件上报失败：', error instanceof Error ? error.message : error));
            }
          }
          afterSeq = batch.nextSeq;
          sessions.setCommandCursor(afterSeq);
        } catch (error) {
          if (controller.signal.aborted) break;
          console.error('[runner] 命令轮询失败：', error instanceof Error ? error.message : error);
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    })();
    try {
      if (values.once) {
        const outcome = await runner.runOnce({ waitTimeoutMs: config.waitTimeoutMs, signal: controller.signal });
        console.error(`[runner] 单次轮询结果：${outcome}`);
      } else {
        await runner.runLoop({ waitTimeoutMs: config.waitTimeoutMs, signal: controller.signal });
      }
    } finally {
      clearInterval(heartbeatTimer);
      controller.abort();
      await commandLoop;
      await management.event('info', 'runner stopped').catch(() => undefined);
    }
  } finally {
    await work.close().catch((error) => {
      console.error('[runner] 关闭 MCP 会话失败：', error instanceof Error ? error.message : error);
    });
  }
}

main().catch((error) => {
  console.error('[runner] 启动失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
