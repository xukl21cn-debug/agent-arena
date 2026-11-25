#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { DshHeadlessAdapter } from './adapters/dsh.js';
import { loadRunnerConfig } from './config.js';
import { Runner } from './runner.js';
import { SessionStore } from './session-store.js';
import { WorkClient } from './work-client.js';

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
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.error(`[runner] 连接 ${config.serverUrl}/work/mcp，工作区 ${config.workspace}。`);
  await work.connect();
  try {
    const joined = await work.join();
    console.error(`[runner] 已加入工作域：${joined.name}（${joined.participantId}）。`);
    const runner = new Runner(work, adapter, sessions, config.workspace);
    if (values.once) {
      const outcome = await runner.runOnce({ waitTimeoutMs: config.waitTimeoutMs, signal: controller.signal });
      console.error(`[runner] 单次轮询结果：${outcome}`);
    } else {
      await runner.runLoop({ waitTimeoutMs: config.waitTimeoutMs, signal: controller.signal });
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
