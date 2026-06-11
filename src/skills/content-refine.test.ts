import { describe, expect, it } from 'vitest';
import type { Draft, SkillContext } from '../engine/types.js';
import { FakeLlmClient } from '../llm/fake.js';
import { contentRefineSkill } from './content-refine.js';

const draft: Draft = { title: 't0', body: 'b0' };

function ctx(llm: FakeLlmClient, threshold = 80, maxRounds = 3): SkillContext {
  return {
    runId: 'r1',
    llm,
    persona: {
      styleGuide: '口语化',
      refineThreshold: threshold,
      maxRefineRounds: maxRounds,
      // biome-ignore lint/suspicious/noExplicitAny: 仅读风格与阈值
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: 不触碰 sources
    sources: {} as any,
    bag: { 'content.draft': draft },
    emit: () => {},
    signal: new AbortController().signal,
  };
}

function round(total: number, title: string) {
  return JSON.stringify({
    scores: { hook: total, emotion: total, density: total, style: total, structure: total },
    total,
    critique: '评语',
    revised: { title, body: `body-${title}` },
  });
}

describe('content.refine', () => {
  it('达标即停，记录轮次', async () => {
    const llm = new FakeLlmClient([round(85, 't1')]);
    const res = await contentRefineSkill.run(ctx(llm, 80));
    expect(res.rounds).toHaveLength(1);
    // 原稿(t0)已达标 → 保留原稿，不采纳改写版(t1)，避免越改越差。
    expect(res.final.title).toBe('t0');
    expect(res.rounds[0]?.total).toBe(85);
  });

  it('未达标则采纳改写继续，直到某稿达标即保留该稿', async () => {
    const llm = new FakeLlmClient([round(70, 't1'), round(90, 't2')]);
    const res = await contentRefineSkill.run(ctx(llm, 80));
    expect(res.rounds).toHaveLength(2);
    // 第1轮 t0 未达标→采纳 t1；第2轮 t1 达标→保留 t1（不再用 t2 覆盖）。
    expect(res.final.title).toBe('t1');
  });

  it('始终不达标则到 maxRounds 停，取最后一稿', async () => {
    const llm = new FakeLlmClient([round(50, 't1'), round(55, 't2')]);
    const res = await contentRefineSkill.run(ctx(llm, 80, 2));
    expect(res.rounds).toHaveLength(2);
    expect(res.final.title).toBe('t2');
  });
});
