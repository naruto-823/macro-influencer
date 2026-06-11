import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Hotspot } from '../engine/types.js';
import { CachedHotspotSource } from './cached-hotspot.js';
import type { HotspotSource } from './hotspot-source.js';

const SAMPLE: Hotspot[] = [{ id: 'h1', title: '热点', heat: 1, source: 'test', keywords: [] }];

/** 记录被调用次数的内层源。 */
function countingSource(): HotspotSource & { calls: number } {
  return {
    calls: 0,
    async fetch() {
      this.calls++;
      return SAMPLE;
    },
  };
}

function tmpFile() {
  return join(mkdtempSync(join(tmpdir(), 'cache-')), 'hotspots.json');
}

describe('CachedHotspotSource', () => {
  it('TTL 内第二次走缓存，不再调内层源', async () => {
    const inner = countingSource();
    const src = new CachedHotspotSource(inner, { ttlMs: 10_000, file: tmpFile(), now: () => 1000 });
    expect(await src.fetch({ limit: 40 })).toEqual(SAMPLE);
    expect(await src.fetch({ limit: 40 })).toEqual(SAMPLE);
    expect(inner.calls).toBe(1); // 第二次命中缓存
  });

  it('TTL 过期后重新抓取', async () => {
    const inner = countingSource();
    let t = 1000;
    const src = new CachedHotspotSource(inner, { ttlMs: 10_000, file: tmpFile(), now: () => t });
    await src.fetch({ limit: 40 });
    t = 1000 + 10_001; // 超过 TTL
    await src.fetch({ limit: 40 });
    expect(inner.calls).toBe(2);
  });

  it('不缓存空结果', async () => {
    const empty: HotspotSource & { calls: number } = {
      calls: 0,
      async fetch() {
        this.calls++;
        return [];
      },
    };
    const src = new CachedHotspotSource(empty, { ttlMs: 10_000, file: tmpFile(), now: () => 1000 });
    await src.fetch({ limit: 40 });
    await src.fetch({ limit: 40 });
    expect(empty.calls).toBe(2); // 空结果不缓存，每次都重试
  });
});
