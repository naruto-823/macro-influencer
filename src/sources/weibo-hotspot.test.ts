import { describe, expect, it } from 'vitest';
import { WeiboHotspotSource, parseWeiboHot } from './weibo-hotspot.js';

const SAMPLE = `
<div id="pl_top_realtimehot"><table><tbody>
<tr><td class="td-01">1</td><td class="td-02"><a href="/weibo?q=%23AI%23">AI大模型新突破</a> <span>1234567</span></td></tr>
<tr><td class="td-01">2</td><td class="td-02"><a href="/weibo?q=x">某剧官宣&amp;主演</a> <span>剧集 999</span></td></tr>
<tr><td class="td-01"></td><td class="td-02"><a href="/weibo?q=z">置顶无热度条目</a></td></tr>
</tbody></table></div>`;

describe('parseWeiboHot', () => {
  it('解析标题与热度，剥类目前缀与实体', () => {
    const hs = parseWeiboHot(SAMPLE);
    expect(hs).toHaveLength(3);
    expect(hs[0]?.title).toBe('AI大模型新突破');
    expect(hs[0]?.heat).toBe(1234567);
    expect(hs[1]?.title).toBe('某剧官宣&主演');
    expect(hs[1]?.heat).toBe(999); // 剥掉「剧集」前缀
    expect(hs[2]?.title).toBe('置顶无热度条目');
    expect(hs[0]?.source).toBe('微博热搜');
  });
});

describe('WeiboHotspotSource', () => {
  it('用注入 fetcher 抓取并解析，受 limit 限制', async () => {
    const src = new WeiboHotspotSource({ cookie: 'SUB=x', fetcher: async () => SAMPLE });
    const hs = await src.fetch({ limit: 2 });
    expect(hs).toHaveLength(2);
    expect(hs[0]?.title).toBe('AI大模型新突破');
  });

  it('无 cookie 直接返回空（不抓取、不造假）', async () => {
    let called = false;
    const src = new WeiboHotspotSource({
      cookie: '',
      fetcher: async () => {
        called = true;
        return SAMPLE;
      },
    });
    expect(await src.fetch({})).toEqual([]);
    expect(called).toBe(false);
  });

  it('被跳登录/无热搜表时返回空', async () => {
    const src = new WeiboHotspotSource({
      cookie: 'SUB=x',
      fetcher: async () => '<html>login</html>',
    });
    expect(await src.fetch({})).toEqual([]);
  });

  it('抓取异常时返回空', async () => {
    const src = new WeiboHotspotSource({
      cookie: 'SUB=x',
      fetcher: async () => {
        throw new Error('net');
      },
    });
    expect(await src.fetch({})).toEqual([]);
  });
});
