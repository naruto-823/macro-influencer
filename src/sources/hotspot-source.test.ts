import { describe, expect, it } from 'vitest';
import { MockHotspotSource } from './hotspot-source.js';

describe('MockHotspotSource', () => {
  it('返回内置热点，受 limit 限制', async () => {
    const src = new MockHotspotSource();
    const hits = await src.fetch({ limit: 2 });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.title).toBeTruthy();
    expect(hits[0]?.keywords.length).toBeGreaterThan(0);
  });

  it('按 keywords 过滤命中标题或关键词的热点', async () => {
    const src = new MockHotspotSource();
    const hits = await src.fetch({ keywords: ['效率'] });
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.every((h) => h.title.includes('效率') || h.keywords.some((k) => k.includes('效率'))),
    ).toBe(true);
  });
});
