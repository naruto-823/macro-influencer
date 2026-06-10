import { describe, expect, it } from 'vitest';
import { MockHotspotSource } from './hotspot-source.js';
import { MultiHotspotSource, type Platform } from './web-hotspot.js';

const PLATFORMS: Platform[] = [
  { key: 'zhihu', label: '知乎热榜', url: 'http://x/zhihu' },
  { key: 'weibo', label: '微博热搜', url: 'http://x/weibo' },
];

/** 按 url 返回不同平台的假数据。 */
function fakeFetcher(map: Record<string, unknown[]>) {
  return async (url: string) => ({
    json: async () => ({ data: map[url.includes('zhihu') ? 'zhihu' : 'weibo'] ?? [] }),
  });
}

describe('MultiHotspotSource', () => {
  it('合并多平台，并把相关性高的排前面（八卦沉底）', async () => {
    const src = new MultiHotspotSource({
      platforms: PLATFORMS,
      fetcher: fakeFetcher({
        weibo: [{ title: '某明星塌房上热搜', hot_value: 9_000_000 }],
        zhihu: [{ title: '如何看待字节大模型团队裁员', hot_value_desc: '100 万热度' }],
      }),
    });
    const hits = await src.fetch({ limit: 10 });
    expect(hits).toHaveLength(2);
    // 含「字节/大模型/裁员」的知乎条目相关性高，排第一，尽管热度数字更低
    expect(hits[0]?.title).toContain('字节');
    expect(hits[0]?.source).toBe('知乎热榜');
  });

  it('按标题去重跨平台重复热点', async () => {
    const src = new MultiHotspotSource({
      platforms: PLATFORMS,
      fetcher: fakeFetcher({
        weibo: [{ title: '英伟达市值新高', hot_value: 5_000_000 }],
        zhihu: [{ title: '英伟达市值新高！', hot_value_desc: '200 万热度' }],
      }),
    });
    const hits = await src.fetch({ limit: 10 });
    expect(hits).toHaveLength(1);
  });

  it('受 limit 限制', async () => {
    const data = Array.from({ length: 40 }, (_, i) => ({ title: `科技话题${i}`, hot_value: i }));
    const src = new MultiHotspotSource({
      platforms: [PLATFORMS[0] as Platform],
      fetcher: fakeFetcher({ zhihu: data }),
    });
    expect(await src.fetch({ limit: 8 })).toHaveLength(8);
  });

  it('全部平台失败时回退 fallback', async () => {
    const src = new MultiHotspotSource({
      platforms: PLATFORMS,
      fetcher: async () => {
        throw new Error('network down');
      },
      fallback: new MockHotspotSource(),
    });
    expect((await src.fetch({ limit: 3 })).length).toBeGreaterThan(0);
  });
});
