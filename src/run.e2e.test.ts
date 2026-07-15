import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineConfig } from './engine/workflow.js';
import { FakeLlmClient } from './llm/fake.js';
import { demoPersona } from './persona/examples/demo.js';
import { runPipeline } from './run.js';
import type { HotspotSource } from './sources/hotspot-source.js';

// E2E 不做真实出图合成（重、会拖慢/超时）：把素材目录指向空目录，⑨ 直接跳过。
process.env.CHAR_ASSETS_DIR = resolve('runs', '__no_assets__');

// 内联假热点源（离线、确定性），避免 E2E 打真实网络。
const fakeHotspot: HotspotSource = {
  async fetch() {
    return [{ id: 'h1', title: '测试热点', heat: 1, source: 'test', keywords: [] }];
  },
};

describe('runPipeline E2E（全链路用 FakeLlm）', () => {
  it('从热点跑到最终作品包', async () => {
    // 依次对应：recommend / topic.generate / deep.search(complete) / content.outline / content.draft /
    // content.refine 的 3 个维度裁判（demo 默认 maxRefineRounds=3，评分均达标→不触发改写） /
    // fact.check / risk.review / asset.assemble
    const judged = JSON.stringify({ score: 95, defects: [] });
    const llm = new FakeLlmClient([
      JSON.stringify({ picks: [{ index: 0, reason: '契合', angle: '角度' }] }),
      JSON.stringify({ topics: [{ title: '选题1', angle: '角度', rationale: '契合' }] }),
      '测试调研档案：关键事实见 https://example.com/fact',
      JSON.stringify({
        hookStrategy: '反差开头',
        thesis: '效率工具能救职场新人',
        sections: [{ heading: '痛点', points: ['天天加班'] }],
        goldenLines: ['少加班就是多活'],
        ending: '冲，评论区聊',
      }),
      JSON.stringify({ title: '初稿标题', body: '初稿正文，分享一个好用的小工具' }),
      judged,
      judged,
      judged,
      JSON.stringify({
        claims: [{ claim: '该工具能省2小时', confidence: 'green', basis: '档案佐证' }],
        summary: '整体可信',
      }),
      JSON.stringify({
        fixes: [],
        rewritten: { title: '终稿标题', body: '终稿正文，分享一个好用的小工具' },
      }),
      JSON.stringify({
        titles: ['终稿标题A', '终稿标题B', '终稿标题C'],
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
    // 深度调研节点已跑：退回 complete（online=false），并从报告里提取到来源。
    const research = bag['deep.search'] as { online: boolean; sources: string[] };
    expect(research.online).toBe(false);
    expect(research.sources).toEqual(['https://example.com/fact']);
  });
});
