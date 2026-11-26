#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DshHeadlessAdapter } from './adapters/dsh.js';
import { loadRunnerConfig } from './config.js';
import { RunnerManagementClient, RunnerManagementError } from './management-client.js';
import { cancelCurrentTask, Runner } from './runner.js';
import { SessionStore } from './session-store.js';
import { WorkClient } from './work-client.js';

const COMMAND_POLL_TIMEOUT_MS = 20_000;

async function main(): Promise<void> {
  // `pnpm runner -- --config x` forwards the `--` literally, and parseArgs
  // would then treat everything after it as rejected positionals. Drop one
  // leading separator so both `pnpm runner --config x` and the documented
  // `--` form parse identically.
  const argv = process.argv.slice(2);
  const separator = argv.indexOf('--');
  const scriptArgs = separator === -1 ? argv : [...argv.slice(0, separator), ...argv.slice(separator + 1)];
  const { values } = parseArgs({
    args: scriptArgs,
    options: {
      config: { type: 'string', short: 'c' },
      once: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const config = loadRunnerConfig(values.config);
  const management = new RunnerManagementClient(
    config.serverUrl,
    config.id,
    config.name,
    config.workspace,
  );
  // The work domain binds the worker identity to the MCP session. After a
  // server restart the client opens a new session and rejoins under its own
  // name; say so where the runner is watched.
  const work = new WorkClient(config.serverUrl, config.name, () => {
    console.error('[runner] 工作域会话已失效，已重新连接并重新加入。');
    void management.event('info', '工作域会话失效，已重新连接并重新加入。').catch(() => undefined);
  });
  const sessions = new SessionStore(config.stateFile);
  const adapter = new DshHeadlessAdapter(config.dsh);
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
    const runner = new Runner(work, adapter, sessions, config.workspace, console, {
      emit: (level, message, taskId) => management.event(level, message, taskId),
    });
    // A server restart clears the in-memory registry; a live runner process
    // must re-register instead of going permanently invisible.
    const reRegister = async (trigger: string): Promise<void> => {
      try {
        await management.register();
        await management.event('info', `runner re-registered (${trigger})`);
        console.error('[runner] 注册表已失效，已自动重新注册。');
      } catch (error) {
        console.error('[runner] 重新注册失败：', error instanceof Error ? error.message : error);
      }
    };
    const isUnregistered = (error: unknown): boolean =>
      error instanceof RunnerManagementError && error.code === 'RUNNER_NOT_FOUND';    const heartbeatTimer = setInterval(() => {
      void management.heartbeat(runner.currentTask())
        .catch((error) => {
          if (isUnregistered(error)) void reRegister('heartbeat');
          else console.error('[runner] 心跳失败：', error instanceof Error ? error.message : error);
        });
    }, config.heartbeatIntervalMs);
    heartbeatTimer.unref();
    const commandLoop = (async () => {
      let cursor = sessions.commandCursor();
      while (!controller.signal.aborted) {
        try {
          const batch = await management.pollCommands(cursor, COMMAND_POLL_TIMEOUT_MS, controller.signal);
          for (const command of batch.commands) {
            if (command.kind === 'cancel') {
              const outcome = cancelCurrentTask(runner, command.taskId);
              const message = outcome === 'cancelled' ? '收到取消命令，终止当前 DSH 进程。'
                : outcome === 'other-task' ? `收到针对任务 ${command.taskId} 的取消命令，当前执行的是另一个任务，忽略。`
                  : '收到取消命令，但当前没有执行中的任务。';
              await management.event(outcome === 'cancelled' ? 'warn' : 'info', message, command.taskId)
                .catch((error) => console.error('[runner] 取消事件上报失败：', error instanceof Error ? error.message : error));
            }
          }
          cursor = { seq: batch.nextSeq, epoch: batch.epoch };
          sessions.setCommandCursor(cursor);
        } catch (error) {
          if (controller.signal.aborted) break;
          if (isUnregistered(error)) await reRegister('command poll');
          else console.error('[runner] 命令轮询失败：', error instanceof Error ? error.message : error);
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
