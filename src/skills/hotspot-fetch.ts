import type { Hotspot, Skill } from '../engine/types.js';

export const hotspotFetchSkill: Skill<Hotspot[]> = {
  name: 'hotspot.fetch',
  title: '① 抓取热点',
  async run(ctx) {
    const keywords = ctx.persona.topicPreferences ?? [];
    // 取较多条，便于界面按平台分组展示各自榜单；下游选题也有更多真实热搜词可选。
    const hits = await ctx.sources.hotspot.fetch({ keywords, limit: 40 });
    ctx.emit(`  抓到 ${hits.length} 条热点`);
    return hits;
  },
};
