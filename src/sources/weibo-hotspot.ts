import type { Hotspot } from '../engine/types.js';
import type { FetchOpts, HotspotSource } from './hotspot-source.js';

/** 注入式 HTML 抓取（便于离线测试）：给 url + cookie，返回页面 HTML 文本。 */
export type HtmlFetcher = (url: string, cookie: string) => Promise<string>;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

function decode(s: string): string {
  return s.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e);
}

/** 解析微博热搜页 HTML，取 td-02 里的标题与热度数字。 */
export function parseWeiboHot(html: string): Hotspot[] {
  const re =
    /<td class="td-02">[\s\S]*?<a href="(?:\/weibo\?[^"]*)"[^>]*>([\s\S]*?)<\/a>(?:\s*<span>([^<]*)<\/span>)?/g;
  const out: Hotspot[] = [];
  let m: RegExpExecArray | null = re.exec(html);
  let i = 0;
  while (m !== null) {
    const title = decode((m[1] ?? '').replace(/<[^>]*>/g, '')).trim();
    const heatDigits = (m[2] ?? '').replace(/[^\d]/g, '');
    if (title) {
      out.push({
        id: `weibo-${i + 1}`,
        title,
        heat: heatDigits ? Number(heatDigits) : 10_000_000 - i,
        source: '微博热搜',
        keywords: [],
      });
      i++;
    }
    m = re.exec(html);
  }
  return out;
}

const defaultFetcher: HtmlFetcher = async (url, cookie) => {
  const res = await fetch(url, {
    headers: { cookie, 'user-agent': UA, referer: 'https://passport.weibo.com/' },
    signal: AbortSignal.timeout(8000),
  });
  return res.text();
};

/**
 * 官方微博实时热搜源（需登录 cookie，与用户屏幕一致）。
 * cookie 取自 WEIBO_COOKIE 环境变量（存 .env，不入代码）。无 cookie / 失败 / 跳登录 → 返回空数组（绝不造假）。
 */
export class WeiboHotspotSource implements HotspotSource {
  private readonly url: string;
  private readonly cookie: string;
  private readonly fetcher: HtmlFetcher;

  constructor(opts: { url?: string; cookie?: string; fetcher?: HtmlFetcher } = {}) {
    this.url = opts.url ?? 'https://s.weibo.com/top/summary?cate=realtimehot';
    this.cookie = opts.cookie ?? process.env.WEIBO_COOKIE ?? '';
    this.fetcher = opts.fetcher ?? defaultFetcher;
  }

  async fetch(opts: FetchOpts): Promise<Hotspot[]> {
    if (!this.cookie) return [];
    try {
      const html = await this.fetcher(this.url, this.cookie);
      // 没拿到热搜表或被跳登录，视为失败，返回空（不造假）。
      if (!html.includes('pl_top_realtimehot')) return [];
      const hotspots = parseWeiboHot(html);
      return hotspots.slice(0, opts.limit ?? hotspots.length);
    } catch {
      return [];
    }
  }
}
