import { describe, expect, it } from 'vitest';
import { riskLevel, scanSensitive } from './sensitive-words.js';

describe('scanSensitive', () => {
  it('命中极限词与导流词', () => {
    const hits = scanSensitive('这是最好的产品，加微信领取');
    const terms = hits.map((h) => h.term);
    expect(terms).toContain('最');
    expect(terms).toContain('微信');
  });

  it('无命中返回空数组', () => {
    expect(scanSensitive('今天分享一个好用的小工具')).toEqual([]);
  });
});

describe('riskLevel', () => {
  it('无命中为 pass', () => {
    expect(riskLevel([])).toBe('pass');
  });
  it('含 high 命中则为 high', () => {
    expect(riskLevel([{ category: '医疗功效', term: '根治', severity: 'high' }])).toBe('high');
  });
  it('只有 mid 命中则为 mid', () => {
    expect(riskLevel([{ category: '极限词', term: '最', severity: 'mid' }])).toBe('mid');
  });
});
