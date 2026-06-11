import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPersona, newRunId } from '../cli.js';
import { EventBus } from '../engine/events.js';
import { ClaudeLlmClient } from '../llm/client.js';
import { persistRun } from '../output/persist.js';
import { demoPersona } from '../persona/examples/demo.js';
import { runPipeline } from '../run.js';
import { CachedHotspotSource } from '../sources/cached-hotspot.js';
import { MultiHotspotSource } from '../sources/web-hotspot.js';
import { WeiboHotspotSource } from '../sources/weibo-hotspot.js';

// 加载本项目 .env（fox 代理 key/baseURL/model 在此），与 cli 一致。
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(resolve('.env'));
} catch {
  // 无 .env 时静默跳过
}

const PORT = Number(process.env.VIZ_PORT ?? 5180);
const INDEX_HTML = fileURLToPath(new URL('./index.html', import.meta.url));

const bus = new EventBus();
const RUNS_DIR = resolve('runs');
let running = false;

/** 列出历史 run（读 runs/<id>/result.json），按时间倒序，附带一个标题用于展示。 */
async function listRuns(): Promise<Array<{ id: string; title: string; done: boolean }>> {
  let entries: string[] = [];
  try {
    entries = await readdir(RUNS_DIR);
  } catch {
    return [];
  }
  const runs: Array<{ id: string; title: string; done: boolean }> = [];
  for (const id of entries) {
    try {
      const bag = JSON.parse(await readFile(join(RUNS_DIR, id, 'result.json'), 'utf8'));
      const asset = bag['asset.assemble'] as { titles?: string[] } | undefined;
      const draft = bag['content.draft'] as { title?: string } | undefined;
      runs.push({ id, title: asset?.titles?.[0] ?? draft?.title ?? '(未完成)', done: !!asset });
    } catch {
      // 跳过没有 result.json 的目录
    }
  }
  runs.sort((a, b) => (a.id < b.id ? 1 : -1));
  return runs;
}

// 交互卡点：到卡点时 gate() 挂起、等前端 POST /gate 才继续（不自动往下跑，省 token）。
let pendingGate: { options: string[]; resolve: (choice: string) => void } | null = null;

function interactiveGate(_question: string, options: string[]): Promise<string> {
  return new Promise((resolve) => {
    pendingGate = { options, resolve };
  });
}

/** 触发一次真跑（交互卡点：选题/风控需在网页里点选），事件经 bus 广播给所有 SSE 连接。 */
async function startRun(personaId: string): Promise<boolean> {
  if (running) return false;
  running = true;
  pendingGate = null;
  const runId = newRunId();
  try {
    const persona = personaId === 'demo' ? demoPersona : await loadPersona(personaId);
    const bag = await runPipeline(runId, {
      llm: new ClaudeLlmClient(),
      persona,
      hotspot: new CachedHotspotSource(
        new MultiHotspotSource({ extraSources: [new WeiboHotspotSource()] }),
        { ttlMs: 7_200_000, file: resolve('cache', 'hotspots.json') },
      ),
      engineCfg: {
        // Opus 经 fox 代理单步可能 1-3 分钟（含 524/429 重试退避）；给足超时，避免成功前被掐。
        skillTimeoutMs: 300_000,
        // 含人工卡点等待时间，放宽到 30 分钟。
        runWallclockMs: 1_800_000,
        gate: interactiveGate,
        onEvent: (e) => bus.emit(e),
      },
    });
    const dir = await persistRun(resolve('runs'), runId, bag);
    bus.emit({ type: 'run.done', runId, dir });
  } catch (e) {
    // 引擎已在失败的 skill 上发过 run.failed；这里兜底捕获加载/落盘等其它错误。
    bus.emit({ type: 'run.failed', error: e instanceof Error ? e.message : String(e) });
  } finally {
    running = false;
    pendingGate = null;
  }
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    const html = await readFile(INDEX_HTML, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const off = bus.on((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      off();
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/runs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(await listRuns()));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/runs/')) {
    const id = decodeURIComponent(url.pathname.slice('/runs/'.length));
    // 防目录穿越：只允许实际存在的 run 目录
    const runs = await listRuns();
    if (!runs.some((r) => r.id === id)) {
      res.writeHead(404);
      res.end('no such run');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(await readFile(join(RUNS_DIR, id, 'result.json'), 'utf8'));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/gate') {
    const choice = url.searchParams.get('choice') ?? '';
    if (!pendingGate) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '当前没有待决策的卡点' }));
      return;
    }
    // 只接受合法选项，避免乱传
    const ok = pendingGate.options.includes(choice);
    if (ok) {
      const g = pendingGate;
      pendingGate = null;
      g.resolve(choice);
    }
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { ok: true } : { error: '非法选项' }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/run') {
    const personaId = url.searchParams.get('persona') ?? 'gunzi-daren';
    const ok = await startRun(personaId);
    res.writeHead(ok ? 202 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { started: true } : { error: '已有任务在跑' }));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n🖥  生产链路可视化已启动： http://localhost:${PORT}`);
  console.log('   打开后点「开始跑」，用真实人设走一遍并实时观看。\n');
});
