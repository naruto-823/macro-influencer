import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPersona, makeJudge, makeLlm, newRunId } from '../cli.js';
import { EventBus } from '../engine/events.js';
import type {
  FinalAsset,
  ImagePanel,
  ImageSet,
  RenderedImage,
  SkillContext,
} from '../engine/types.js';
import { persistRun } from '../output/persist.js';
import { demoPersona } from '../persona/examples/demo.js';
import { buildRegistry, runPipeline } from '../run.js';
import { imageDir, renderPanel } from '../skills/image-render.js';
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
// 本次服务启动 id：前端断连重连后比对，变了说明服务重启过 → 自动刷新拿最新前端。
const SERVER_ID = String(Date.now());

const bus = new EventBus();
const RUNS_DIR = resolve('runs');
let running = false;
let retrying = false;

/** 单步重试上限：须长于 deep.search 自身的 20 分钟，给收尾和结果落盘留余量。 */
const NODE_RETRY_TIMEOUT_MS = 1_500_000;

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
// 失败重试：某节点失败时挂起，等前端 POST /retry 选「重试/跳过/中止」（前序结果都还在，不白跑）。
let pendingFailure: { resolve: (choice: 'retry' | 'skip' | 'abort') => void } | null = null;

// 当前 run 的事件缓冲：新 SSE 连接进来时重放，让刷新/切回的页面能重建实时状态（含未答的卡点按钮）。
let currentEvents: Parameters<typeof bus.emit>[0][] = [];

function interactiveGate(_question: string, options: string[]): Promise<string> {
  return new Promise((resolve) => {
    pendingGate = { options, resolve };
  });
}

/** 节点失败时挂起，等前端选择处理方式。 */
function interactiveStageFailed(): Promise<'retry' | 'skip' | 'abort'> {
  return new Promise((resolve) => {
    pendingFailure = { resolve };
  });
}

/** 触发一次真跑（交互卡点：选题/风控需在网页里点选），事件经 bus 广播给所有 SSE 连接。 */
async function startRun(personaId: string): Promise<boolean> {
  if (running) return false;
  running = true;
  pendingGate = null;
  pendingFailure = null;
  const runId = newRunId();
  // 增量落盘：每完成一步/每个卡点都把已生成的内容写盘，
  // 这样即便后面失败、中断、或服务重启，已经产出的（选题/初稿/打磨/成品）也都在历史里、刷新可见。
  const liveBag: Record<string, unknown> = {};
  // 记下这条 run 用的人设 id，单节点重试时要据此重建 ctx。
  liveBag.__personaId = personaId;
  void persistRun(RUNS_DIR, runId, liveBag).catch(() => {});
  const onEvent = (e: Parameters<typeof bus.emit>[0]) => {
    if (e.type === 'run.start') currentEvents = [];
    currentEvents.push(e);
    bus.emit(e);
    if (e.type === 'stage.done') {
      liveBag[e.skill] = e.output;
      void persistRun(RUNS_DIR, runId, liveBag).catch(() => {});
    } else if (e.type === 'gate') {
      liveBag[`gate.${e.skill}`] = e.choice;
    }
  };
  try {
    const persona = personaId === 'demo' ? demoPersona : await loadPersona(personaId);
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
        // Opus 经 fox 代理单步可能 1-3 分钟；deepsearch 联网检索更慢；单步给到 8 分钟，避免成功前被掐。
        skillTimeoutMs: 480_000,
        // 含人工卡点等待 + 联网调研/多轮精修等慢节点，放宽到 60 分钟。
        runWallclockMs: 3_600_000,
        gate: interactiveGate,
        // 失败先静默自动重试 1 次（吞瞬时超时/限流），仍失败则交人工。
        autoRetries: 1,
        onStageFailed: interactiveStageFailed,
        onEvent,
      },
    });
    const dir = await persistRun(RUNS_DIR, runId, bag);
    bus.emit({ type: 'run.done', runId, dir });
  } catch (e) {
    // 失败/中止时，已增量落盘的部分仍在历史里；这里兜底再存一次当前进度。
    await persistRun(RUNS_DIR, runId, liveBag).catch(() => {});
    bus.emit({ type: 'run.failed', error: e instanceof Error ? e.message : String(e) });
  } finally {
    running = false;
    pendingGate = null;
    pendingFailure = null;
  }
  return true;
}

/**
 * 单节点重试：对已落盘的某条 run，用已记录的前序数据重跑指定的一个节点，
 * 回写 result.json[skill]。进度经 bus 广播，UI 能看到该节点 running→done。
 */
async function retryNode(
  runId: string,
  skillName: string,
): Promise<{ ok: boolean; error?: string }> {
  if (running || retrying) return { ok: false, error: '已有任务在跑，稍后再试' };
  let skill: ReturnType<ReturnType<typeof buildRegistry>['get']>;
  try {
    skill = buildRegistry().get(skillName);
  } catch {
    return { ok: false, error: '未知节点' };
  }
  const resultPath = join(RUNS_DIR, runId, 'result.json');
  let bag: Record<string, unknown>;
  try {
    bag = JSON.parse(await readFile(resultPath, 'utf8'));
  } catch {
    return { ok: false, error: '找不到该 run' };
  }
  retrying = true;
  try {
    const personaId = (bag.__personaId as string) ?? 'gunzi-daren';
    const persona = personaId === 'demo' ? demoPersona : await loadPersona(personaId);
    const writer = makeLlm();
    const ctx: SkillContext = {
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
      emit: (m) => bus.emit({ type: 'stage.progress', skill: skill.name, msg: m }),
      signal: new AbortController().signal,
    };
    bus.emit({ type: 'stage.start', skill: skill.name, title: skill.title, index: -1 });
    const output = await Promise.race([
      skill.run(ctx),
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new Error(`重试超时（${NODE_RETRY_TIMEOUT_MS}ms）`)),
          NODE_RETRY_TIMEOUT_MS,
        ),
      ),
    ]);
    bag[skill.name] = output;
    await persistRun(RUNS_DIR, runId, bag);
    bus.emit({ type: 'stage.done', skill: skill.name, output });
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    bus.emit({ type: 'stage.failed', skill: skill.name, title: skill.title, error, attempt: 1 });
    return { ok: false, error };
  } finally {
    retrying = false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', service: 'macro-influencer' }));
    return;
  }

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
    // 重放当前 run 已发生的事件，让刚连上的页面重建出实时状态（含未答的卡点）。
    for (const e of currentEvents) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const off = bus.on((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      off();
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: SERVER_ID }));
    return;
  }

  // 配图：runs/<runId>/imgs/<name>.png。防目录穿越，只允许 png 文件名。
  if (req.method === 'GET' && url.pathname.startsWith('/img/')) {
    const rest = url.pathname.slice('/img/'.length);
    const slash = rest.indexOf('/');
    const runId = decodeURIComponent(rest.slice(0, slash));
    const name = decodeURIComponent(rest.slice(slash + 1));
    if (slash < 0 || !/^[\w.-]+\.png$/.test(name) || runId.includes('..')) {
      res.writeHead(400);
      res.end('bad path');
      return;
    }
    try {
      const buf = await readFile(join(RUNS_DIR, runId, 'imgs', name));
      // 不缓存：同名图会被重出/重试覆盖，缓存会让你一直看到旧图。
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end('no image');
    }
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

  if (req.method === 'POST' && url.pathname === '/retry') {
    const choice = url.searchParams.get('choice') ?? '';
    if (!pendingFailure) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '当前没有待处理的失败' }));
      return;
    }
    const ok = choice === 'retry' || choice === 'skip' || choice === 'abort';
    if (ok) {
      const f = pendingFailure;
      pendingFailure = null;
      f.resolve(choice as 'retry' | 'skip' | 'abort');
    }
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { ok: true } : { error: '非法选项' }));
    return;
  }

  // 单节点重试：用已记录的前序数据重跑某个节点，回写 result.json。
  if (req.method === 'POST' && url.pathname === '/node-retry') {
    const runId = url.searchParams.get('run') ?? '';
    const skillName = url.searchParams.get('skill') ?? '';
    const runs = await listRuns();
    if (!runs.some((r) => r.id === runId) || !skillName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '非法参数' }));
      return;
    }
    const r = await retryNode(runId, skillName);
    res.writeHead(r.ok ? 200 : running || retrying ? 409 : 400, {
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify(r.ok ? { ok: true } : { error: r.error }));
    return;
  }

  // 单张配图重试：对已落盘的某 run 重出第 index 张图（用已存的分镜文案），并回写 result.json。
  if (req.method === 'POST' && url.pathname === '/img-retry') {
    const runId = url.searchParams.get('run') ?? '';
    const index = Number(url.searchParams.get('index'));
    const runs = await listRuns();
    if (!runs.some((r) => r.id === runId) || !Number.isInteger(index) || index < 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '非法参数' }));
      return;
    }
    const resultPath = join(RUNS_DIR, runId, 'result.json');
    let bag: Record<string, unknown>;
    try {
      bag = JSON.parse(await readFile(resultPath, 'utf8'));
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '找不到该 run' }));
      return;
    }
    const ir = bag['image.render'] as ImageSet | undefined;
    const asset = bag['asset.assemble'] as FinalAsset | undefined;
    const stored = ir?.images?.[index] as (RenderedImage & { prompt?: string }) | undefined;
    // 优先用已存的设计稿；老 run 没有 panel 则用旧文案/⑧ 分镜兜底成 panel。
    const panel: ImagePanel = stored?.panel ?? {
      role: '配图',
      headline: '',
      visual: stored?.prompt ?? asset?.imagePrompts?.[index] ?? '',
    };
    const dir = imageDir(runId);
    await mkdir(dir, { recursive: true });
    // 合成模式：用已存 panel（含选定素材）重新合成这一张；不调用 LLM。
    const result = await renderPanel(panel, index, dir);
    if (ir?.images) ir.images[index] = result;
    else bag['image.render'] = { images: [result] } satisfies ImageSet;
    await writeFile(resultPath, JSON.stringify(bag, null, 2));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
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
