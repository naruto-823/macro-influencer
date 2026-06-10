import { describe, expect, it } from 'vitest';
import { MockHotspotSource } from './hotspot-source.js';
import { ZhihuHotspotSource } from './zhihu-hotspot.js';

describe('ZhihuHotspotSource', () => {
  it('把知乎热榜映射为 Hotspot[]，解析热度', async () => {
    const src = new ZhihuHotspotSource({
      fetcher: async () => ({
        json: async () => ({
          data: [
            { title: '如何评价 Claude 新模型', detail: '讨论', hot_value_desc: '1234 万热度' },
            { title: '燃油车还有未来吗', detail: '聊聊' },
          ],
        }),
      }),
    });
    const hits = await src.fetch({ limit: 5 });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.title).toBe('如何评价 Claude 新模型');
    expect(hits[0]?.heat).toBe(12340000);
    expect(hits[0]?.source).toBe('知乎热榜');
  });

  it('受 limit 限制', async () => {
    const data = Array.from({ length: 30 }, (_, i) => ({ title: `T${i}` }));
    const src = new ZhihuHotspotSource({ fetcher: async () => ({ json: async () => ({ data }) }) });
    expect(await src.fetch({ limit: 10 })).toHaveLength(10);
  });

  it('接口失败时回退到 fallback', async () => {
    const src = new ZhihuHotspotSource({
      fetcher: async () => {
        throw new Error('network down');
      },
      fallback: new MockHotspotSource(),
    });
    const hits = await src.fetch({ limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('空数据且无 fallback 时返回空数组（不抛错）', async () => {
    const src = new ZhihuHotspotSource({
      fetcher: async () => ({ json: async () => ({ data: [] }) }),
    });
    expect(await src.fetch({})).toEqual([]);
  });
});
