import { describe, expect, it } from 'vitest';
import type { HotspotSource } from './hotspot-source.js';
import { MultiHotspotSource, type Platform } from './web-hotspot.js';

// 内联假兜底源（离线、确定性）。
const fakeFallback: HotspotSource = {
  async fetch() {
    return [{ id: 'fb', title: '兜底热点', heat: 1, source: 'fallback', keywords: [] }];
  },
};

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
  it('热搜词源（微博）整体排在长问题源（知乎）之前', async () => {
    const src = new MultiHotspotSource({
      platforms: PLATFORMS,
      fetcher: fakeFetcher({
        // 微博是热搜词源：即使这条不相关、热度更低，也排在知乎长问题前面
        weibo: [{ title: '某明星塌房上热搜', hot_value: 9 }],
        zhihu: [{ title: '如何看待字节大模型团队裁员', hot_value_desc: '100 万热度' }],
      }),
    });
    const hits = await src.fetch({ limit: 10 });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.source).toBe('微博热搜');
    expect(hits[1]?.source).toBe('知乎热榜');
  });

  it('同为热搜词源时，账号相关性高的排前面', async () => {
    const src = new MultiHotspotSource({
      platforms: PLATFORMS,
      fetcher: fakeFetcher({
        // 两条都来自微博（热搜词源）；含「英伟达/芯片」的更相关，排前，尽管热度更低
        weibo: [
          { title: '某明星塌房上热搜', hot_value: 9_000_000 },
          { title: '英伟达芯片再创新高', hot_value: 100 },
        ],
      }),
    });
    const hits = await src.fetch({ limit: 10 });
    expect(hits[0]?.title).toContain('英伟达');
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
      fallback: fakeFallback,
    });
    expect((await src.fetch({ limit: 3 })).length).toBeGreaterThan(0);
  });
});
