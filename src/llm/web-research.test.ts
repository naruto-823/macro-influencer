import { describe, expect, it } from 'vitest';
import { parseBingHtml, parseBingRss } from './web-research.js';

describe('公网搜索结果解析', () => {
  it('解析 Bing RSS，并还原实体', () => {
    const xml = `<?xml version="1.0"?><rss><channel><item><title>携程 &amp; 市场监管</title><link>https://example.com/a?x=1&amp;y=2</link><description><![CDATA[<b>处罚</b>信息摘要]]></description></item></channel></rss>`;
    expect(parseBingRss(xml)).toEqual([
      {
        title: '携程 & 市场监管',
        url: 'https://example.com/a?x=1&y=2',
        snippet: '处罚 信息摘要',
      },
    ]);
  });

  it('解析 Bing HTML 结果块', () => {
    const html = `<li class="b_algo"><h2><a href="https://example.com/news">权威报道</a></h2><div><p>报道摘要</p></div></li>`;
    expect(parseBingHtml(html)).toEqual([
      { title: '权威报道', url: 'https://example.com/news', snippet: '报道摘要' },
    ]);
  });
});
