import { describe, expect, it } from 'vitest';
import type { RiskReport, SkillContext } from '../engine/types.js';
import { FakeLlmClient } from '../llm/fake.js';
import { assetAssembleSkill } from './asset-assemble.js';

function ctx(llm: FakeLlmClient): SkillContext {
  const risk: RiskReport = {
    hits: [],
    level: 'pass',
    fixes: [],
    rewritten: { title: 't', body: 'b' },
  };
  return {
    runId: 'r1',
    llm,
    judge: llm,
    // biome-ignore lint/suspicious/noExplicitAny: 不读 persona
    persona: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: 不触碰 sources
    sources: {} as any,
    bag: { 'risk.review': risk },
    emit: () => {},
    signal: new AbortController().signal,
  };
}

describe('asset.assemble', () => {
  it('产出多标题候选、正文、配图prompt与发布建议', async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({
        titles: ['标题1', '标题2', '标题3'],
        body: '最终正文',
        imagePrompts: ['封面：xxx', '配图2：yyy'],
        publishTips: '晚8点发，带话题#效率工具',
      }),
    ]);
    const asset = await assetAssembleSkill.run(ctx(llm));
    expect(asset.titles).toHaveLength(3);
    expect(asset.imagePrompts.length).toBeGreaterThan(0);
    expect(asset.publishTips).toContain('话题');
  });
});
