import { describe, expect, it } from 'vitest';
import { definePersona } from './persona-pack.js';

describe('definePersona', () => {
  const base = {
    id: 'demo',
    displayName: '示例账号',
    positioning: '面向职场新人的效率工具分享',
    styleGuide: '亲切、口语化、多用 emoji、分点叙述',
    sampleNotes: [{ title: '一个标题', body: '一段正文' }],
  };

  it('填充默认阈值与轮数', () => {
    const p = definePersona(base);
    expect(p.refineThreshold).toBe(80);
    expect(p.maxRefineRounds).toBe(3);
  });

  it('保留显式传入的阈值', () => {
    const p = definePersona({ ...base, refineThreshold: 90, maxRefineRounds: 5 });
    expect(p.refineThreshold).toBe(90);
    expect(p.maxRefineRounds).toBe(5);
  });

  it('id 非 kebab-case 时报错', () => {
    expect(() => definePersona({ ...base, id: 'Demo Account' })).toThrow(/id/);
  });

  it('缺 positioning 时报错', () => {
    expect(() => definePersona({ ...base, positioning: '' })).toThrow(/positioning/);
  });

  it('sampleNotes 为空时报错', () => {
    expect(() => definePersona({ ...base, sampleNotes: [] })).toThrow(/sampleNotes/);
  });
});
