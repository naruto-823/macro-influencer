import { describe, expect, it } from 'vitest';
import { type Span, currentTrace, formatSpan, traceLlm, withTrace } from './trace.js';

describe('trace 上下文传播', () => {
  it('withTrace 内能读到 runId/skill，异步嵌套也保留', async () => {
    expect(currentTrace()).toEqual({});
    await withTrace({ runId: 'r1', skill: 'topic.generate' }, async () => {
      await Promise.resolve();
      expect(currentTrace()).toEqual({ runId: 'r1', skill: 'topic.generate' });
    });
    expect(currentTrace()).toEqual({});
  });

  it('traceLlm 返回内层结果，并把上下文用于 span', async () => {
    const out = await withTrace({ runId: 'r2', skill: 's' }, () =>
      traceLlm('complete', { model: 'm' }, async () => ({ result: 42, outTokens: 7 })),
    );
    expect(out).toBe(42);
  });

  it('traceLlm 透传内层异常', async () => {
    await expect(
      traceLlm('complete', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('formatSpan', () => {
  it('成功 span 一行摘要', () => {
    const s: Span = {
      ts: 't',
      type: 'llm',
      skill: 'x',
      name: 'complete',
      durationMs: 120,
      ok: true,
    };
    expect(formatSpan(s)).toContain('✓');
    expect(formatSpan(s)).toContain('complete');
    expect(formatSpan(s)).toContain('@x');
  });

  it('失败 span 带状态码与错误', () => {
    const s: Span = {
      ts: 't',
      type: 'http',
      name: 'code.newcli.com',
      durationMs: 30,
      ok: false,
      status: 429,
      error: 'Too Many Requests',
    };
    const line = formatSpan(s);
    expect(line).toContain('✗');
    expect(line).toContain('status=429');
    expect(line).toContain('Too Many Requests');
  });
});
