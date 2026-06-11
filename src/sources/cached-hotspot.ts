import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Hotspot } from '../engine/types.js';
import type { FetchOpts, HotspotSource } from './hotspot-source.js';

interface CacheEntry {
  ts: number;
  hotspots: Hotspot[];
}
type CacheFile = Record<string, CacheEntry>;

/**
 * 热点缓存装饰器：磁盘缓存 + TTL。命中且未过期 → 直接返回缓存，不重打真实接口；
 * 过期或未命中 → 调内层源抓取并写回缓存。重启进程也不丢（落盘）。失败静默、不影响主流程。
 */
export class CachedHotspotSource implements HotspotSource {
  private readonly inner: HotspotSource;
  private readonly ttlMs: number;
  private readonly file: string;
  private readonly clock: () => number;

  constructor(inner: HotspotSource, opts: { ttlMs: number; file: string; now?: () => number }) {
    this.inner = inner;
    this.ttlMs = opts.ttlMs;
    this.file = opts.file;
    this.clock = opts.now ?? Date.now;
  }

  private key(o: FetchOpts): string {
    return JSON.stringify({ keywords: o.keywords ?? [], limit: o.limit ?? null });
  }

  private async readCache(): Promise<CacheFile> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as CacheFile;
    } catch {
      return {};
    }
  }

  /** 缓存还剩多少秒有效；未命中/已过期返回 0。 */
  async ageRemainingMs(o: FetchOpts): Promise<number> {
    const entry = (await this.readCache())[this.key(o)];
    if (!entry) return 0;
    return Math.max(0, this.ttlMs - (this.clock() - entry.ts));
  }

  async fetch(o: FetchOpts): Promise<Hotspot[]> {
    const cache = await this.readCache();
    const k = this.key(o);
    const entry = cache[k];
    if (entry && this.clock() - entry.ts < this.ttlMs) {
      return entry.hotspots;
    }
    const hotspots = await this.inner.fetch(o);
    // 只缓存非空结果（避免把一次失败的空结果缓存 2 小时）
    if (hotspots.length > 0) {
      cache[k] = { ts: this.clock(), hotspots };
      try {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(this.file, JSON.stringify(cache));
      } catch {
        // 写缓存失败不影响返回
      }
    }
    return hotspots;
  }
}
