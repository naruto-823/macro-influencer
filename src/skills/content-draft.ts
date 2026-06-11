import type { Draft, Skill, Topic } from '../engine/types.js';

export const contentDraftSkill: Skill<Draft> = {
  name: 'content.draft',
  title: '③ 生成初稿',
  async run(ctx) {
    const topics = (ctx.bag['topic.generate'] as Topic[]) ?? [];
    const choiceId = ctx.bag['gate.topic.generate'] as string | undefined;
    const topic = topics.find((t) => t.id === choiceId) ?? topics[0];
    if (!topic) throw new Error('content.draft: 没有可用选题');

    const samples = ctx.persona.sampleNotes
      .map((n) => `【标题】${n.title}\n【正文】${n.body}`)
      .join('\n---\n');

    const draft = await ctx.llm.completeJson<Draft>({
      schema: {
        type: 'object',
        properties: { title: { type: 'string' }, body: { type: 'string' } },
        required: ['title', 'body'],
      },
      system:
        '你是顶级小红书爆款写手。你写的不是说明文或技术博客，而是「沉浸式叙事长文」——像讲故事一样把读者拽进去，用具体场景、金句和情绪打动人。严格对标给你的历史爆款样本的水准与文风。',
      prompt: [
        `内容风格指南：${ctx.persona.styleGuide}`,
        '',
        '【这是必须对标的质量标杆样本，请把它的文风、叙事感、金句密度、具体细节学到位】：',
        samples,
        '',
        `本次选题：${topic.title}`,
        `切入角度：${topic.angle}`,
        '',
        '要求（务必做到）：',
        '1. 开篇用一个具体场景/反常事实/思想实验制造钩子，别上来就讲道理。',
        '2. 通篇是有人味的叙事与论证，大量具体可感的细节和例子；多用反问、对"你"喊话；金句密集、敢下判断。',
        '3. 方法论/要点要揉进故事里讲，绝不干巴巴罗列 1.2.3.4。',
        '4. 禁止代码块、禁止 markdown 标题(#)、禁止技术文档式死板分点和说教注水。技术选题也要写成有钩子有共鸣的故事。',
        '5. 标题强钩子；结尾落在一句有力的金句 + 互动引导；正文结尾带 8 个左右话题标签。长度向样本看齐（足够展开，不要敷衍）。',
        '',
        '输出 JSON：{"title":"标题","body":"正文"}。',
      ].join('\n'),
    });
    ctx.emit(`  初稿完成：${draft.title}`);
    return draft;
  },
};
