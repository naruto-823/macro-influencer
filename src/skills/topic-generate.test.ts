import { describe, expect, it } from 'vitest';
import type { Hotspot, SkillContext } from '../engine/types.js';
import { FakeLlmClient } from '../llm/fake.js';
import { topicGenerateSkill } from './topic-generate.js';

const hotspots: Hotspot[] = [
  { id: 'h1', title: '年轻人用AI管理时间', heat: 9800, source: 'm', keywords: ['效率', 'AI'] },
];

function ctx(llm: FakeLlmClient): SkillContext {
  return {
    runId: 'r1',
    llm,
    judge: llm,
    // biome-ignore lint/suspicious/noExplicitAny: 仅读 positioning/styleGuide/topicPreferences
    persona: { positioning: '职场效率', styleGuide: '口语化', topicPreferences: ['效率'] } as any,
    // biome-ignore lint/suspicious/noExplicitAny: 该 skill 不触碰 sources
    sources: {} as any,
    bag: { 'hotspot.fetch': hotspots },
    emit: () => {},
    signal: new AbortController().signal,
  };
}

describe('topic.generate', () => {
  it('基于热点与人设产出带 id 的选题集', async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({
        topics: [{ title: '选题1', angle: '角度1', rationale: '契合理由1' }],
      }),
    ]);
    const topics = await topicGenerateSkill.run(ctx(llm));
    expect(topics).toHaveLength(1);
    expect(topics[0]?.id).toBe('t1');
    expect(topics[0]?.title).toBe('选题1');
    expect(llm.calls[0]?.prompt).toContain('年轻人用AI管理时间');
    expect(llm.calls[0]?.prompt).toContain('职场效率');
  });
});
