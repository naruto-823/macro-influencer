import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { ClaudeLlmClient } from './llm/client.js';
import { persistRun } from './output/persist.js';
import { demoPersona } from './persona/examples/demo.js';
import type { PersonaPack } from './persona/persona-pack.js';
import { runPipeline } from './run.js';
import { MockHotspotSource } from './sources/hotspot-source.js';
import { ZhihuHotspotSource } from './sources/zhihu-hotspot.js';

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

  const bag = await runPipeline(runId, {
    llm: new ClaudeLlmClient(),
    persona,
    hotspot: new ZhihuHotspotSource({ fallback: new MockHotspotSource() }),
    engineCfg: {
      skillTimeoutMs: 120_000,
      runWallclockMs: 600_000,
      gate: args.auto ? autoGate : terminalGate,
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

if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  main().catch((e) => {
    console.error('❌ 运行失败：', e);
    process.exit(1);
  });
}
