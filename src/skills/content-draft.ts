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
      system: '你是小红书爆款写手，严格模仿账号既有风格写笔记。',
      prompt: [
        `内容风格指南：${ctx.persona.styleGuide}`,
        '',
        '历史爆款样本（模仿其口吻、结构、emoji 习惯）：',
        samples,
        '',
        `本次选题：${topic.title}`,
        `切入角度：${topic.angle}`,
        '',
        '请写一篇小红书图文笔记，输出 JSON：{"title":"标题","body":"正文"}。',
        '标题要有钩子，正文分段、口语化、含适量 emoji 与话题标签。',
      ].join('\n'),
    });
    ctx.emit(`  初稿完成：${draft.title}`);
    return draft;
  },
};
