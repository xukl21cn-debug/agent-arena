import { describe, expect, it } from 'vitest';
import { fallbackResult, parseAgentResult } from '../src/result.js';

const valid = {
  summary: '实现并验证了改动',
  files: ['runner/src/index.ts'],
  commits: ['abcdef0'],
  tests: [{ command: 'pnpm --filter @arena/runner test', outcome: 'passed' }],
  docs: [],
};

describe('parseAgentResult', () => {
  it('reads the last arena-result fence and applies defaults', () => {
    const text = [
      '前面还有一些说明',
      '```json',
      '{"summary":"不是结果块"}',
      '```',
      '```arena-result',
      JSON.stringify({ summary: valid.summary, commits: valid.commits }),
      '```',
    ].join('\n');
    const parsed = parseAgentResult(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      summary: valid.summary,
      commits: valid.commits,
      files: [],
      tests: [],
      docs: [],
    });
  });

  it('rejects a result with neither commits nor unresolved', () => {
    const parsed = parseAgentResult('```arena-result\n{"summary":"没有提交"}\n```');
    expect(parsed).toMatchObject({ ok: false });
  });

  it('treats an empty unresolved field as absent', () => {
    const parsed = parseAgentResult(`\`\`\`arena-result\n${JSON.stringify({ ...valid, unresolved: '' })}\n\`\`\``);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.unresolved).toBeUndefined();
    expect(parsed.value.commits).toEqual(valid.commits);
  });

  it('rejects an invalid path', () => {
    const parsed = parseAgentResult(`\`\`\`arena-result\n${JSON.stringify({ ...valid, files: ['../escape.ts'] })}\n\`\`\``);
    expect(parsed).toMatchObject({ ok: false });
  });

  it('returns a reason when no fence exists', () => {
    expect(parseAgentResult('plain final answer')).toMatchObject({ ok: false, reason: expect.stringContaining('arena-result') });
  });
});

describe('fallbackResult', () => {
  it('keeps the final text and records the parse failure as unresolved', () => {
    const result = fallbackResult('agent summary', '解析失败');
    expect(result).toMatchObject({
      summary: 'agent summary',
      files: [],
      commits: [],
      docs: [],
      unresolved: '解析失败',
    });
  });
});
