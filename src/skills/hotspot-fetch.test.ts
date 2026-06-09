import { describe, expect, it } from 'vitest';
import type { SkillContext } from '../engine/types.js';
import { MockHotspotSource } from '../sources/hotspot-source.js';
import { hotspotFetchSkill } from './hotspot-fetch.js';

function ctx(persona: Partial<{ topicPreferences: string[] }>): SkillContext {
  return {
    runId: 'r1',
    // biome-ignore lint/suspicious/noExplicitAny: 该 skill 不触碰 llm
    llm: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: 仅用到 topicPreferences
    persona: { topicPreferences: persona.topicPreferences } as any,
    sources: { hotspot: new MockHotspotSource() },
    bag: {},
    emit: () => {},
    signal: new AbortController().signal,
  };
}

describe('hotspot.fetch', () => {
  it('用 persona 偏好作为关键词抓热点', async () => {
    const hits = await hotspotFetchSkill.run(ctx({ topicPreferences: ['效率'] }));
    expect(Array.isArray(hits)).toBe(true);
    expect((hits as unknown[]).length).toBeGreaterThan(0);
  });

  it('无偏好时返回全部热点', async () => {
    const hits = (await hotspotFetchSkill.run(ctx({}))) as unknown[];
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });
});
