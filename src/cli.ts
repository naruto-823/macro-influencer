import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ClaudeLlmClient } from './llm/client.js';
import { persistRun } from './output/persist.js';
import { demoPersona } from './persona/examples/demo.js';
import type { PersonaPack } from './persona/persona-pack.js';
import { runPipeline } from './run.js';
import { MockHotspotSource } from './sources/hotspot-source.js';

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

async function terminalGate(question: string, options: string[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`\n${question}\n  选项：${options.join(' / ')}\n> `);
    return resolveGateChoice(answer, options);
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const persona: PersonaPack = demoPersona;
  const runId = newRunId();
  console.log(`\n🚀 百万网红 Agent | 账号：${persona.displayName} | run：${runId}\n`);

  const bag = await runPipeline(runId, {
    llm: new ClaudeLlmClient(),
    persona,
    hotspot: new MockHotspotSource(),
    engineCfg: { skillTimeoutMs: 120_000, runWallclockMs: 600_000, gate: terminalGate },
  });

  const dir = await persistRun(resolve('runs'), runId, bag);
  console.log(`\n✅ 完成，产物已落盘：${dir}`);
}

if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  main().catch((e) => {
    console.error('❌ 运行失败：', e);
    process.exit(1);
  });
}
