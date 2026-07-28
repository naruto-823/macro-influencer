import { describe, expect, it } from 'vitest';
import { loadPersona, newRunId, parseArgs, resolveGateChoice } from './cli.js';

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

describe('parseArgs', () => {
  it('缺省 auto 为 false、无 persona', () => {
    expect(parseArgs([])).toEqual({ auto: false });
  });
  it('解析 --auto', () => {
    expect(parseArgs(['--auto']).auto).toBe(true);
  });
  it('解析 --persona <id>（空格形式）', () => {
    expect(parseArgs(['--persona', 'gunzi-daren']).persona).toBe('gunzi-daren');
  });
  it('解析 --persona=<id>（等号形式）', () => {
    expect(parseArgs(['--persona=demo', '--auto'])).toEqual({ persona: 'demo', auto: true });
  });
});

describe('loadPersona', () => {
  it('生产默认人设内置在 dist 中，不依赖根目录 personas', async () => {
    const persona = await loadPersona('gunzi-daren');
    expect(persona.id).toBe('gunzi-daren');
    expect(persona.displayName).toBe('棍子大人');
  });
});
