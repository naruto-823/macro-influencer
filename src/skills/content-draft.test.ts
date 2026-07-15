import { describe, expect, it } from 'vitest';
import type { SkillContext, Topic } from '../engine/types.js';
import { FakeLlmClient } from '../llm/fake.js';
import { contentDraftSkill } from './content-draft.js';

const topics: Topic[] = [
  { id: 't1', title: '选题1', angle: '角度1', rationale: 'r1' },
  { id: 't2', title: '选题2', angle: '角度2', rationale: 'r2' },
];

function ctx(llm: FakeLlmClient, gateChoice: string): SkillContext {
  return {
    runId: 'r1',
    llm,
    judge: llm,
    // biome-ignore lint/suspicious/noExplicitAny: 仅读风格与样本
    persona: { styleGuide: '口语化', sampleNotes: [{ title: 's', body: 'b' }] } as any,
    // biome-ignore lint/suspicious/noExplicitAny: 不触碰 sources
    sources: {} as any,
    bag: { 'topic.generate': topics, 'gate.topic.generate': gateChoice },
    emit: () => {},
    signal: new AbortController().signal,
  };
}

describe('content.draft', () => {
  it('按 gate 选中的选题 id 出初稿，并把选中选题写入 prompt', async () => {
    const llm = new FakeLlmClient([JSON.stringify({ title: '标题A', body: '正文A' })]);
    const draft = await contentDraftSkill.run(ctx(llm, 't2'));
    expect(draft.title).toBe('标题A');
    expect(draft.body).toBe('正文A');
    expect(llm.calls[0]?.prompt).toContain('选题2');
  });

  it('gate 选了不存在的 id 则退回第一个选题', async () => {
    const llm = new FakeLlmClient([JSON.stringify({ title: 't', body: 'b' })]);
    await contentDraftSkill.run(ctx(llm, 'nope'));
    expect(llm.calls[0]?.prompt).toContain('选题1');
  });
});
