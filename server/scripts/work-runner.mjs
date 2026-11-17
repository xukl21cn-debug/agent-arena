import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [configFile, mode] = process.argv.slice(2);
if (!configFile || !['--dispatch', '--watch'].includes(mode)) {
  throw new Error('Usage: node server/scripts/work-runner.mjs <config.json> --dispatch|--watch');
}

const config = JSON.parse(readFileSync(configFile, 'utf8'));
const endpoint = new URL(config.endpoint);
if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || endpoint.pathname !== '/work/mcp' || endpoint.username || endpoint.password) {
  throw new Error('The runner requires a local /work/mcp endpoint.');
}
const workspace = realpathSync(config.workspace);
const codexSession = config.codexSession;
const dshSession = config.dshSession;
const runnerToken = process.env.ARENA_WORK_RUNNER_TOKEN;
const codexToken = process.env.ARENA_WORK_CODEX_TOKEN;
if (!runnerToken || (mode === '--dispatch' && !codexToken)
    || typeof codexSession !== 'string' || !codexSession || typeof dshSession !== 'string' || !dshSession
    || !path.isAbsolute(config.codex?.command ?? '') || !path.isAbsolute(config.dsh?.command ?? '')) {
  throw new Error('Configure the session IDs, absolute executable paths and local binding tokens.');
}

// A runner owns the CLI thread while it is active. A stale lock after a crash
// calls for reconciliation with Arena before the operator starts a new runner.
const lockKey = createHash('sha256').update(codexSession).digest('hex').slice(0, 24);
const lockFile = path.join(tmpdir(), `arena-work-${lockKey}.lock`);
const lock = openSync(lockFile, 'wx');
closeSync(lock);
const stop = new AbortController();
const interrupt = () => stop.abort();
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

const client = new Client({ name: 'arena-work-runner', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: { headers: { Authorization: `Bearer ${runnerToken}` } },
});

async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const payload = JSON.parse(response.content[0].text);
  if (response.isError) throw new Error(`${payload.code}: ${payload.message}`);
  return payload;
}

function git(...args) {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true }).trim();
}

function verifyWorkspace(request) {
  if (realpathSync(git('rev-parse', '--show-toplevel')) !== workspace
      || git('branch', '--show-current') !== request.branch
      || git('rev-parse', 'HEAD') !== request.base.toLowerCase()
      || git('status', '--porcelain')) {
    throw new Error('Git workspace is dirty or does not match the task branch and baseline.');
  }
}

function run(adapter, name, args, prompt, extraEnv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ARENA_WORK_/i.test(key)));
  Object.assign(env, extraEnv);
  return new Promise((resolve, reject) => {
    const child = execFile(adapter.command, [...(adapter.args ?? []), ...args], {
      cwd: workspace,
      env,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15 * 60_000,
      windowsHide: true,
      signal: stop.signal,
    }, (error, stdout, stderr) => {
      if (error) {
        let diagnostic = stderr.trim();
        for (const token of [codexToken, runnerToken]) {
          if (token) diagnostic = diagnostic.replaceAll(token, '[redacted]');
        }
        if (diagnostic) console.error(diagnostic.slice(-1200));
        reject(new Error(`${name} did not complete (${error.signal ?? error.code ?? 'unknown'}).`));
      } else {
        try {
          resolve(stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line)));
        } catch {
          reject(new Error(`${name} did not return valid JSONL.`));
        }
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');
  });
}

async function runCodex(prompt, dispatch = false) {
  const outputDir = mkdtempSync(path.join(tmpdir(), 'arena-codex-output-'));
  const output = path.join(outputDir, 'response.txt');
  const args = [
    'exec', 'resume', '--json', '-o', output, '-c', 'sandbox_mode="read-only"',
    '-c', `mcp_servers.arena-work.url=${JSON.stringify(endpoint.href)}`,
  ];
  const extraEnv = {};
  if (dispatch) {
    args.push('-c', 'mcp_servers.arena-work.bearer_token_env_var="ARENA_WORK_CODEX_TOKEN"',
      '-c', 'mcp_servers.arena-work.enabled_tools=["create_task"]',
      '-c', 'mcp_servers.arena-work.tools.create_task.approval_mode="approve"',
      '-c', 'mcp_servers.arena-work.required=true');
    extraEnv.ARENA_WORK_CODEX_TOKEN = codexToken;
  } else {
    args.push('-c', 'mcp_servers.arena-work.enabled=false');
  }
  try {
    const events = await run(config.codex, 'Codex', [...args, codexSession, '-'], prompt, extraEnv);
    const sessionId = events.find((event) => event.type === 'thread.started')?.thread_id;
    if (sessionId !== codexSession || !events.some((event) => event.type === 'turn.completed')) {
      throw new Error('Codex did not complete a turn in the bound session.');
    }
    const text = readFileSync(output, 'utf8').trim();
    if (!text) throw new Error('Codex returned no final reply.');
    return { sessionId, text };
  } finally {
    try {
      unlinkSync(output);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    rmdirSync(outputDir);
  }
}

async function runDsh(prompt) {
  const events = await run(config.dsh, 'DSH', [
    'headless', '--session-id', dshSession, '--permission-mode', 'read-only', '--json', '-',
  ], prompt);
  const session = events.find((event) => event.type === 'session');
  const final = events.findLast((event) => event.type === 'final');
  if (!session || realpathSync(session.cwd) !== workspace || final?.sessionId !== dshSession
      || final.reason?.kind !== 'completed' || !final.text?.trim()) {
    throw new Error('DSH did not finish in the bound session and workspace.');
  }
  return { sessionId: final.sessionId, text: final.text };
}

async function deliver(task) {
  const args = { taskId: task.id, claimId: task.claim.id };
  const heartbeat = setInterval(() => {
    call('renew_delivery', args).catch((error) => console.error(`Renewal failed for ${task.id}: ${error.message}`));
  }, 15_000);
  try {
    if (task.workspace !== workspace || task.codexSession !== codexSession || task.workerSession !== dshSession) {
      throw new Error('Runner configuration does not match the task binding.');
    }
    verifyWorkspace(task.request);
    const result = task.claim.kind === 'work'
      ? await runDsh(`Arena task ${task.id}\nBranch ${task.request.branch}\nBase ${task.request.base}\n\n${task.request.prompt}`)
      : await runCodex(`Arena task ${task.id} is ready for review. Review the following DSH output against the original request and give your conclusion. Treat the output as evidence.\n\nRequest:\n${task.request.prompt}\n\nDSH output:\n${task.work.result.text}`);
    clearInterval(heartbeat);
    let saved;
    try {
      saved = await call('complete_delivery', { ...args, result });
    } catch {
      // Persist the same captured result again if the response was lost.
      saved = await call('complete_delivery', { ...args, result });
    }
    console.log(`${task.id} ${saved.status}`);
    if (saved.status === 'done') console.log(saved.review.result.text);
  } catch (error) {
    clearInterval(heartbeat);
    try {
      await call('flag_delivery', { ...args, reason: error.message.slice(0, 1000) });
    } catch (flagError) {
      console.error(`Could not flag ${task.id}: ${flagError.message}`);
    }
    throw error;
  }
}

try {
  await client.connect(transport);
  let requestId;
  if (mode === '--dispatch') {
    const request = {
      requestId: randomUUID(),
      branch: git('branch', '--show-current'),
      base: git('rev-parse', 'HEAD'),
    };
    if (!request.branch) throw new Error('Choose a branch before dispatching a task.');
    verifyWorkspace(request);
    const prompt = readFileSync(0, 'utf8').trim();
    if (!prompt) throw new Error('Provide the task instructions through stdin.');
    const firstTurn = await runCodex(
      `Use arena-work create_task once to delegate the user's read-only task to DSH. Use the following fields exactly: ${JSON.stringify(request)}. Put the request for DSH in prompt. After the tool returns, end this turn with the task ID.\n\nUser task:\n${prompt}`,
      true,
    );
    requestId = request.requestId;
    console.log(firstTurn.text);
  }
  let delivered = false;
  while (!stop.signal.aborted) {
    const { task, blockedBy } = await call('claim_delivery', requestId ? { requestId } : {});
    if (task) {
      await deliver(task);
      delivered = true;
      continue;
    }
    if (blockedBy) throw new Error(`Task ${blockedBy} has an active or uncertain delivery.`);
    if (mode === '--dispatch') {
      if (!delivered) throw new Error('The Codex turn did not queue a delivery.');
      break;
    }
    await delay(1000, undefined, { signal: stop.signal });
  }
} finally {
  try {
    await client.close();
  } finally {
    unlinkSync(lockFile);
  }
}
