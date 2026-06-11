import type { Draft, RefineResult, RefineRound, Skill } from '../engine/types.js';

interface RawRound {
  scores: Record<string, number>;
  total: number;
  critique: string;
  revised: Draft;
}

const DIMENSIONS =
  '钩子强度(hook：开篇是否用具体场景/反差把人拽住) / 情绪共鸣(emotion：有没有人味、情绪、能否共鸣转发) / 叙事与金句(density：是否沉浸式叙事+具体细节+金句密集，而非空泛说教或干巴列表) / 风格契合(style：与样本文风/口吻一致度) / 结构节奏(structure：钩子→展开→反转→金句收尾的节奏)，每项 0-100。';

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
        schema: {
          type: 'object',
          properties: {
            scores: {
              type: 'object',
              properties: {
                hook: { type: 'number' },
                emotion: { type: 'number' },
                density: { type: 'number' },
                style: { type: 'number' },
                structure: { type: 'number' },
              },
              required: ['hook', 'emotion', 'density', 'style', 'structure'],
            },
            total: { type: 'number' },
            critique: { type: 'string' },
            revised: {
              type: 'object',
              properties: { title: { type: 'string' }, body: { type: 'string' } },
              required: ['title', 'body'],
            },
          },
          required: ['scores', 'total', 'critique', 'revised'],
        },
        system:
          '你是严苛的小红书爆款评审兼改写专家。标准是「沉浸式叙事长文」：有钩子、有具体场景细节、金句密集、对读者喊话、把方法论揉进故事。凡是写成技术博客/说明文、干巴罗列 1.2.3.、带代码块或 markdown 标题、说教注水的，一律重扣分。先按维度打分给评语，再据此把它改写成更接近这个标准的版本。',
        prompt: [
          `内容风格指南（含质量铁律）：${ctx.persona.styleGuide}`,
          `评分维度：${DIMENSIONS}`,
          '',
          `当前标题：${current.title}`,
          `当前正文：\n${current.body}`,
          '',
          '请输出 JSON：',
          '{"scores":{"hook":0,"emotion":0,"density":0,"style":0,"structure":0},"total":0,"critique":"改进意见","revised":{"title":"改写后标题","body":"改写后正文"}}',
          'total 为五项综合（0-100）。revised 必须是据评语大幅改进后的更优版本：把列表改写成叙事、补具体细节与金句、删掉代码块和说教废话。',
        ].join('\n'),
      });
      rounds.push({ round: i, scores: raw.scores, total: raw.total, critique: raw.critique });
      // 仅当改写稿完整（标题+正文都非空）才采纳，避免某轮退化稿污染下游。
      if (raw.revised?.title?.trim() && raw.revised?.body?.trim()) current = raw.revised;
      ctx.emit(`  第${i}轮打磨：${raw.total} 分`);
      if (raw.total >= threshold) break;
    }

    return { final: current, rounds };
  },
};
