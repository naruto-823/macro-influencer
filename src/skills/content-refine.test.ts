import { describe, expect, it } from 'vitest';
import type { Draft, SkillContext } from '../engine/types.js';
import { FakeLlmClient } from '../llm/fake.js';
import { contentRefineSkill } from './content-refine.js';

const draft: Draft = { title: 't0', body: 'b0' };

function ctx(llm: FakeLlmClient, threshold = 80, maxRounds = 3): SkillContext {
  return {
    runId: 'r1',
    llm,
    // biome-ignore lint/suspicious/noExplicitAny: 仅读风格与阈值
    persona: {
      styleGuide: '口语化',
      refineThreshold: threshold,
      maxRefineRounds: maxRounds,
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
    expect(res.final.title).toBe('t1');
    expect(res.rounds[0]?.total).toBe(85);
  });

  it('未达标则继续打磨，直到达标', async () => {
    const llm = new FakeLlmClient([round(70, 't1'), round(90, 't2')]);
    const res = await contentRefineSkill.run(ctx(llm, 80));
    expect(res.rounds).toHaveLength(2);
    expect(res.final.title).toBe('t2');
  });

  it('始终不达标则到 maxRounds 停，取最后一稿', async () => {
    const llm = new FakeLlmClient([round(50, 't1'), round(55, 't2')]);
    const res = await contentRefineSkill.run(ctx(llm, 80, 2));
    expect(res.rounds).toHaveLength(2);
    expect(res.final.title).toBe('t2');
  });
});
