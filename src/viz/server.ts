import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPersona, newRunId } from '../cli.js';
import { EventBus } from '../engine/events.js';
import { ClaudeLlmClient } from '../llm/client.js';
import { persistRun } from '../output/persist.js';
import { demoPersona } from '../persona/examples/demo.js';
import { runPipeline } from '../run.js';
import { MultiHotspotSource } from '../sources/web-hotspot.js';

// 加载本项目 .env（fox 代理 key/baseURL/model 在此），与 cli 一致。
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(resolve('.env'));
} catch {
  // 无 .env 时静默跳过
}

const PORT = Number(process.env.VIZ_PORT ?? 5180);
const INDEX_HTML = fileURLToPath(new URL('./index.html', import.meta.url));

const bus = new EventBus();
let running = false;

/** 触发一次真跑（auto 模式），事件经 bus 广播给所有 SSE 连接。 */
async function startRun(personaId: string): Promise<boolean> {
  if (running) return false;
  running = true;
  const runId = newRunId();
  try {
    const persona = personaId === 'demo' ? demoPersona : await loadPersona(personaId);
    const bag = await runPipeline(runId, {
      llm: new ClaudeLlmClient(),
      persona,
      hotspot: new MultiHotspotSource(),
      engineCfg: {
        skillTimeoutMs: 120_000,
        runWallclockMs: 600_000,
        gate: async (_q, options) => options[0] ?? '',
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
