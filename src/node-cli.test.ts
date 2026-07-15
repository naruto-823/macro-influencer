import { describe, expect, it } from 'vitest';
import { parseNodeArgs } from './node-cli.js';
import { buildRegistry } from './run.js';

describe('parseNodeArgs', () => {
  it('解析 skill + --run + --persona + --write', () => {
    const a = parseNodeArgs(['image.render', '--run', 'run-xx', '--persona', 'demo', '--write']);
    expect(a.skill).toBe('image.render');
    expect(a.run).toBe('run-xx');
    expect(a.persona).toBe('demo');
    expect(a.write).toBe(true);
    expect(a.list).toBe(false);
  });

  it('--list / -l', () => {
    expect(parseNodeArgs(['--list']).list).toBe(true);
    expect(parseNodeArgs(['-l']).list).toBe(true);
  });

  it('只给 skill', () => {
    const a = parseNodeArgs(['content.refine']);
    expect(a.skill).toBe('content.refine');
    expect(a.run).toBeUndefined();
    expect(a.write).toBe(false);
    expect(a.all).toBe(false);
    expect(a.limit).toBe(3);
  });

  it('--all / --limit 批量夹具', () => {
    const a = parseNodeArgs(['risk.review', '--all', '--limit', '5']);
    expect(a.all).toBe(true);
    expect(a.limit).toBe(5);
    expect(parseNodeArgs(['risk.review', '-a']).all).toBe(true);
  });
});

describe('registry.names', () => {
  it('列出全部已注册节点', () => {
    const names = buildRegistry().names();
    expect(names).toContain('content.refine');
    expect(names).toContain('image.render');
    expect(names.length).toBeGreaterThanOrEqual(10);
  });
});
