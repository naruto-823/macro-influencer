import { describe, expect, it } from 'vitest';
import type { RefineResult, SkillContext } from '../engine/types.js';
import { FakeLlmClient } from '../llm/fake.js';
import { riskReviewSkill } from './risk-review.js';

function ctx(llm: FakeLlmClient, body: string): SkillContext {
  const refine: RefineResult = { final: { title: '标题', body }, rounds: [] };
  return {
    runId: 'r1',
    llm,
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
  it('命中敏感词时调用 LLM 改写并标记风险等级', async () => {
    const llm = new FakeLlmClient([JSON.stringify({ title: '安全标题', body: '安全正文' })]);
    const report = await riskReviewSkill.run(ctx(llm, '这是最好的，加微信'));
    expect(report.level).toBe('high'); // 命中导流词
    expect(report.hits.length).toBeGreaterThan(0);
    expect(report.rewritten.body).toBe('安全正文');
  });

  it('无命中则 pass 且不调用 LLM，原文直接通过', async () => {
    const llm = new FakeLlmClient([]); // 一旦调用就会抛错
    const report = await riskReviewSkill.run(ctx(llm, '今天分享一个好用的小工具'));
    expect(report.level).toBe('pass');
    expect(report.rewritten.body).toBe('今天分享一个好用的小工具');
    expect(llm.calls).toHaveLength(0);
  });
});
