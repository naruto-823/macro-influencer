import type { Hotspot, RecommendedHotspot, Skill } from '../engine/types.js';
import { DEFAULT_BOOST_TERMS } from '../sources/web-hotspot.js';

interface RawPicks {
  picks?: Array<{ index?: number; reason?: string; angle?: string }>;
}

/** 与账号的相关度：命中加权词的数量（标题+摘要）。 */
function relevance(h: Hotspot): number {
  const text = h.title + (h.summary ?? '');
  return DEFAULT_BOOST_TERMS.reduce((n, t) => (text.includes(t) ? n + 1 : n), 0);
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
    if (all.length === 0) return [];
    // 候选池按「账号相关性」重排（而非热搜词优先），把科技/财富/职场/人物事件顶上来、娱乐沉底，取 top30。
    const candidates = [...all]
      .sort((a, b) => relevance(b) - relevance(a) || b.heat - a.heat)
      .slice(0, 30);

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
      system:
        '你是资深小红书选题操盘手。你深知这个账号的爆款公式：不是干巴巴的科技/职场科普，而是「借热点人物或事件，做有深度、有人性洞察、敢下判断的锐评与解读」。',
      prompt: [
        `账号定位：${persona.positioning}`,
        persona.topicPreferences?.length ? `选题偏好：${persona.topicPreferences.join('、')}` : '',
        persona.forbiddenZones?.length
          ? `内容禁区（必须规避）：${persona.forbiddenZones.join('、')}`
          : '',
        '',
        '【该账号已验证的爆款打法（务必照这个思路选）】：',
        '  · 借热点人物（名人/大佬/网红/争议人物）→ 深扒其生平经历、起落与成事逻辑（例：张雪峰的死讯热点 → 解读他替普通人"算计"未来的一生）。',
        '  · 借热点事件（行业/社会/安全/商业大事件）→ 剖析事件的严重性、底层逻辑与对普通人的影响（例：快手被黑产攻击 → 剖析黑产产业链有多可怕）。',
        '  · 借网红/名人八卦争议 → 站在人性与价值观的高度，深度锐评当事人（例：某网红打胎事件 → 从人性角度犀利剖析主人公）。',
        '  · 也兼顾：大厂技术/职场内幕、AI 与商业、财富认知——但同样要做成有观点、有故事、有锐度的解读，不是科普。',
        '',
        '候选热搜（带下标）：',
        list,
        '',
        '请挑出 6-8 个最能套用上面爆款打法、最有爆点的热点（候选里一定有合适的人物/事件，必须选满，不要返回空）。',
        '每个给出：index（下标）、reason（这条能怎么蹭、爆点在哪、能锐评/深扒什么）、angle（具体到可以直接当选题的犀利切入角度，点明用"生平解读/事件剖析/人性锐评"哪种打法）。',
        '规避内容禁区。输出 JSON：{"picks":[{"index":0,"reason":"","angle":""}]}',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    // 容错：tool schema 非强制，模型偶尔把 picks 返回成非数组；统一兜成数组，按下标回填。
    const picks = Array.isArray(raw?.picks) ? raw.picks : [];
    const recs: RecommendedHotspot[] = [];
    for (const p of picks) {
      const h = typeof p?.index === 'number' ? candidates[p.index] : undefined;
      if (h && p?.reason && p?.angle) {
        recs.push({
          title: h.title,
          source: h.source,
          heat: h.heat,
          reason: p.reason,
          angle: p.angle,
        });
      }
    }
    // 兜底：LLM 没给出有效选择时，从「相关性已排序」的候选里取最相关的几条（candidates 已按相关性排序，故是真·对味的）。
    if (recs.length === 0) {
      for (const h of candidates.filter((c) => relevance(c) > 0).slice(0, 8)) {
        recs.push({
          title: h.title,
          source: h.source,
          heat: h.heat,
          reason: '与账号方向高度契合，建议优先蹭',
          angle: '可做：人物深扒 / 事件剖析 / 人性锐评 之一',
        });
      }
    }
    ctx.emit(`  精选 ${recs.length} 个高匹配爆款`);
    return recs;
  },
};
