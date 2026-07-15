// 单节点运行器：用某条历史 run 已存的前序数据当输入，只跑一个节点，秒级迭代调优。
// 用法：
//   pnpm node-run <skill> [--run <runId>] [--persona <id>] [--write]
//   pnpm node-run --list                 列出可用节点与最近的 run
// 例： pnpm node-run image.render         用最新 run 的数据只跑「出图」
//      pnpm node-run content.refine --run run-xxx --write   跑精修并写回该 run
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeJudge, makeLlm } from './cli.js';
import { loadPersona } from './cli.js';
import type { SkillContext } from './engine/types.js';
import { persistRun } from './output/persist.js';
import { demoPersona } from './persona/examples/demo.js';
import type { PersonaPack } from './persona/persona-pack.js';
import { buildRegistry } from './run.js';
import { CachedHotspotSource } from './sources/cached-hotspot.js';
import { MultiHotspotSource } from './sources/web-hotspot.js';
import { WeiboHotspotSource } from './sources/weibo-hotspot.js';

const RUNS = resolve('runs');
const NODE_TIMEOUT_MS = 1_200_000;

export interface NodeArgs {
  skill?: string;
  run?: string;
  persona?: string;
  write: boolean;
  list: boolean;
  /** 批量夹具：在最近多条历史 run 上都跑一遍该节点，验证修复在多份真实输入下都成立。 */
  all: boolean;
  limit: number;
}

/** 解析命令行：<skill> --run <id> --persona <id> --write/-w --list/-l --all/-a --limit <n>。 */
export function parseNodeArgs(argv: string[]): NodeArgs {
  const a: NodeArgs = { write: false, list: false, all: false, limit: 3 };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] ?? '';
    if (t === '--list' || t === '-l') a.list = true;
    else if (t === '--write' || t === '-w') a.write = true;
    else if (t === '--all' || t === '-a') a.all = true;
    else if (t === '--limit') a.limit = Math.max(1, Number(argv[++i]) || 3);
    else if (t === '--run') a.run = argv[++i];
    else if (t === '--persona') a.persona = argv[++i];
    else if (!t.startsWith('-') && !a.skill) a.skill = t;
  }
  return a;
}

/** 找出可当某节点测试夹具的历史 run：已存有该节点输出 = 一定有它的前序输入。 */
async function fixtureRunsFor(skill: string, limit: number): Promise<string[]> {
  const ids = await listRunIds();
  const out: string[] = [];
  for (const id of ids) {
    if (out.length >= limit) break;
    try {
      const bag = JSON.parse(await readFile(join(RUNS, id, 'result.json'), 'utf8'));
      if (bag[skill] !== undefined) out.push(id);
    } catch {
      // 跳过坏文件
    }
  }
  return out;
}

/** 最近的 run（有 result.json 的目录），时间倒序。 */
async function listRunIds(): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(RUNS);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const id of entries) {
    try {
      await readFile(join(RUNS, id, 'result.json'), 'utf8');
      ids.push(id);
    } catch {
      // 跳过没有 result.json 的目录
    }
  }
  return ids.sort((a, b) => (a < b ? 1 : -1));
}

/** 构造单节点的运行上下文（写手/裁判/热点源都按真实配置）。 */
function nodeContext(
  runId: string,
  bag: Record<string, unknown>,
  persona: PersonaPack,
): SkillContext {
  const writer = makeLlm();
  return {
    runId,
    llm: writer,
    judge: makeJudge(writer),
    persona,
    sources: {
      hotspot: new CachedHotspotSource(
        new MultiHotspotSource({ extraSources: [new WeiboHotspotSource()] }),
        { ttlMs: 7_200_000, file: resolve('cache', 'hotspots.json') },
      ),
    },
    bag,
    emit: (m) => console.log(m),
    signal: new AbortController().signal,
  };
}

/** 用给定 bag + persona 只跑一个 skill，返回产物（带超时）。 */
export async function runSingleNode(
  skillName: string,
  runId: string,
  bag: Record<string, unknown>,
  persona: PersonaPack,
): Promise<unknown> {
  const skill = buildRegistry().get(skillName);
  const ctx = nodeContext(runId, bag, persona);
  return Promise.race([
    skill.run(ctx),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`单节点超时（${NODE_TIMEOUT_MS}ms）`)), NODE_TIMEOUT_MS),
    ),
  ]);
}

/** 打印产物预览：长字符串截断，避免刷屏。 */
function preview(out: unknown): string {
  return JSON.stringify(
    out,
    (_k, v) => (typeof v === 'string' && v.length > 400 ? `${v.slice(0, 400)}…(${v.length}字)` : v),
    2,
  );
}

async function main(): Promise<void> {
  try {
    (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(resolve('.env'));
  } catch {
    // 无 .env 静默
  }
  const args = parseNodeArgs(process.argv.slice(2));
  const runs = await listRunIds();

  if (args.list || !args.skill) {
    const skills = buildRegistry().names();
    console.log(`\n可运行的节点：\n  ${skills.join('\n  ')}`);
    console.log(
      `\n最近的 run（当输入用 --run <id>）：\n  ${runs.slice(0, 12).join('\n  ') || '（无）'}`,
    );
    console.log(
      '\n用法：pnpm node-run <skill> [--run <runId>] [--persona <id>] [--write]' +
        '\n      pnpm node-run <skill> --all [--limit 3]   # 在最近多条历史 run 上批量验证\n',
    );
    return;
  }

  // 批量夹具：在最近 limit 条「跑过该节点」的历史 run 上各跑一遍，逐条报结果（不写回）。
  if (args.all) {
    const fixtures = await fixtureRunsFor(args.skill, args.limit);
    if (fixtures.length === 0) throw new Error(`没有跑过 ${args.skill} 的历史 run 可当夹具`);
    console.log(`\n▶ 批量验证：${args.skill} | ${fixtures.length} 份夹具\n`);
    for (const id of fixtures) {
      const bag = JSON.parse(await readFile(join(RUNS, id, 'result.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      const personaId = args.persona ?? (bag.__personaId as string) ?? 'gunzi-daren';
      const persona = personaId === 'demo' ? demoPersona : await loadPersona(personaId);
      try {
        const t0 = Date.now();
        const out = await runSingleNode(args.skill, id, bag, persona);
        console.log(`\n── ${id}（${Date.now() - t0}ms）──\n${preview(out)}`);
      } catch (e) {
        console.log(`\n── ${id} ❌ ${e instanceof Error ? e.message : e}`);
      }
    }
    console.log('\n（批量模式只跑不写回，用于看修复在多份真实输入下是否都成立）');
    return;
  }

  const runId = args.run ?? runs[0];
  if (!runId) throw new Error('没有可用的 run，先跑一次完整流水线或用 --run 指定');
  const bagPath = join(RUNS, runId, 'result.json');
  const bag = JSON.parse(await readFile(bagPath, 'utf8')) as Record<string, unknown>;
  const personaId = args.persona ?? (bag.__personaId as string) ?? 'gunzi-daren';
  const persona = personaId === 'demo' ? demoPersona : await loadPersona(personaId);

  console.log(`\n▶ 单节点：${args.skill} | 输入 run：${runId} | 人设：${personaId}\n`);
  const t0 = Date.now();
  const out = await runSingleNode(args.skill, runId, bag, persona);
  console.log(`\n— 产物（${Date.now() - t0}ms）—\n${preview(out)}`);

  if (args.write) {
    bag[args.skill] = out;
    await persistRun(RUNS, runId, bag);
    console.log(`\n✅ 已写回 ${bagPath}（${args.skill}）`);
  } else {
    console.log('\n（未写回；加 --write 可把产物存进该 run，供后续节点接力测试）');
  }
}

if (/[/\\]node-cli\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    console.error('❌ 失败：', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
