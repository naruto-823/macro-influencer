import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { persistRun } from './persist.js';

describe('persistRun', () => {
  it('把 bag 写成 result.json 与 README.md', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mi-'));
    const bag = {
      'asset.assemble': {
        titles: ['标题1'],
        body: '正文',
        imagePrompts: ['封面'],
        publishTips: '晚8点',
      },
    };
    const dir = await persistRun(root, 'run-123', bag);
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    expect(result['asset.assemble'].titles[0]).toBe('标题1');
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('标题1');
    expect(readme).toContain('封面');
  });
});
