import type { Hotspot, RecommendedHotspot, Skill, Topic } from '../engine/types.js';

interface RawTopics {
  topics: Array<{ title: string; angle: string; rationale: string }>;
}

export const topicGenerateSkill: Skill<Topic[]> = {
  name: 'topic.generate',
  title: '② 生成选题集',
  async run(ctx) {
    const { persona } = ctx;
    // 优先用「精选推荐」做素材（已结合人设挑过、带角度）；没有则退回原始热点前 20 条。
    const recs = (ctx.bag['hotspot.recommend'] as RecommendedHotspot[]) ?? [];
    const hotspotLines = recs.length
      ? recs.map((r) => `- ${r.title}（${r.source}，建议角度：${r.angle}）`).join('\n')
      : ((ctx.bag['hotspot.fetch'] as Hotspot[]) ?? [])
          .slice(0, 20)
          .map((h) => `- ${h.title}（热度${h.heat}）`)
          .join('\n');

    const raw = await ctx.llm.completeJson<RawTopics>({
      schema: {
        type: 'object',
        properties: {
          topics: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                angle: { type: 'string' },
                rationale: { type: 'string' },
              },
              required: ['title', 'angle', 'rationale'],
            },
          },
        },
        required: ['topics'],
      },
      system: '你是资深小红书内容策划，擅长把热点结合账号人设拆成高潜力选题。',
      prompt: [
        `账号定位：${persona.positioning}`,
        `内容风格：${persona.styleGuide}`,
        persona.topicPreferences?.length ? `选题偏好：${persona.topicPreferences.join('、')}` : '',
        persona.forbiddenZones?.length
          ? `内容禁区（必须规避）：${persona.forbiddenZones.join('、')}`
          : '',
        '',
        '当前热点：',
        hotspotLines,
        '',
        '请产出 3-5 个选题，每个包含 title（选题名）、angle（切入角度）、rationale（为什么契合这个账号）。',
        '输出 JSON：{"topics":[{"title":"","angle":"","rationale":""}]}',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    const topics: Topic[] = raw.topics.map((t, i) => ({ id: `t${i + 1}`, ...t }));
    ctx.emit(`  生成 ${topics.length} 个选题`);
    return topics;
  },
};
