import type { Hotspot, RecommendedHotspot, Skill } from '../engine/types.js';

interface RawPicks {
  picks: Array<{ index: number; reason: string; angle: string }>;
}

/**
 * ①.5 精选推荐：从抓到的海量热搜里，结合账号人设挑出高匹配的爆款，给出推荐理由与切入角度。
 * LLM 只返回选中的下标 + 理由 + 角度，热度/来源等据下标回填原始热点，保证数据准确。
 */
export const hotspotRecommendSkill: Skill<RecommendedHotspot[]> = {
  name: 'hotspot.recommend',
  title: '🎯 精选推荐',
  async run(ctx) {
    const all = (ctx.bag['hotspot.fetch'] as Hotspot[]) ?? [];
    // 取排序后前 60 条作为候选（已热搜词+相关性优先），控制 prompt 体量。
    const candidates = all.slice(0, 60);
    if (candidates.length === 0) return [];

    const { persona } = ctx;
    const list = candidates
      .map((h, i) => `${i}. [${h.source}] ${h.title}（热度${h.heat}）`)
      .join('\n');

    const raw = await ctx.llm.completeJson<RawPicks>({
      schema: {
        type: 'object',
        properties: {
          picks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'number' },
                reason: { type: 'string' },
                angle: { type: 'string' },
              },
              required: ['index', 'reason', 'angle'],
            },
          },
        },
        required: ['picks'],
      },
      system: '你是资深小红书选题操盘手，擅长从全网热搜里挑出最适合某个账号的爆款机会。',
      prompt: [
        `账号定位：${persona.positioning}`,
        persona.topicPreferences?.length ? `选题偏好：${persona.topicPreferences.join('、')}` : '',
        persona.forbiddenZones?.length
          ? `内容禁区（必须规避）：${persona.forbiddenZones.join('、')}`
          : '',
        '',
        '候选热搜（带下标）：',
        list,
        '',
        '请从中挑出 6-8 个与该账号匹配度最高、最有爆款潜力的热点。',
        '对每一个给出：index（候选下标）、reason（为什么适合这个账号、有什么爆点）、angle（建议的内容切入角度）。',
        '只选真正契合定位的，宁缺毋滥；规避内容禁区。输出 JSON：{"picks":[{"index":0,"reason":"","angle":""}]}',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    const recs: RecommendedHotspot[] = [];
    for (const p of raw.picks ?? []) {
      const h = candidates[p.index];
      if (h)
        recs.push({
          title: h.title,
          source: h.source,
          heat: h.heat,
          reason: p.reason,
          angle: p.angle,
        });
    }
    // 兜底：LLM 没选出时，取相关性最高的前 8 条（candidates 已按热搜词+相关性排序），避免精选为空。
    if (recs.length === 0) {
      for (const h of candidates.slice(0, 8)) {
        recs.push({
          title: h.title,
          source: h.source,
          heat: h.heat,
          reason: '高相关度热点（自动兜底）',
          angle: '结合账号定位展开',
        });
      }
    }
    ctx.emit(`  精选 ${recs.length} 个高匹配爆款`);
    return recs;
  },
};
