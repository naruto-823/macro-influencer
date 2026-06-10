import { describe, expect, it } from 'vitest';
import type { Hotspot, SkillContext } from '../engine/types.js';
import { FakeLlmClient } from '../llm/fake.js';
import { hotspotRecommendSkill } from './hotspot-recommend.js';

const hotspots: Hotspot[] = [
  { id: 'a', title: '某明星塌房', heat: 900, source: '微博热搜', keywords: [] },
  { id: 'b', title: '字节大模型裁员', heat: 100, source: '知乎热榜', keywords: [] },
];

function ctx(llm: FakeLlmClient): SkillContext {
  return {
    runId: 'r1',
    llm,
    // biome-ignore lint/suspicious/noExplicitAny: 仅读 positioning/topicPreferences
    persona: { positioning: '大厂研发', topicPreferences: ['AI'] } as any,
    // biome-ignore lint/suspicious/noExplicitAny: 不触碰 sources
    sources: {} as any,
    bag: { 'hotspot.fetch': hotspots },
    emit: () => {},
    signal: new AbortController().signal,
  };
}

describe('hotspot.recommend', () => {
  it('按 LLM 选中的下标回填原始热点的来源/热度，并带理由与角度', async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({ picks: [{ index: 1, reason: '契合大厂技术线', angle: '裁员潮自保指南' }] }),
    ]);
    const recs = await hotspotRecommendSkill.run(ctx(llm));
    expect(recs).toHaveLength(1);
    expect(recs[0]?.title).toBe('字节大模型裁员');
    expect(recs[0]?.source).toBe('知乎热榜');
    expect(recs[0]?.heat).toBe(100);
    expect(recs[0]?.reason).toContain('大厂');
    expect(recs[0]?.angle).toBe('裁员潮自保指南');
    // prompt 里应带候选热搜与账号定位
    expect(llm.calls[0]?.prompt).toContain('字节大模型裁员');
    expect(llm.calls[0]?.prompt).toContain('大厂研发');
  });

  it('越界下标被忽略', async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({ picks: [{ index: 99, reason: 'x', angle: 'y' }] }),
    ]);
    expect(await hotspotRecommendSkill.run(ctx(llm))).toEqual([]);
  });

  it('无热点时直接返回空、不调用 LLM', async () => {
    const llm = new FakeLlmClient([]);
    const c = ctx(llm);
    c.bag = {};
    expect(await hotspotRecommendSkill.run(c)).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });
});
