import { describe, expect, it } from 'vitest';
import type { Draft, SkillContext } from '../engine/types.js';
import type { LlmClient, LlmCompleteOpts } from '../llm/client.js';
import { parseJson } from '../llm/client.js';
import { contentRefineSkill } from './content-refine.js';

// 正文要足够长（采纳门槛 >=300 字，防空/截断）。
const LONG = '初稿正文，比较空泛，缺乏具体的事实数据与案例支撑。'.repeat(15);
const draft: Draft = { title: 't0', body: LONG };

/** 可分别给 judge / writer 预置回复的假客户端。 */
class SplitFake implements LlmClient {
  readonly calls: LlmCompleteOpts[] = [];
  private i = 0;
  constructor(private readonly replies: string[]) {}
  async complete(opts: LlmCompleteOpts): Promise<string> {
    this.calls.push(opts);
    const r = this.replies[this.i++];
    if (r === undefined) throw new Error(`回复用尽（第 ${this.i} 次）`);
    return r;
  }
  async completeJson<T>(opts: LlmCompleteOpts): Promise<T> {
    return parseJson<T>(await this.complete(opts));
  }
}

function ctx(llm: LlmClient, judge: LlmClient, threshold = 85, maxRounds?: number): SkillContext {
  return {
    runId: 'r1',
    llm,
    judge,
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

const verdict = (score: number, defects: string[]) => JSON.stringify({ score, defects });
// 写手现在走纯文本：正文 + ===CHANGES=== + 逐行改动。
const rewritten = (body: string, changes: string[]) =>
  `${body}\n===CHANGES===\n${changes.map((c) => `- ${c}`).join('\n')}`;
const NEW_BODY = '改写后更扎实的正文，补了大量真实数据、案例与时间线，信息密度明显提升。'.repeat(
  12,
);

describe('content.refine（Evaluator-Optimizer）', () => {
  it('某维度达标则跳过、不触发改写', async () => {
    // 4 个维度的裁判都给高分 → 写手一次都不被调用。
    const judge = new SplitFake([
      verdict(95, []),
      verdict(95, []),
      verdict(95, []),
      verdict(95, []),
    ]);
    const writer = new SplitFake([]);
    const res = await contentRefineSkill.run(ctx(writer, judge));
    expect(res.rounds).toHaveLength(4);
    expect(res.rounds.every((r) => r.applied === false)).toBe(true);
    expect(writer.calls).toHaveLength(0);
    expect(res.final.body).toBe(draft.body);
  });

  it('维度不达标则换模型评审+纯文本整篇改写，采纳并解析 changelog；标题沿用', async () => {
    const judge = new SplitFake([verdict(60, ['第一段太空泛'])]);
    const writer = new SplitFake([rewritten(NEW_BODY, ['补了具体数据', '加了时间线'])]);
    const res = await contentRefineSkill.run(ctx(writer, judge, 85, 1));
    expect(res.rounds).toHaveLength(1);
    expect(res.rounds[0]?.dimension).toBe('信息密度');
    expect(res.rounds[0]?.applied).toBe(true);
    expect(res.rounds[0]?.changes).toEqual(['补了具体数据', '加了时间线']);
    expect(res.final.body).toBe(NEW_BODY);
    expect(res.final.title).toBe(draft.title); // 标题不在精修范围，沿用原标题
  });

  it('改写返回空正文（run4 那个 bug）则判无效、不采纳', async () => {
    const judge = new SplitFake([verdict(60, ['信息太空'])]);
    const writer = new SplitFake([rewritten('', ['号称改了但正文空了'])]);
    const res = await contentRefineSkill.run(ctx(writer, judge, 85, 1));
    expect(res.rounds[0]?.applied).toBe(false);
    expect(res.rounds[0]?.changes).toEqual([]);
    expect(res.final.body).toBe(draft.body);
  });

  it('改写与原文相同（换皮不换肉）则判无效、不采纳', async () => {
    const judge = new SplitFake([verdict(60, ['有问题'])]);
    const writer = new SplitFake([rewritten(draft.body, ['号称改了其实没动'])]);
    const res = await contentRefineSkill.run(ctx(writer, judge, 85, 1));
    expect(res.rounds[0]?.applied).toBe(false);
    expect(res.rounds[0]?.changes).toEqual([]);
    expect(res.final.body).toBe(draft.body);
  });
});
