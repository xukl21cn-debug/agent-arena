import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import type { WorkTask } from '@arena/shared';
import type { DshConfig } from '../config.js';
import type { AgentAdapter, AgentRunOptions, AgentRunResult } from './types.js';

interface DshEvent {
  type?: string;
  sessionId?: string;
  text?: string;
  reason?: { kind?: string } | null;
  message?: string;
}

const MAX_STDERR = 64 * 1024;

/** Terminate the whole process tree, not just the `cmd.exe`/shell wrapper. */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * DSH's one-shot headless surface. Each invocation is one process; a persisted
 * `--session-id` resumes the conversation in that process's recorded cwd.
 */
export class DshHeadlessAdapter implements AgentAdapter {
  constructor(private readonly config: DshConfig) {}

  async run(task: WorkTask, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const args = [
      ...this.config.argsPrefix,
      '--profile', this.config.profile,
      '--json',
    ];
    if (options.resumeSessionId) args.push('--session-id', options.resumeSessionId);
    if (this.config.permissionMode) args.push('--permission-mode', this.config.permissionMode);
    if (this.config.approvalPolicy) args.push('--approval-policy', this.config.approvalPolicy);
    for (const dir of this.config.extraDirs) args.push('--add-dir', dir);
    args.push('-');

    return new Promise<AgentRunResult>((resolve, reject) => {
      const child = spawn(this.config.command, args, {
        cwd: task.workspace,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        shell: process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(this.config.command),
      });
      let sessionId: string | undefined;
      const reportSession = (id: string) => {
        if (sessionId === id) return;
        sessionId = id;
        options.onSessionId?.(id);
      };
      let finalEvent: DshEvent | undefined;
      let errorEvent: DshEvent | undefined;
      const textChunks: string[] = [];
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        const errorMessage = errorEvent?.message ? `${stderr}\n[event] ${errorEvent.message}` : stderr;
        resolve({
          ...(sessionId === undefined ? {} : { sessionId }),
          text: finalEvent?.text && finalEvent.text.trim() !== '' ? finalEvent.text : textChunks.join('\n'),
          reasonKind: timedOut ? 'timeout' : (finalEvent?.reason?.kind ?? (errorEvent ? 'error' : null)),
          exitCode,
          stderr: errorMessage.slice(-MAX_STDERR),
        });
      };

      const onAbort = () => { killTree(child); };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, this.config.timeoutMs);

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(new Error(`无法启动 DSH (${this.config.command})：${error.message}`));
      });

      const stdout = readline.createInterface({ input: child.stdout });
      stdout.on('line', (line) => {
        if (line.trim() === '') return;
        let event: DshEvent;
        try {
          event = JSON.parse(line) as DshEvent;
        } catch {
          // The CLI contract is NDJSON; keep an unexpected line for diagnostics
          // rather than failing the whole run on a stray diagnostic line.
          stderr = `${stderr}\n[stdout] ${line}`.slice(-MAX_STDERR);
          return;
        }
        switch (event.type) {
          case 'session':
            if (typeof event.sessionId === 'string') reportSession(event.sessionId);
            break;
          case 'text':
            if (typeof event.text === 'string') textChunks.push(event.text);
            break;
          case 'final':
            finalEvent = event;
            if (typeof event.sessionId === 'string') reportSession(event.sessionId);
            break;
          case 'error':
            errorEvent = event;
            break;
          default:
            break;
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-MAX_STDERR);
      });
      child.stdin.on('error', (error) => {
        stderr = `${stderr}\n[stdin] ${error.message}`.slice(-MAX_STDERR);
      });

      child.on('close', (code) => {
        stdout.close();
        finish(code ?? 1);
      });

      child.stdin.end(buildPrompt(task));
    });
  }
}

/** Build the task handoff. The result fence is the only machine-readable part of the final answer. */
export function buildPrompt(task: WorkTask): string {
  const docs = task.docs.length
    ? task.docs.map((doc) => `- ${doc.kind}: ${doc.path}（${doc.summary}）`).join('\n')
    : '- 无';
  return [
    '你是 Agent Arena 工作域的开发任务执行者。请直接在当前工作目录中完成下面的开发任务，不要询问，也不要调用工作域 MCP 工具。',
    '',
    `任务：${task.title}`,
    `任务编号：${task.id}`,
    `工作目录：${task.workspace}`,
    `任务分支：${task.branch}`,
    `基线提交：${task.base}`,
    '',
    '需求：',
    task.requirement,
    '',
    '验收标准：',
    ...task.acceptance.map((item, index) => `${index + 1}. ${item}`),
    '',
    '参考文档（相对工作区）：',
    docs,
    '',
    '执行要求：',
    '1. 先确认当前分支与任务分支一致；不一致时不要切换，直接在 unresolved 中说明。',
    '2. 实际修改代码并运行相关测试；需要提交时在当前分支提交，并记录完整的提交哈希。',
    '3. 不要修改任务范围之外的既有文件，不要伪造测试结果。',
    '4. 最终回复的最后必须输出且只输出一个 ```arena-result 代码块，JSON 字段如下：',
    '```arena-result',
    '{',
    '  "summary": "做了什么、测试结果、已知缺口",',
    '  "files": ["相对工作区的文件路径"],',
    '  "commits": ["7-64 位十六进制提交号"],',
    '  "tests": [{"command": "pnpm test", "outcome": "passed", "note": "可选"}],',
    '  "docs": [],',
    '  "unresolved": "仅当受阻时填写"',
    '}',
    '```',
    '字段格式约束（违反会导致回报被拒）：',
    '- files 是字符串数组；commits 是提交哈希字符串数组；没有就填 []；',
    '- docs 的元素必须是对象 {"kind":"other","path":"...","summary":"..."}，没有额外文档时保持 []，绝不能填字符串；',
    '- tests 的元素必须是对象；受阻无法提交时才填 unresolved，否则省略该字段。',
  ].join('\n');
}
