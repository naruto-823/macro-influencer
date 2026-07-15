// 每日一篇编排：跑全链路（无人值守）→ 出小红书发布包 → 可选真实发布。
// 「一天至少发一篇」的入口，配合 cron/launchd 每天定时跑（见 scripts/daily-cron.sh）。
//
// 用法：
//   pnpm daily [--persona <id>] [--live] [--draft]
//     默认       ：跑链路 + 出发布包，停在「发布包就绪」，等人工发
//     --draft    ：再驱动 agent-browser 填好草稿（停在发布前，截图预览）
//     --live     ：再驱动 agent-browser 真实发布（谨慎）
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RUNS = resolve('runs');

export interface DailyArgs {
  persona: string;
  live: boolean;
  draft: boolean;
}

export function parseDailyArgs(argv: string[]): DailyArgs {
  const a: DailyArgs = { persona: 'gunzi-daren', live: false, draft: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] ?? '';
    if (t === '--live') a.live = true;
    else if (t === '--draft') a.draft = true;
    else if (t === '--persona') a.persona = argv[++i] ?? a.persona;
    else if (t.startsWith('--persona=')) a.persona = t.slice('--persona='.length);
  }
  return a;
}

/** 当前最新 run 目录名。 */
function latestRunId(): string | null {
  if (!existsSync(RUNS)) return null;
  const ids = readdirSync(RUNS)
    .filter((d) => d.startsWith('run-'))
    .sort()
    .reverse();
  return ids[0] ?? null;
}

function sh(cmd: string, args: string[]) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: resolve('.') });
}

async function main() {
  const args = parseDailyArgs(process.argv.slice(2));
  const stamp = new Date().toISOString();
  console.log(`\n🗓  每日一篇 | 账号 persona=${args.persona} | ${stamp}\n`);

  const before = latestRunId();

  console.log('① 跑全链路（无人值守）…');
  sh('pnpm', ['start', '--persona', args.persona, '--auto']);

  const runId = latestRunId();
  if (!runId || runId === before) throw new Error('链路没产出新 run');

  // 校验是否真出了最终作品（gate 打回则没有 asset.assemble）
  const result = JSON.parse(readFileSync(join(RUNS, runId, 'result.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  if (!result['asset.assemble']) {
    throw new Error(`run ${runId} 未产出最终作品（可能风控打回/中止），今日不发`);
  }
  console.log(`\n② 出小红书发布包（${runId}）…`);
  sh('pnpm', ['publish', runId]);

  if (args.live) {
    console.log('\n③ --live 真实发布…');
    sh('pnpm', ['publish:xhs', runId, '--live']);
    console.log('\n✅ 今日已发布。');
  } else if (args.draft) {
    console.log('\n③ 填好草稿（停在发布前）…');
    sh('pnpm', ['publish:xhs', runId]);
    console.log('\n⏸ 草稿就绪，人工确认后手动发或重跑 --live。');
  } else {
    console.log(`\n✅ 发布包就绪（未发）。人工核对后 pnpm publish:xhs ${runId} --live 发布。`);
  }
}

if (/[/\\]daily\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    console.error(`❌ 每日一篇失败：${(e as Error).message}`);
    process.exit(1);
  });
}
