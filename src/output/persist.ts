import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FinalAsset } from '../engine/types.js';

/** 把一次 run 的 bag 落盘到 <root>/<runId>/，返回目录路径。 */
export async function persistRun(
  root: string,
  runId: string,
  bag: Record<string, unknown>,
): Promise<string> {
  const dir = join(root, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'result.json'), JSON.stringify(bag, null, 2), 'utf8');

  const asset = bag['asset.assemble'] as FinalAsset | undefined;
  if (asset) {
    const md = [
      '# 最终作品',
      '',
      '## 标题候选',
      ...asset.titles.map((t, i) => `${i + 1}. ${t}`),
      '',
      '## 正文',
      asset.body,
      '',
      '## 阶段版正文（≤950字）',
      asset.stagedBody,
      '',
      '## 配图 / 分镜',
      ...asset.imagePrompts.map((p, i) => `- 图${i + 1}：${p}`),
      '',
      '## 发布建议',
      asset.publishTips,
    ].join('\n');
    await writeFile(join(dir, 'README.md'), md, 'utf8');
  }
  return dir;
}
