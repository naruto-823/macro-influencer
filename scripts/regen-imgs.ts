// 一次性脚本：用新的 ⑨（艺术指导 + 设计级 SVG prompt）给某条已完成 run 重出整套配图。
// 用法：tsx scripts/regen-imgs.ts <runId>
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeJudge, makeLlm } from '../src/cli.js';
import type { SkillContext } from '../src/engine/types.js';
import { imageRenderSkill } from '../src/skills/image-render.js';

try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(resolve('.env'));
} catch {}

const runId = process.argv[2];
if (!runId) throw new Error('需要 runId');
const resultPath = join(resolve('runs'), runId, 'result.json');
const bag = JSON.parse(await readFile(resultPath, 'utf8'));

const writer = makeLlm();
const ctx = {
  runId,
  llm: writer,
  judge: makeJudge(writer),
  persona: {} as never,
  sources: {} as never,
  bag,
  emit: (m: string) => console.log(m),
  signal: new AbortController().signal,
} as unknown as SkillContext;

console.log(`重出 ${runId} 的配图…`);
const res = await imageRenderSkill.run(ctx);
bag['image.render'] = res;
await writeFile(resultPath, JSON.stringify(bag, null, 2));
console.log(`完成：${res.images.filter((i) => i.ok).length}/${res.images.length} 张`);
for (const im of res.images)
  console.log(`  ${im.ok ? '✅' : '❌'} ${im.file ?? im.error} | ${im.panel.headline}`);
