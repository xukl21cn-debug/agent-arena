import path from 'node:path';
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const relative = text(1024).refine((file) =>
  !path.posix.isAbsolute(file) && !path.win32.isAbsolute(file)
  && !file.includes(':') && !file.includes('\0') && !file.split(/[\\/]/u).includes('..'));
const artifact = z.object({
  kind: z.enum(['brief', 'design', 'prompt', 'work_summary', 'code_doc', 'review', 'other']),
  path: relative,
  summary: text(500),
  hash: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().regex(/^[\da-f]{64}$/i).optional(),
  ),
});
const test = z.object({
  command: text(500),
  outcome: z.enum(['passed', 'failed']),
  note: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    text(1000).optional(),
  ),
});
const optionalUnresolved = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  text(2000).optional(),
);

export const agentResultSchema = z.object({
  summary: text(8000),
  files: z.array(relative).max(200).default([]),
  commits: z.array(z.string().regex(/^[\da-f]{7,64}$/i)).max(50).default([]),
  tests: z.array(test).max(50).default([]),
  docs: z.array(artifact).max(50).default([]),
  unresolved: optionalUnresolved,
}).refine((value) => value.commits.length > 0 || value.unresolved !== undefined, {
  message: 'commits 或 unresolved 至少填写一项',
});

export type AgentResult = z.infer<typeof agentResultSchema>;

export interface ParsedAgentResult {
  ok: true;
  value: AgentResult;
}

export interface FailedAgentResult {
  ok: false;
  reason: string;
}

/**
 * Read the last fenced `arena-result` block the agent produced. Models often
 * add prose or other code blocks around their terminal answer, so the contract
 * is deliberately one explicit fence and the last occurrence wins.
 */
export function parseAgentResult(text: string): ParsedAgentResult | FailedAgentResult {
  const arenaBlocks = [...text.matchAll(/```arena-result\s*\r?\n([\s\S]*?)```/giu)];
  const blocks = arenaBlocks.length > 0
    ? arenaBlocks
    : [...text.matchAll(/```json\s*\r?\n([\s\S]*?)```/giu)];
  const block = blocks.at(-1)?.[1]?.trim();
  if (!block) return { ok: false, reason: '未找到 ```arena-result 代码块' };
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch (error) {
    return { ok: false, reason: `arena-result 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = agentResultSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `arena-result 字段无效：${issue?.path.join('.') ?? 'unknown'} ${issue?.message ?? ''}`.trim() };
  }
  return { ok: true, value: parsed.data };
}

/** Build a submit-able result when the agent output cannot be trusted. */
export function fallbackResult(text: string, reason: string): AgentResult {
  const summary = text.trim().slice(0, 8000) || 'runner 未收到可解析的最终回复。';
  return {
    summary,
    files: [],
    commits: [],
    tests: [],
    docs: [],
    unresolved: reason.slice(0, 2000),
  };
}
