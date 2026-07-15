import { describe, expect, it } from 'vitest';
import type { SkillContext, Topic } from '../engine/types.js';
import type { LlmResearchOpts, LlmResearchResult } from '../llm/client.js';
import { FakeLlmClient } from '../llm/fake.js';
import { deepSearchSkill } from './deep-search.js';

const topics: Topic[] = [
  { id: 't1', title: '查理芒格的一生', angle: '生平解读', rationale: 'r1' },
  { id: 't2', title: '孙宇晨买画', angle: '事件剖析', rationale: 'r2' },
];

function ctx(llm: SkillContext['llm'], gateChoice: string): SkillContext {
  return {
    runId: 'r1',
    llm,
    judge: llm,
    // biome-ignore lint/suspicious/noExplicitAny: 测试不依赖人设细节
    persona: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: 不触碰 sources
    sources: {} as any,
    bag: { 'topic.generate': topics, 'gate.topic.generate': gateChoice },
    emit: () => {},
    signal: new AbortController().signal,
  };
}

describe('deep.search', () => {
  it('后端不支持联网时退回 complete，online=false，并按选题写 prompt', async () => {
    const llm = new FakeLlmClient(['一句话背景。\n参考资料\nhttps://example.com/a']);
    const res = await deepSearchSkill.run(ctx(llm, 't2'));
    expect(res.online).toBe(false);
    expect(res.topic).toBe('孙宇晨买画');
    expect(res.sources).toEqual(['https://example.com/a']);
    expect(llm.calls[0]?.prompt).toContain('孙宇晨买画');
  });

  it('后端支持 research 时走联网，online=true，从报告提取去重链接', async () => {
    const calls: LlmResearchOpts[] = [];
    const llm = {
      async complete() {
        throw new Error('不应走 complete');
      },
      async completeJson() {
        throw new Error('不应走 completeJson');
      },
      async research(opts: LlmResearchOpts): Promise<LlmResearchResult> {
        calls.push(opts);
        return {
          text: '关键事实见 https://a.com/1 和 https://a.com/1 还有 https://b.com/2',
          online: true,
        };
      },
    };
    const res = await deepSearchSkill.run(ctx(llm, 't1'));
    expect(res.online).toBe(true);
    expect(res.sources).toEqual(['https://a.com/1', 'https://b.com/2']);
    expect(calls[0]?.prompt).toContain('查理芒格的一生');
  });

  it('research 抛错时退回 complete，不中断流水线', async () => {
    const llm = {
      async complete() {
        return '退回模型知识的档案';
      },
      async completeJson() {
        throw new Error('未用到');
      },
      async research(): Promise<LlmResearchResult> {
        throw new Error('联网超时');
      },
    };
    const res = await deepSearchSkill.run(ctx(llm, 't1'));
    expect(res.online).toBe(false);
    expect(res.report).toBe('退回模型知识的档案');
  });
});
