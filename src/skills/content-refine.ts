import type { Draft, RefineResult, RefineRound, Skill } from '../engine/types.js';

interface RawRound {
  scores: Record<string, number>;
  total: number;
  critique: string;
  revised: Draft;
}

const DIMENSIONS = [
  '开篇钩子(hook：是否用具体场景/反差/悬念，一句话把人拽住)',
  '人味真诚(emotion：第一人称、有立场有锋芒有情绪，不油不说教不端着)',
  '具体质感(density：有具体场景/数字/真实例子/细节，反空泛、反“正确的废话”)',
  '去AI味(style：是否消灭了机械过渡词[首先/其次/然而/总之/综上]、空泛套话[“在这个XX的时代”“不仅…而且”“让我们”]、堆砌成语、工整到假的排比对仗)',
  '句式节奏(structure：长短句交错、敢断句、不连续三段同构、标点口语化)',
  '——每项 0-100，AI 味越重扣得越狠。',
].join(' / ');

/** AI 味黑名单：打磨时要专门揪出并清除。 */
const AI_TELLS =
  '机械过渡词（首先/其次/再者/然而/总之/总的来说/综上所述/值得一提的是）、空泛套话（在这个XX的时代/不仅…而且/让我们一起/随着…的发展）、成语堆砌、每段同一种句式与长度、过于工整的排比对仗、缺具体细节的“正确的废话”、第三人称客观脸、markdown 标题(#)与列表 1.2.3.、刻意 emoji 凑数。';

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
          '你是一位资深文字编辑兼作家，专治“AI 味”。你的任务不是重写内容、不是改观点，而是逐句打磨：把读起来像 AI 写的地方，改成像真人随口讲出来的。具体场景、真实细节、第一人称的立场与锋芒、长短句的节奏，是你的武器；机械过渡词、空泛套话、堆砌成语、工整到假的对仗，是你要消灭的敌人。',
        prompt: [
          `账号风格指南：${ctx.persona.styleGuide}`,
          `评分维度：${DIMENSIONS}`,
          `必须揪出并清除的 AI 味黑名单：${AI_TELLS}`,
          '',
          `当前标题：${current.title}`,
          `当前正文：\n${current.body}`,
          '',
          '请按顺序做三件事：',
          '1) critique：先具体指出这一稿里的 AI 味问题——点名是哪些句子/词（如哪里用了机械过渡词、哪句是空泛套话、哪段缺具体细节、哪里太工整），不要泛泛而谈。',
          '2) scores：按维度打分，AI 味越重分越低。',
          '3) revised：外科手术式修改——只动你在 critique 里点名的有问题的地方，其余一字不改。保留所有已经好的东西（生动场景、金句、口吻、具体细节、真实例子）。把机械过渡词和空泛套话删掉/换成具体的说法，仅此而已。',
          '',
          '【最重要的铁律】revised 的质量必须 ≥ 原稿，绝不能更差。如果原稿已经很好、你改不出明显更好的版本，就让 revised 完全等于原稿原文——宁可一字不改，也绝不能为了“有改动”而把好句子改差、把具体改抽象、把流畅改生硬。',
          '',
          '输出 JSON：',
          '{"scores":{"hook":0,"emotion":0,"density":0,"style":0,"structure":0},"total":0,"critique":"具体诊断","revised":{"title":"标题","body":"正文"}}',
          'total 为五项综合（0-100）。',
        ].join('\n'),
      });
      rounds.push({ round: i, scores: raw.scores, total: raw.total, critique: raw.critique });
      ctx.emit(`  第${i}轮打磨：${raw.total} 分`);
      // 已达标 → 当前稿已经够好，直接保留，绝不用改写版覆盖（避免越改越差）。
      if (raw.total >= threshold) break;
      // 未达标 → 采纳改写继续打磨（仅当改写稿完整）。
      if (raw.revised?.title?.trim() && raw.revised?.body?.trim()) current = raw.revised;
    }

    return { final: current, rounds };
  },
};
