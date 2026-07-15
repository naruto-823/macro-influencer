// 发布打包 CLI：把一条 run 的成稿适配成小红书图文笔记，落盘到 out/publish/<runId>/。
// 用法：
//   pnpm publish [<runId>|latest] [--no-llm]
//     <runId>   指定 run；缺省/latest 取最新一条
//     --no-llm  跳过 LLM 压 caption，直接按句裁剪成稿（离线/省钱用）
// 产物：title.txt / body.txt（含话题标签，可直接粘贴）/ images/01.png… / package.json
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeJudge, makeLlm } from '../cli.js';
import type { FinalAsset, Topic } from '../engine/types.js';
import { composeCaption } from './caption.js';
import { type PublishPackage, assemblePackage, renderCaption } from './package.js';

const RUNS = resolve('runs');
const OUT = resolve('out/publish');

export interface PublishArgs {
  runId?: string;
  noLlm: boolean;
}

export function parsePublishArgs(argv: string[]): PublishArgs {
  const a: PublishArgs = { noLlm: false };
  for (const t of argv) {
    if (t === '--no-llm') a.noLlm = true;
    else if (!t.startsWith('-') && t !== 'latest' && !a.runId) a.runId = t;
  }
  return a;
}

/** 取最新一条 run 目录名（按名字倒序，名字含 ISO 时间戳即时间序）。 */
export async function latestRunId(): Promise<string> {
  const ids = (await readdir(RUNS))
    .filter((d) => d.startsWith('run-'))
    .sort()
    .reverse();
  if (!ids.length) throw new Error('runs/ 下没有任何 run');
  return ids[0] as string;
}

/** 列出某 run 的配图绝对路径（imgs/*.png，按文件名排序）。 */
export async function runImages(runId: string): Promise<string[]> {
  const dir = join(RUNS, runId, 'imgs');
  try {
    const files = (await readdir(dir)).filter((f) => /\.png$/i.test(f)).sort();
    return files.map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** 从 result.json 取被选中的选题（gate 存的 id → topic.generate 数组里捞），用作 caption 上下文。 */
function chosenTopic(result: Record<string, unknown>): Topic | undefined {
  const topics = result['topic.generate'] as Topic[] | undefined;
  const id = result['gate.topic.generate'] as string | undefined;
  if (!topics?.length) return undefined;
  return topics.find((t) => t.id === id) ?? topics[0];
}

/** 把发布包落盘成可直接发布的文件集。 */
export async function writePackage(pkg: PublishPackage): Promise<string> {
  const dir = join(OUT, pkg.sourceRunId);
  const imgDir = join(dir, 'images');
  await mkdir(imgDir, { recursive: true });

  const caption = renderCaption(pkg.body, pkg.tags);
  await writeFile(join(dir, 'title.txt'), pkg.title, 'utf8');
  await writeFile(join(dir, 'body.txt'), caption, 'utf8');
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');

  const copied: string[] = [];
  for (let i = 0; i < pkg.images.length; i++) {
    const dest = join(imgDir, `${String(i + 1).padStart(2, '0')}.png`);
    await copyFile(pkg.images[i] as string, dest);
    copied.push(dest);
  }
  return dir;
}

async function main() {
  // 加载本项目 .env（ANTHROPIC_API_KEY/BASE_URL/MODEL 只存在 .env），否则 LLM caption 认证失败。
  try {
    (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(resolve('.env'));
  } catch {
    // 无 .env 时静默跳过（会回退按句裁剪）
  }
  const args = parsePublishArgs(process.argv.slice(2));
  const runId = args.runId ?? (await latestRunId());
  const result = JSON.parse(await readFile(join(RUNS, runId, 'result.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const asset = result['asset.assemble'] as FinalAsset | undefined;
  if (!asset) throw new Error(`run ${runId} 没有 asset.assemble 产物，无法发布`);

  const images = await runImages(runId);
  console.log(`📦 打包 run ${runId}（${images.length} 张配图）`);

  let caption: { body: string; tags: string[] } | undefined;
  if (!args.noLlm) {
    try {
      const topic = chosenTopic(result);
      // caption 是短输出任务，用 fox（makeJudge）比长文 writer claude -p 快得多。
      caption = await composeCaption(makeJudge(makeLlm()), {
        title: asset.titles?.[0] ?? '',
        body: asset.body,
        topic: topic?.title,
      });
      console.log(
        `✍️  LLM 压出 caption（${[...caption.body].length} 字）+ ${caption.tags.length} 标签`,
      );
    } catch (e) {
      console.warn(`⚠️  LLM caption 失败，回退按句裁剪：${(e as Error).message}`);
    }
  }

  const pkg = assemblePackage({ asset, images, sourceRunId: runId, caption });
  const dir = await writePackage(pkg);

  console.log('\n──────── 发布预览 ────────');
  console.log(`标题（${[...pkg.title].length}/20）：${pkg.title}`);
  if (pkg.titleAlternatives.length) console.log(`备选标题：${pkg.titleAlternatives.join(' / ')}`);
  const full = renderCaption(pkg.body, pkg.tags);
  console.log(`正文（${[...full].length}/1000）：\n${full}`);
  console.log(`配图：${pkg.images.length} 张`);
  console.log('──────────────────────────');
  console.log(`\n✅ 已落盘：${dir}`);
  console.log(
    '   下一步：用 pnpm publish:xhs 自动投递，或手动复制 title.txt/body.txt + images/ 发布。',
  );
}

// 仅作为脚本直接运行时执行（被 import 当模块时不自启）。
if (/[/\\]publish-cli\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
