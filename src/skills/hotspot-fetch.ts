import type { Hotspot, Skill } from '../engine/types.js';

export const hotspotFetchSkill: Skill<Hotspot[]> = {
  name: 'hotspot.fetch',
  title: '① 抓取热点',
  async run(ctx) {
    const keywords = ctx.persona.topicPreferences ?? [];
    const hits = await ctx.sources.hotspot.fetch({ keywords, limit: 10 });
    ctx.emit(`  抓到 ${hits.length} 条热点`);
    return hits;
  },
};
