import type { Hotspot } from '../engine/types.js';

export interface FetchOpts {
  keywords?: string[];
  limit?: number;
}

/** 热点来源适配器。本期 Mock；真源（爬虫/三方榜单 API）后续实现同一接口即可。 */
export interface HotspotSource {
  fetch(opts: FetchOpts): Promise<Hotspot[]>;
}

const SEED: Hotspot[] = [
  {
    id: 'h1',
    title: '年轻人开始用AI管理时间了',
    heat: 9800,
    source: 'mock-trending',
    keywords: ['效率', 'AI', '时间管理'],
    summary: '越来越多职场新人用 AI 工具规划日程、自动化重复工作。',
  },
  {
    id: 'h2',
    title: '通勤包里到底该装什么',
    heat: 7200,
    source: 'mock-trending',
    keywords: ['好物', '通勤', '职场'],
    summary: '通勤好物清单类内容持续走高。',
  },
  {
    id: 'h3',
    title: '副业搞钱的5个低成本方向',
    heat: 8600,
    source: 'mock-trending',
    keywords: ['副业', '搞钱', '效率'],
    summary: '低门槛副业方向引发讨论。',
  },
];

export class MockHotspotSource implements HotspotSource {
  constructor(private readonly seed: Hotspot[] = SEED) {}

  async fetch(opts: FetchOpts): Promise<Hotspot[]> {
    let list = this.seed;
    const kws = opts.keywords?.filter(Boolean) ?? [];
    if (kws.length > 0) {
      list = list.filter((h) =>
        kws.some((kw) => h.title.includes(kw) || h.keywords.some((k) => k.includes(kw))),
      );
    }
    return list.slice(0, opts.limit ?? list.length);
  }
}
