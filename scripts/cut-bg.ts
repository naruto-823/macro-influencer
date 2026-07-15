// 抠掉「假透明棋盘格 / 纯色」背景：从四边 flood-fill，把连通到边缘的浅色像素设为透明，
// 再自动裁掉透明边。角色内部的白被黑描边围住、不连通到边缘，不会被误删。
// 用法：tsx scripts/cut-bg.ts <dir>   处理 dir 下所有 .png（跳过已是 .cut.png 的），输出 <name>.cut.png + manifest.json
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

const dir = process.argv[2] ?? 'assets/characters/doraemon';
const LIGHT = 200; // R,G,B 都 >= 该值视为浅色背景候选

function cut(buf: Buffer): { png: PNG } {
  const png = PNG.sync.read(buf);
  const { width: w, height: h, data } = png;
  const bg = new Uint8Array(w * h); // 1=背景(透明)
  const stack: number[] = [];
  const isLight = (i: number) =>
    data[i * 4] >= LIGHT && data[i * 4 + 1] >= LIGHT && data[i * 4 + 2] >= LIGHT;
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (bg[i] || !isLight(i)) return;
    bg[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % w;
    const y = (i / w) | 0;
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }
  for (let i = 0; i < w * h; i++) if (bg[i]) data[i * 4 + 3] = 0;
  return { png };
}

/** 裁掉四周全透明的边，返回裁剪后的新 PNG。 */
function autocrop(png: PNG): PNG {
  const { width: w, height: h, data } = png;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  if (maxX < 0) return png;
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = new PNG({ width: cw, height: ch });
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const s = ((y + minY) * w + (x + minX)) * 4;
      const d = (y * cw + x) * 4;
      out.data[d] = data[s];
      out.data[d + 1] = data[s + 1];
      out.data[d + 2] = data[s + 2];
      out.data[d + 3] = data[s + 3];
    }
  return out;
}

const manifest: Array<{ file: string; w: number; h: number }> = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.png') || f.endsWith('.cut.png')) continue;
  const { png } = cut(readFileSync(join(dir, f)));
  const cropped = autocrop(png);
  const outName = `${f.replace(/\.png$/, '')}.cut.png`;
  writeFileSync(join(dir, outName), PNG.sync.write(cropped));
  manifest.push({ file: outName, w: cropped.width, h: cropped.height });
  console.log(`✂️  ${f} → ${outName}  ${cropped.width}x${cropped.height}`);
}
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`manifest: ${manifest.length} 张`);
