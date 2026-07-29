import { describe, expect, it } from 'vitest';
import type { SkillContext, Topic } from '../engine/types.js';
import { FakeLlmClient } from '../llm/fake.js';
import { contentOutlineSkill } from './content-outline.js';

const topics: Topic[] = [
  { id: 't1', title: '选题1', angle: '角度1', rationale: 'r1' },
  { id: 't2', title: '选题2', angle: '角度2', rationale: 'r2' },
];

function ctx(llm: FakeLlmClient, gateChoice = 't1'): SkillContext {
  return {
    runId: 'r1',
    llm,
    judge: llm,
    // biome-ignore lint/suspicious/noExplicitAny: 仅读定位与风格
    persona: { positioning: '职场效率', styleGuide: '口语化' } as any,
    // biome-ignore lint/suspicious/noExplicitAny: 该 skill 不触碰 sources
    sources: {} as any,
    bag: {
      'topic.generate': topics,
      'gate.topic.generate': gateChoice,
      'deep.search': { report: '调研档案', sources: [], online: true, topic: '选题1' },
    },
    emit: () => {},
    signal: new AbortController().signal,
  };
}

describe('content.outline', () => {
  it('按 gate 选中的选题生成大纲，并把选中选题写入 prompt', async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({
        hookStrategy: '反差开头',
        thesis: '核心判断',
        sections: [{ heading: '第一段', points: ['要点1'] }],
        goldenLines: ['金句1'],
        ending: '互动结尾',
      }),
    ]);
    const outline = await contentOutlineSkill.run(ctx(llm, 't2'));
    expect(outline.sections).toEqual([{ heading: '第一段', points: ['要点1'] }]);
    expect(llm.calls[0]?.prompt).toContain('选题2');
  });

  it('兼容模型把 sections 和 goldenLines 返回为带编号的对象', async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({
        hookStrategy: '悬念',
        thesis: '先下判断',
        sections: {
          s1: { heading: '还原事件', points: { p1: '事实1', p2: '事实2' } },
          s2: { heading: '拆解机会', points: ['机会1'] },
        },
        goldenLines: { g1: '金句1', g2: { section: '第二段', line: '金句2' } },
        ending: '评论区互动',
      }),
    ]);
    const outline = await contentOutlineSkill.run(ctx(llm));
    expect(outline.sections).toEqual([
      { heading: '还原事件', points: ['事实1', '事实2'] },
      { heading: '拆解机会', points: ['机会1'] },
    ]);
    expect(outline.goldenLines).toEqual(['金句1', '第二段：金句2']);
  });

  it('对不可用的 sections 返回明确错误', async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({
        hookStrategy: '悬念',
        thesis: '判断',
        sections: null,
        goldenLines: [],
        ending: '结尾',
      }),
    ]);
    await expect(contentOutlineSkill.run(ctx(llm))).rejects.toThrow('sections 必须是数组');
  });
});
