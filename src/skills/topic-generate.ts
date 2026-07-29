import type { Hotspot, RecommendedHotspot, Skill, Topic } from '../engine/types.js';

interface RawTopic {
  title: string;
  angle: string;
  rationale: string;
}

interface RawTopics {
  topics: RawTopic[];
}

function normalizeTopics(raw: unknown): RawTopic[] {
  let candidate = raw;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      throw new Error('模型返回的选题不是有效 JSON');
    }
  }

  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    candidate = (candidate as Record<string, unknown>).topics;
  }
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      throw new Error('模型返回的 topics 字段不是有效 JSON');
    }
  }
  // 部分模型会返回 { topics: { t1: {...}, t2: {...} } }，兼容这种常见偏差。
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    candidate = Object.values(candidate as Record<string, unknown>);
  }
  if (!Array.isArray(candidate)) {
    throw new Error('模型返回的 topics 必须是数组');
  }

  return candidate.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`模型返回的第 ${index + 1} 个选题格式错误`);
    }
    const topic = item as Record<string, unknown>;
    if (
      typeof topic.title !== 'string' ||
      typeof topic.angle !== 'string' ||
      typeof topic.rationale !== 'string'
    ) {
      throw new Error(`模型返回的第 ${index + 1} 个选题缺少 title、angle 或 rationale`);
    }
    return { title: topic.title, angle: topic.angle, rationale: topic.rationale };
  });
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

    const topics: Topic[] = normalizeTopics(raw).map((t, i) => ({ id: `t${i + 1}`, ...t }));
    ctx.emit(`  生成 ${topics.length} 个选题`);
    return topics;
  },
};
