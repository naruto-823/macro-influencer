import { describe, expect, it } from 'vitest';
import type { FinalAsset } from '../engine/types.js';
import {
  XHS_LIMITS,
  assemblePackage,
  extractTags,
  renderCaption,
  stripMarkdown,
  trimBodyToSentence,
  trimTitle,
} from './package.js';

describe('stripMarkdown', () => {
  it('removes bold markers, keeps content', () => {
    expect(stripMarkdown('💀 **制片方只算一笔账** 多快回本')).toBe('💀 制片方只算一笔账 多快回本');
  });
  it('strips headers and bullets at line start', () => {
    expect(stripMarkdown('## 标题\n- 要点一\n* 要点二')).toBe('标题\n要点一\n要点二');
  });
  it('strips inline code and stray markers', () => {
    expect(stripMarkdown('用 `code` 和 **半截')).toBe('用 code 和 半截');
  });
  it('leaves plain text untouched', () => {
    expect(stripMarkdown('正常文案，没有符号。')).toBe('正常文案，没有符号。');
  });
});

describe('trimTitle', () => {
  it('keeps short titles untouched', () => {
    expect(trimTitle('短标题')).toBe('短标题');
  });
  it('caps to 20 chars', () => {
    const long = '771万字顶级IP被资本毁成5.8分：互联网人看完都沉默了';
    const out = trimTitle(long);
    expect([...out].length).toBeLessThanOrEqual(XHS_LIMITS.TITLE_MAX);
  });
  it('breaks on punctuation boundary when reasonable', () => {
    const out = trimTitle('豆瓣8.5跌到6.9，顶级IP为什么一改编就毁？行业黑洞全解析');
    expect([...out].length).toBeLessThanOrEqual(XHS_LIMITS.TITLE_MAX);
    expect(out.endsWith('，')).toBe(false);
  });
});

describe('extractTags', () => {
  it('pulls #hashtags#', () => {
    expect(extractTags('建议话题：#凡人修仙传# #职场# #互联网#')).toEqual([
      '凡人修仙传',
      '职场',
      '互联网',
    ]);
  });
  it('falls back to 标签: list', () => {
    expect(extractTags('最佳时间晚8点。标签：职场、晋升、裁员')).toEqual(['职场', '晋升', '裁员']);
  });
  it('returns empty when nothing parseable', () => {
    expect(extractTags('随便发')).toEqual([]);
  });
});

describe('trimBodyToSentence', () => {
  it('keeps body under limit', () => {
    expect(trimBodyToSentence('一句话。', 100)).toBe('一句话。');
  });
  it('cuts at sentence boundary', () => {
    const body = '第一句很长很长很长很长。第二句也不短不短不短不短。第三句。';
    const out = trimBodyToSentence(body, 16);
    expect([...out].length).toBeLessThanOrEqual(16);
    expect(out.endsWith('。')).toBe(true);
  });
});

describe('renderCaption', () => {
  it('appends hashtags', () => {
    expect(renderCaption('正文', ['职场', '晋升'])).toBe('正文\n\n#职场 #晋升');
  });
  it('no trailing block when no tags', () => {
    expect(renderCaption('正文', [])).toBe('正文');
  });
});

describe('assemblePackage', () => {
  const asset: FinalAsset = {
    titles: ['一个很短的标题', '备选标题二', '备选标题三'],
    body: '这是正文第一句。'.repeat(200), // ~1600 chars, 超 1000
    imagePrompts: [],
    publishTips: '晚上8点发。标签：职场、晋升、互联网',
  };

  it('produces a XHS-compliant package', () => {
    const pkg = assemblePackage({
      asset,
      images: ['/a/01.png', '/a/02.png'],
      sourceRunId: 'run-x',
    });
    expect(pkg.title).toBe('一个很短的标题');
    expect(pkg.titleAlternatives).toEqual(['备选标题二', '备选标题三']);
    expect(pkg.tags).toEqual(['职场', '晋升', '互联网']);
    expect(pkg.images).toHaveLength(2);
    // 正文 + 标签 不超 1000 字
    const full = renderCaption(pkg.body, pkg.tags);
    expect([...full].length).toBeLessThanOrEqual(XHS_LIMITS.BODY_MAX);
  });

  it('caps images to 18', () => {
    const images = Array.from({ length: 25 }, (_, i) => `/a/${i}.png`);
    const pkg = assemblePackage({ asset, images, sourceRunId: 'r' });
    expect(pkg.images).toHaveLength(XHS_LIMITS.IMAGES_MAX);
  });

  it('uses provided LLM caption when given', () => {
    const pkg = assemblePackage({
      asset,
      images: [],
      sourceRunId: 'r',
      caption: { body: '现压的短文案。', tags: ['标签A'] },
    });
    expect(pkg.body).toBe('现压的短文案。');
    expect(pkg.tags).toEqual(['标签A']);
  });
});
