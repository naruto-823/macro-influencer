import type { Draft, RefineResult, RefineRound, Skill } from '../engine/types.js';

interface RawRound {
  scores: Record<string, number>;
  total: number;
  critique: string;
  revised: Draft;
}

const DIMENSIONS =
  '钩子强度(hook) / 情绪共鸣(emotion) / 信息密度(density) / 风格契合(style) / 结构节奏(structure)，每项 0-100。';

export const contentRefineSkill: Skill<RefineResult> = {
  name: 'content.refine',
  title: '③ 反复打磨成精品',
  async run(ctx) {
    const threshold = ctx.persona.refineThreshold ?? 80;
    const maxRounds = ctx.persona.maxRefineRounds ?? 3;
    let current = ctx.bag['content.draft'] as Draft;
    const rounds: RefineRound[] = [];

    for (let i = 1; i <= maxRounds; i++) {
      const raw = await ctx.llm.completeJson<RawRound>({
        system: '你是严苛的小红书内容评审兼改写专家。先按维度打分给评语，再据此改写出更好的一版。',
        prompt: [
          `内容风格指南：${ctx.persona.styleGuide}`,
          `评分维度：${DIMENSIONS}`,
          '',
          `当前标题：${current.title}`,
          `当前正文：\n${current.body}`,
          '',
          '请输出 JSON：',
          '{"scores":{"hook":0,"emotion":0,"density":0,"style":0,"structure":0},"total":0,"critique":"改进意见","revised":{"title":"改写后标题","body":"改写后正文"}}',
          'total 为五项综合（0-100）。revised 必须是据评语改进后的更优版本。',
        ].join('\n'),
      });
      rounds.push({ round: i, scores: raw.scores, total: raw.total, critique: raw.critique });
      current = raw.revised;
      ctx.emit(`  第${i}轮打磨：${raw.total} 分`);
      if (raw.total >= threshold) break;
    }

    return { final: current, rounds };
  },
};
