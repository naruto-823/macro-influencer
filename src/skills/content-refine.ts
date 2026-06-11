import type { Draft, RefineResult, RefineRound, Skill } from '../engine/types.js';

interface RawRound {
  scores: Record<string, number>;
  total: number;
  critique: string;
  revised: Draft;
}

const DIMENSIONS = [
  '钩子与爽感(hook：开篇钩子、节奏、情绪爆点是否够强——且改写后必须保留)',
  '平衡与负责(emotion：观点是否片面/危险/偷换概念；敢不敢补“但是/另一面/代价”，不把读者带沟里)',
  '论据与严谨(density：是否用个例/孤证伪装成普遍规律、有没有逻辑断点与以偏概全；有没有真证据或结构性根因)',
  '去AI味与文采(style：无机械过渡词/空泛套话/堆成语/工整假，金句密集、真人口语)',
  '论点深度(structure：有没有超出爽文的真洞察、把问题讲到根上、给出真正可执行又负责任的建议)',
  '——每项 0-100。',
].join(' / ');

/** 这类爆文最常见、最该被主编揪出来修掉的硬伤。 */
const CONTENT_FLAWS = [
  '① 用个例/孤证伪装成普遍规律（“我一个朋友…”就当成铁律）；',
  '② 逻辑断点、以偏概全（把结构性问题恶意解读成阴谋/故意压榨，因为那样更燃）；',
  '③ 建议片面或危险（只讲爽的一面，不讲反噬与代价，怂恿读者去做高风险的事）；',
  '④ 价值观偷换（把“经营个人价值”偷换成“忠诚=愚蠢”这类极端又有害的结论）；',
  '⑤ AI 味（机械过渡词[首先/其次/然而/总之]、空泛套话[“在这个XX的时代”]、堆成语、工整到假、正确的废话）。',
].join(' ');

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
          '你是一位极其严苛的资深主编兼毒舌书评人。读一篇稿子，你第一反应就是挑刺：证据够不够、逻辑有没有断、建议负不负责、有没有把个例当规律、有没有为了爽而偷换概念。你的任务，是把一篇“能转发但经不起推敲的爽文”，改成“既有爆点、又站得住脚”的真正好文——保留它的钩子、金句、能量和爽感，但补上思想深度、真实证据、完整逻辑和另一面的 nuance，删掉危险或偏激的部分。',
        prompt: [
          `账号风格指南：${ctx.persona.styleGuide}`,
          `评分维度：${DIMENSIONS}`,
          `这类爆文最常见的硬伤（重点排查）：${CONTENT_FLAWS}`,
          '',
          `当前标题：${current.title}`,
          `当前正文：\n${current.body}`,
          '',
          '请按顺序做三件事：',
          '1) critique：像最毒舌的书评人一样，具体点名这稿的硬伤——哪句是个例当规律、哪里逻辑断了、哪条建议只讲爽不讲反噬、哪儿偷换了概念、哪儿有 AI 味。要狠、要具体到句子，别泛泛而谈。',
          '2) scores：按维度打分。',
          '3) revised：据上面的诊断，把它改成更深、更可信、更负责的版本——',
          '   · 保留：钩子、金句、能量、真正的洞察和爽感（这些是命，不能丢）；',
          '   · 补上：把个例补上更普遍的支撑，或诚实承认“这是个例”；把逻辑断点接上（讲到结构性根因，而不是阴谋论）；给危险建议补上代价与更稳的替代方案；',
          '   · 删掉：偷换概念的极端结论、AI 味的套话与工整废话。',
          '',
          '【铁律】revised 必须与原稿有实质性的不同、并且明显更好（更有深度、更站得住、但依然爽、依然像真人写的）。这是一次真刀真枪的深度优化，不许原样照抄、也不许只换几个词。但保留原意的内核与那些真正打动人的句子。',
          '',
          '输出 JSON：',
          '{"scores":{"hook":0,"emotion":0,"density":0,"style":0,"structure":0},"total":0,"critique":"毒舌诊断","revised":{"title":"标题","body":"正文"}}',
          'total 为五项综合（0-100）。',
        ].join('\n'),
      });
      rounds.push({ round: i, scores: raw.scores, total: raw.total, critique: raw.critique });
      // 总是采纳这一轮的深度优化版（仅当完整），确保打磨稿真的不同于初稿、且逐轮变好。
      if (raw.revised?.title?.trim() && raw.revised?.body?.trim()) current = raw.revised;
      ctx.emit(`  第${i}轮打磨：${raw.total} 分`);
      if (raw.total >= threshold) break;
    }

    return { final: current, rounds };
  },
};
