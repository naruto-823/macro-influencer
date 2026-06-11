import type { Hotspot } from '../engine/types.js';
import type { FetchOpts, HotspotSource } from './hotspot-source.js';

/** 注入式 fetch，便于离线测试；默认全局 fetch + 8s 超时。 */
export type Fetcher = (url: string) => Promise<{ json(): Promise<unknown> }>;

export interface Platform {
  key: string;
  label: string;
  url: string;
}

/**
 * 默认聚合的 JSON 平台（60s 聚合接口，公开免登录、沙箱可达）。
 * 微博不走这里——它的 60s 源不准且有延迟；官方实时微博走 WeiboHotspotSource（带 cookie），作为 extraSources 注入。
 */
export const DEFAULT_PLATFORMS: Platform[] = [
  { key: 'zhihu', label: '知乎热榜', url: 'https://60s-api.viki.moe/v2/zhihu' },
  { key: 'douyin', label: '抖音热点', url: 'https://60s-api.viki.moe/v2/douyin' },
  { key: 'toutiao', label: '头条热榜', url: 'https://60s-api.viki.moe/v2/toutiao' },
];

/** 相关性加权词：命中越多越靠前，把科技/商业/职场/财富类热点顶到前面，八卦沉底。 */
export const DEFAULT_BOOST_TERMS = [
  'AI',
  '大模型',
  '模型',
  '芯片',
  '算法',
  '程序员',
  '代码',
  '开发',
  '技术',
  '互联网',
  '大厂',
  '字节',
  '腾讯',
  '阿里',
  '美团',
  '华为',
  '英伟达',
  'OpenAI',
  'Claude',
  '面试',
  '职场',
  '打工',
  '裁员',
  '晋升',
  '绩效',
  '简历',
  '应届',
  '求职',
  '副业',
  '内卷',
  '创业',
  '老板',
  '工资',
  '薪资',
  '收入',
  '股',
  '股价',
  '股市',
  '基金',
  '投资',
  '理财',
  '财富',
  '经济',
  '房价',
  '楼市',
  '比亚迪',
  '特斯拉',
  '新能源',
  '学历',
  '考研',
  '考公',
  '博士',
  '商业',
  '公司',
  '融资',
  '上市',
  '马斯克',
  '雷军',
  '王传福',
  // 热点人物 / 事件 / 争议（账号靠「借人物事件做人性锐评/生平解读/事件剖析」起量）
  '网红',
  '明星',
  '主播',
  '顶流',
  '名人',
  '大佬',
  '去世',
  '逝世',
  '死讯',
  '塌房',
  '出轨',
  '离婚',
  '被查',
  '被捕',
  '翻车',
  '道歉',
  '争议',
  '风波',
  '黑料',
  '内幕',
  '事件',
  '曝光',
  '回应',
  '起诉',
  '判刑',
  '罚款',
  '黑产',
  '诈骗',
  '维权',
  '霸凌',
  '塌',
];

interface RawItem {
  title?: string;
  detail?: string;
  hot_value?: number;
  hot_value_desc?: string;
}

function parseHeat(it: RawItem, rankFallback: number): number {
  if (typeof it.hot_value === 'number') return it.hot_value;
  const m = String(it.hot_value_desc ?? '').match(/[\d.]+/);
  if (!m) return rankFallback;
  const n = Number.parseFloat(m[0]);
  return Math.round(String(it.hot_value_desc).includes('万') ? n * 10000 : n);
}

/**
 * 多源热点聚合：并发拉取多个平台热榜，合并去重，按对本账号的相关性排序（同分按热度）。
 * 单平台失败自动跳过；全部失败时若注入了 fallback 则用之，否则返回空数组。永不抛错、绝不造假数据。
 */
/** 默认视为「短热搜词」的来源（微博/抖音），排序时优先于知乎/头条等长问题源。 */
export const DEFAULT_TERM_SOURCES = ['微博热搜', '抖音热点'];

export class MultiHotspotSource implements HotspotSource {
  private readonly platforms: Platform[];
  private readonly extraSources: HotspotSource[];
  private readonly boostTerms: string[];
  private readonly termSources: Set<string>;
  private readonly fetcher: Fetcher;
  private readonly fallback?: HotspotSource;

  constructor(
    opts: {
      platforms?: Platform[];
      /** 额外热点源（如官方微博 WeiboHotspotSource），与 JSON 平台一起聚合排序。 */
      extraSources?: HotspotSource[];
      boostTerms?: string[];
      /** 「短热搜词」来源 label：这些来源的条目整体排在长问题源（知乎/头条）之前。 */
      termSourceLabels?: string[];
      fetcher?: Fetcher;
      fallback?: HotspotSource;
    } = {},
  ) {
    this.platforms = opts.platforms ?? DEFAULT_PLATFORMS;
    this.extraSources = opts.extraSources ?? [];
    this.boostTerms = opts.boostTerms ?? DEFAULT_BOOST_TERMS;
    this.termSources = new Set(opts.termSourceLabels ?? DEFAULT_TERM_SOURCES);
    this.fetcher = opts.fetcher ?? ((u) => fetch(u, { signal: AbortSignal.timeout(8000) }));
    this.fallback = opts.fallback;
  }

  /** 分层：热搜词源=0（优先），长问题源=1。 */
  private tier(h: Hotspot): number {
    return this.termSources.has(h.source) ? 0 : 1;
  }

  private async fetchPlatform(p: Platform): Promise<Hotspot[]> {
    const res = await this.fetcher(p.url);
    const json = (await res.json()) as { data?: RawItem[] };
    const items = json?.data ?? [];
    return items
      .filter((it) => it.title)
      .map((it, i) => ({
        id: `${p.key}-${i + 1}`,
        title: it.title as string,
        heat: parseHeat(it, items.length - i),
        source: p.label,
        keywords: [] as string[],
        summary: it.detail,
      }));
  }

  /** 命中 boostTerms 的数量，作为相关性分数。 */
  private relevance(h: Hotspot): number {
    const text = h.title + (h.summary ?? '');
    return this.boostTerms.reduce((n, t) => (text.includes(t) ? n + 1 : n), 0);
  }

  async fetch(opts: FetchOpts): Promise<Hotspot[]> {
    const settled = await Promise.allSettled([
      ...this.platforms.map((p) => this.fetchPlatform(p)),
      ...this.extraSources.map((s) => s.fetch(opts)),
    ]);
    const merged = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (merged.length === 0) return this.fallback ? this.fallback.fetch(opts) : [];

    const seen = new Set<string>();
    const deduped = merged.filter((h) => {
      const k = h.title.replace(/[\s\p{P}]/gu, '').slice(0, 12);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // limit 作「每个平台各取 top-N」（按各自热度），避免低热度平台被全局名额挤掉。
    const cap = opts.limit ?? Number.POSITIVE_INFINITY;
    const bySource = new Map<string, Hotspot[]>();
    for (const h of deduped) {
      const arr = bySource.get(h.source) ?? [];
      arr.push(h);
      bySource.set(h.source, arr);
    }
    const kept: Hotspot[] = [];
    for (const arr of bySource.values()) {
      arr.sort((a, b) => b.heat - a.heat);
      kept.push(...arr.slice(0, cap));
    }

    // 全局排序：热搜词源优先 → 同层按账号相关性 → 再按热度。
    kept.sort(
      (a, b) =>
        this.tier(a) - this.tier(b) || this.relevance(b) - this.relevance(a) || b.heat - a.heat,
    );
    return kept;
  }
}
