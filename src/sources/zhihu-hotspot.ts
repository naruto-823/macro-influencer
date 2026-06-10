import type { Hotspot } from '../engine/types.js';
import type { FetchOpts, HotspotSource } from './hotspot-source.js';

/** 注入式 fetch，便于测试离线打桩；默认用全局 fetch + 8s 超时。 */
export type Fetcher = (url: string) => Promise<{ json(): Promise<unknown> }>;

interface ZhihuItem {
  title?: string;
  detail?: string;
  hot_value_desc?: string;
  link?: string;
}

/** 从「1234 万热度」这类描述里解析出数值热度；解析不到则按排名兜底。 */
function parseHeat(desc: string | undefined, rankFallback: number): number {
  const m = String(desc ?? '').match(/[\d.]+/);
  if (!m) return rankFallback;
  const n = Number.parseFloat(m[0]);
  return Math.round(String(desc).includes('万') ? n * 10000 : n);
}

/**
 * 真实热点源：知乎热榜（经 60s 聚合接口）。
 * 知乎热榜以科技/商业/职场/知识类为主，契合本账号。失败时回退到注入的 fallback（如 Mock），永不抛错。
 */
export class ZhihuHotspotSource implements HotspotSource {
  private readonly url: string;
  private readonly fallback?: HotspotSource;
  private readonly fetcher: Fetcher;

  constructor(opts: { url?: string; fallback?: HotspotSource; fetcher?: Fetcher } = {}) {
    this.url = opts.url ?? 'https://60s-api.viki.moe/v2/zhihu';
    this.fallback = opts.fallback;
    this.fetcher = opts.fetcher ?? ((u) => fetch(u, { signal: AbortSignal.timeout(8000) }));
  }

  async fetch(opts: FetchOpts): Promise<Hotspot[]> {
    try {
      const res = await this.fetcher(this.url);
      const json = (await res.json()) as { data?: ZhihuItem[] };
      const items = json?.data ?? [];
      if (items.length === 0) throw new Error('知乎热榜为空');
      const hotspots: Hotspot[] = items
        .filter((it) => it.title)
        .map((it, i) => ({
          id: `zhihu-${i + 1}`,
          title: it.title as string,
          heat: parseHeat(it.hot_value_desc, items.length - i),
          source: '知乎热榜',
          keywords: [],
          summary: it.detail,
        }));
      return hotspots.slice(0, opts.limit ?? hotspots.length);
    } catch {
      return this.fallback ? this.fallback.fetch(opts) : [];
    }
  }
}
