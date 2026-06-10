import type { Hotspot } from '../engine/types.js';

export interface FetchOpts {
  keywords?: string[];
  limit?: number;
}

/**
 * 热点来源适配器。真源实现见 web-hotspot.ts 的 MultiHotspotSource
 * （并发聚合知乎/微博/抖音/头条热榜，按账号相关性排序）。
 */
export interface HotspotSource {
  fetch(opts: FetchOpts): Promise<Hotspot[]>;
}
