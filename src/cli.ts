import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { ClaudeCliClient } from './llm/claude-cli.js';
import { ClaudeLlmClient } from './llm/client.js';
import type { LlmClient } from './llm/client.js';

/** 选 LLM 后端：默认本机 claude -p（绕开 fox 截断/限流）；LLM_BACKEND=fox 切回代理。 */
export function makeLlm(): LlmClient {
  return process.env.LLM_BACKEND === 'fox' ? new ClaudeLlmClient() : new ClaudeCliClient();
}

/**
 * 评审/裁判模型：精修循环与事实核查用它当裁判。默认 fox 的另一模型（换模型评审破「自我偏爱」偏差）。
 * 写手默认是本机 claude -p；裁判用 fox，天然形成模型多样性。若 fox 没配好则退回写手模型。
 */
export function makeJudge(writer: LlmClient): LlmClient {
  try {
    if (process.env.ANTHROPIC_API_KEY) return new ClaudeLlmClient();
  } catch {
    // fox 构造失败则退回写手模型
  }
  return writer;
}
import { persistRun } from './output/persist.js';
import { demoPersona } from './persona/examples/demo.js';
import { gunziDarenPersona } from './persona/examples/gunzi-daren.js';
import type { PersonaPack } from './persona/persona-pack.js';
import { runPipeline } from './run.js';
import { CachedHotspotSource } from './sources/cached-hotspot.js';
import { MultiHotspotSource } from './sources/web-hotspot.js';
import { WeiboHotspotSource } from './sources/weibo-hotspot.js';

/** 用进程启动时间戳生成 run id。 */
export function newRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

/** 把用户输入规整为合法选项：命中则用之，否则退回第一个选项。 */
export function resolveGateChoice(input: string, options: string[]): string {
  const trimmed = input.trim();
  if (options.includes(trimmed)) return trimmed;
  return options[0] ?? trimmed;
}

export interface CliArgs {
  /** 人设 id：从 personas/<id>.ts 加载；缺省用内置示例 */
  persona?: string;
  /** 无人值守：自动选第一个选题、风控自动通过，不走终端交互 */
  auto: boolean;
}

/** 解析命令行参数：--persona <id> / --auto。 */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { auto: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--auto') args.auto = true;
    else if (a === '--persona') args.persona = argv[++i];
    else if (a?.startsWith('--persona=')) args.persona = a.slice('--persona='.length);
  }
  return args;
}

/** 从 personas/<id>.ts|.js 动态加载一份 PersonaPack（取 default 或第一个导出）。 */
export async function loadPersona(id: string): Promise<PersonaPack> {
  // 生产默认人设随 TypeScript 一起编译进 dist，容器无需依赖 gitignored 的本地 personas/。
  if (id === gunziDarenPersona.id) return gunziDarenPersona;
  let lastErr: unknown;
  for (const ext of ['.ts', '.js']) {
    try {
      const mod = await import(pathToFileURL(resolve('personas', id + ext)).href);
      const pack = (mod.default ?? Object.values(mod)[0]) as PersonaPack | undefined;
      if (!pack?.id) throw new Error(`personas/${id}${ext} 未导出有效 PersonaPack`);
      return pack;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `加载人设 personas/${id} 失败：${lastErr instanceof Error ? lastErr.message : lastErr}`,
  );
}

function terminalGate(question: string, options: string[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl
    .question(`\n${question}\n  选项：${options.join(' / ')}\n> `)
    .then((answer) => resolveGateChoice(answer, options))
    .finally(() => rl.close());
}

/** 终端交互：某节点失败后，问要不要重试（复用前序结果）。 */
async function terminalStageFailed(info: {
  title: string;
  error: string;
}): Promise<'retry' | 'skip' | 'abort'> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl
    .question(`\n❌「${info.title}」失败：${info.error}\n  重试(r) / 跳过(s) / 中止(a)？ [r] `)
    .finally(() => rl.close());
  const a = ans.trim().toLowerCase();
  if (a === 's' || a === 'skip') return 'skip';
  if (a === 'a' || a === 'abort') return 'abort';
  return 'retry';
}

/** 无人值守卡点：选题取第一个、其余取第一个选项（风控即「通过」）。 */
async function autoGate(question: string, options: string[]): Promise<string> {
  const choice = options[0] ?? '';
  console.log(`\n${question} → 自动选择：${choice}`);
  return choice;
}

async function main(): Promise<void> {
  // 自动加载本项目 .env（Node 20.12+）；没有则忽略。密钥/网关只存在于 .env，不进代码。
  try {
    (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(resolve('.env'));
  } catch {
    // 无 .env 文件时静默跳过
  }

  const args = parseArgs(process.argv.slice(2));
  const persona: PersonaPack = args.persona ? await loadPersona(args.persona) : demoPersona;
  const runId = newRunId();
  const mode = args.auto ? '无人值守' : '交互';
  console.log(
    `\n🚀 百万网红 Agent | 账号：${persona.displayName} | 模式：${mode} | run：${runId}\n`,
  );

  const writer = makeLlm();
  const bag = await runPipeline(runId, {
    llm: writer,
    judge: makeJudge(writer),
    persona,
    hotspot: new CachedHotspotSource(
      new MultiHotspotSource({ extraSources: [new WeiboHotspotSource()] }),
      { ttlMs: 7_200_000, file: resolve('cache', 'hotspots.json') },
    ),
    engineCfg: {
      // deepsearch 联网检索较慢，单步给到 8 分钟。
      skillTimeoutMs: 480_000,
      runWallclockMs: 3_600_000,
      gate: args.auto ? autoGate : terminalGate,
      autoRetries: 1,
      onStageFailed: args.auto ? undefined : terminalStageFailed,
    },
  });

  const dir = await persistRun(resolve('runs'), runId, bag);
  if (bag['asset.assemble']) {
    console.log(`\n✅ 完成，产物已落盘：${dir}`);
  } else {
    const halted = bag['gate.risk.review'] === '打回';
    console.log(
      halted
        ? `\n⏹ 已在风控环节打回，未产出最终作品。中间产物已落盘：${dir}`
        : `\n⚠️ 流水线未产出最终作品（提前中止）。中间产物已落盘：${dir}`,
    );
  }
}

// 只在直接运行 src/cli.ts 时启动；注意别误命中 node-cli.ts（它会 import 本文件）。
if (/[/\\]cli\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    console.error('❌ 运行失败：', e);
    process.exit(1);
  });
}
