import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImagePanel } from '../engine/types.js';
import { renderPanel } from './image-render.js';

const TMP = resolve('runs', '__test_imgrender__');
const CHAR = join(TMP, 'char');
const OUT = join(TMP, 'out');

beforeAll(() => {
  mkdirSync(CHAR, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  // 造一张 200x300 的假素材（红块），写 manifest。
  const png = new PNG({ width: 200, height: 300 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 220;
    png.data[i + 1] = 40;
    png.data[i + 2] = 40;
    png.data[i + 3] = 255;
  }
  writeFileSync(join(CHAR, 'hero.cut.png'), PNG.sync.write(png));
  writeFileSync(
    join(CHAR, 'manifest.json'),
    JSON.stringify([{ file: 'hero.cut.png', w: 200, h: 300, desc: '测试素材' }]),
  );
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('image.render 合成', () => {
  it('用选定素材合成出 PNG，带回 panel', async () => {
    const panel: ImagePanel = {
      role: '封面',
      headline: '8天3000台',
      data: '3000台',
      asset: 'hero.cut.png',
    };
    const res = await renderPanel(panel, 0, OUT, CHAR);
    expect(res.ok).toBe(true);
    expect(res.file).toBe('01.png');
    expect(res.panel.headline).toBe('8天3000台');
    expect(statSync(join(OUT, '01.png')).size).toBeGreaterThan(0);
  });

  it('素材缺失时标记失败、不抛错', async () => {
    const panel: ImagePanel = { role: '配图', headline: 'x', asset: '不存在.png' };
    const res = await renderPanel(panel, 1, OUT, join(TMP, '空目录'));
    expect(res.ok).toBe(false);
    expect(res.file).toBe(null);
  });
});
