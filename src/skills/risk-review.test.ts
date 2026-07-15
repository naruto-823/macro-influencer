import { describe, expect, it } from 'vitest';
import type { RefineResult, SkillContext } from '../engine/types.js';
import { FakeLlmClient } from '../llm/fake.js';
import { riskReviewSkill } from './risk-review.js';

function ctx(llm: FakeLlmClient, body: string): SkillContext {
  const refine: RefineResult = { final: { title: '标题', body }, rounds: [] };
  return {
    runId: 'r1',
    llm,
    judge: llm,
    // biome-ignore lint/suspicious/noExplicitAny: 不读 persona
    persona: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: 不触碰 sources
    sources: {} as any,
    bag: { 'content.refine': refine },
    emit: () => {},
    signal: new AbortController().signal,
  };
}

describe('risk.review', () => {
  it('命中敏感词标 high；按 fixes 对原文精确替换（不信 LLM 整篇 rewritten）', async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({ fixes: [{ from: '最好的', to: '我用过不错的', rule: '极限词' }] }),
    ]);
    const report = await riskReviewSkill.run(ctx(llm, '这是最好的，加微信'));
    expect(report.level).toBe('high'); // 命中导流词
    expect(report.hits.length).toBeGreaterThan(0);
    expect(report.fixes).toHaveLength(1);
    // from 在正文里精确替换 → 杜撰/违规表述被换掉
    expect(report.rewritten.body).toBe('这是我用过不错的，加微信');
  });

  it('fixes 的 from 在正文匹配不到则跳过、不误伤', async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({ fixes: [{ from: '正文里不存在的句子', to: 'x', rule: '事实存疑' }] }),
    ]);
    const report = await riskReviewSkill.run(ctx(llm, '今天分享一个好用的小工具'));
    expect(report.fixes).toEqual([]);
    expect(report.rewritten.body).toBe('今天分享一个好用的小工具');
  });

  it('无违规则 fixes 为空、原文原样返回', async () => {
    const llm = new FakeLlmClient([JSON.stringify({ fixes: [] })]);
    const report = await riskReviewSkill.run(ctx(llm, '今天分享一个好用的小工具'));
    expect(report.level).toBe('pass');
    expect(report.fixes).toEqual([]);
    expect(report.rewritten.body).toBe('今天分享一个好用的小工具');
  });
});
