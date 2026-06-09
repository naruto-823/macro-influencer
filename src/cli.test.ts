import { describe, expect, it } from 'vitest';
import { newRunId, resolveGateChoice } from './cli.js';

describe('newRunId', () => {
  it('生成带 run- 前缀的非空 id', () => {
    const id = newRunId();
    expect(id.startsWith('run-')).toBe(true);
    expect(id.length).toBeGreaterThan(5);
  });
});

describe('resolveGateChoice', () => {
  it('精确匹配选项', () => {
    expect(resolveGateChoice('通过', ['通过', '打回'])).toBe('通过');
  });
  it('输入不在选项中时退回第一个选项', () => {
    expect(resolveGateChoice('xxx', ['通过', '打回'])).toBe('通过');
  });
  it('空输入退回第一个选项', () => {
    expect(resolveGateChoice('', ['t1', 't2'])).toBe('t1');
  });
});
