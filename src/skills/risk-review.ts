import type { Draft, RefineResult, RiskReport, Skill } from '../engine/types.js';
import { riskLevel, scanSensitive } from '../guardrails/sensitive-words.js';

export const riskReviewSkill: Skill<RiskReport> = {
  name: 'risk.review',
  title: '④ 过风控与敏感词',
  async run(ctx) {
    const draft = (ctx.bag['content.refine'] as RefineResult).final;
    const hits = scanSensitive(`${draft.title}\n${draft.body}`);
    const level = riskLevel(hits);

    if (hits.length === 0) {
      ctx.emit('  风控通过，无敏感词命中');
      return { hits, level, rewritten: draft };
    }

    const hitDesc = hits.map((h) => `「${h.term}」(${h.category})`).join('、');
    ctx.emit(`  命中 ${hits.length} 处：${hitDesc}，改写规避中…`);
    const rewritten = await ctx.llm.completeJson<Draft>({
      system: '你是小红书合规改写专家。在不损伤表达力的前提下规避平台违禁表述。',
      prompt: [
        '以下文案命中平台敏感/违禁表述，请改写规避，保持原意与风格：',
        `命中项：${hitDesc}`,
        '另外消除任何夸大功效、诱导消费、营销感过重的软性违规表述。',
        '',
        `标题：${draft.title}`,
        `正文：\n${draft.body}`,
        '',
        '输出 JSON：{"title":"改写后标题","body":"改写后正文"}',
      ].join('\n'),
    });
    return { hits, level, rewritten };
  },
};
