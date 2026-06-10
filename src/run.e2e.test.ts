import { describe, expect, it } from 'vitest';
import type { EngineConfig } from './engine/workflow.js';
import { FakeLlmClient } from './llm/fake.js';
import { demoPersona } from './persona/examples/demo.js';
import { runPipeline } from './run.js';
import type { HotspotSource } from './sources/hotspot-source.js';

// 内联假热点源（离线、确定性），避免 E2E 打真实网络。
const fakeHotspot: HotspotSource = {
  async fetch() {
    return [{ id: 'h1', title: '测试热点', heat: 1, source: 'test', keywords: [] }];
  },
};

describe('runPipeline E2E（全链路用 FakeLlm）', () => {
  it('从热点跑到最终作品包', async () => {
    // 依次对应：hotspot.recommend / topic.generate / content.draft / content.refine / asset.assemble
    // （risk.review 因示例文案无敏感词命中而不调用 LLM）
    const llm = new FakeLlmClient([
      JSON.stringify({ picks: [{ index: 0, reason: '契合', angle: '角度' }] }),
      JSON.stringify({ topics: [{ title: '选题1', angle: '角度', rationale: '契合' }] }),
      JSON.stringify({ title: '初稿标题', body: '初稿正文，分享一个好用的小工具' }),
      JSON.stringify({
        scores: { hook: 90, emotion: 90, density: 90, style: 90, structure: 90 },
        total: 90,
        critique: '很好',
        revised: { title: '打磨标题', body: '打磨后的正文，分享一个好用的小工具' },
      }),
      JSON.stringify({
        titles: ['终稿标题A', '终稿标题B', '终稿标题C'],
        body: '终稿正文',
        imagePrompts: ['封面图', '配图2'],
        publishTips: '晚8点发，带话题#效率工具',
      }),
    ]);

    const engineCfg: EngineConfig = {
      skillTimeoutMs: 5000,
      runWallclockMs: 30_000,
      gate: async (_q, options) => options[0] ?? '', // 选题选第一个；风控自动"通过"
    };

    const bag = await runPipeline('run-e2e', {
      llm,
      persona: demoPersona,
      hotspot: fakeHotspot,
      engineCfg,
    });

    const asset = bag['asset.assemble'] as { titles: string[]; imagePrompts: string[] };
    expect(asset.titles).toHaveLength(3);
    expect(asset.imagePrompts.length).toBeGreaterThan(0);
    expect(bag['gate.topic.generate']).toBe('t1');
  });
});
