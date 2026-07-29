import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeJudge, makeLlm, newRunId } from '../cli.js';
import { EventBus } from '../engine/events.js';
import type {
  FinalAsset,
  ImagePanel,
  ImageSet,
  RenderedImage,
  SkillContext,
} from '../engine/types.js';
import { MastraPipelineRuntime } from '../mastra/pipeline.js';
import { persistRun } from '../output/persist.js';
import { gunziDarenPersona } from '../persona/examples/gunzi-daren.js';
import { buildRegistry } from '../run.js';
import { imageDir, renderPanel } from '../skills/image-render.js';
import { CachedHotspotSource } from '../sources/cached-hotspot.js';
import { MultiHotspotSource } from '../sources/web-hotspot.js';
import { WeiboHotspotSource } from '../sources/weibo-hotspot.js';
import {
  ensureAccount,
  getAccount,
  importAccount,
  initializeAccounts,
  listAccounts,
  userIdForUsername,
} from './account-store.js';
import { authenticateUser, createUser, initializeUsers } from './auth-store.js';
import { analyzeXhsProfile } from './xhs-profile.js';

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

const RUNS_DIR = resolve('runs');
const pipelineRuntime = await MastraPipelineRuntime.create(process.env.DATABASE_URL ?? '');

type PipelineEvent = Parameters<EventBus['emit']>[0];
interface ClientState {
  bus: EventBus;
  running: boolean;
  retrying: boolean;
  pendingGate: { options: string[]; step: 'topic.approval' | 'risk.approval' } | null;
  events: PipelineEvent[];
  currentRunId: string | null;
}
const clients = new Map<string, ClientState>();
function stateFor(userId: string): ClientState {
  let state = clients.get(userId);
  if (!state) {
    state = {
      bus: new EventBus(),
      running: false,
      retrying: false,
      pendingGate: null,
      events: [],
      currentRunId: null,
    };
    clients.set(userId, state);
  }
  return state;
}
const AUTH_SESSION_SECRET = process.env.AUTH_SESSION_SECRET ?? '';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function cookie(req: IncomingMessage, name: string): string | undefined {
  return req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
function signature(value: string): string {
  return createHmac('sha256', AUTH_SESSION_SECRET).update(value).digest('base64url');
}
function sessionFor(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ userId, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 }),
  ).toString('base64url');
  return `${payload}.${signature(payload)}`;
}
function requestUserId(req: IncomingMessage): string | undefined {
  if (!AUTH_SESSION_SECRET) return undefined;
  const token = cookie(req, 'mi_session');
  if (!token) return undefined;
  const [payload, supplied] = token.split('.');
  if (!payload || !supplied) return undefined;
  const expected = signature(payload);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      userId?: string;
      expiresAt?: number;
    };
    if (!parsed.userId || (parsed.expiresAt ?? 0) < Date.now()) return undefined;
    return parsed.userId;
  } catch {
    return undefined;
  }
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.reduce((sum, chunk) => sum + chunk.length, 0) > 16_384) throw new Error('请求过大');
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}
const LOGIN_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 百万网红 Agent</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0d1117;color:#e6edf3;font:15px -apple-system,"PingFang SC",sans-serif}.card{width:min(100%,390px);padding:30px;background:#161b22;border:1px solid #30363d;border-radius:16px}h1{font-size:22px;margin:0 0 8px}.sub{color:#8b949e;margin-bottom:26px}h2{font-size:18px;margin:0 0 18px}label{display:block;margin:14px 0 6px}input,button{width:100%;padding:11px 12px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;font:inherit}input:focus{outline:2px solid #8957e5;border-color:transparent}button{margin-top:20px;background:#8957e5;border-color:#8957e5;font-weight:600;cursor:pointer}.confirm{display:none}.err{min-height:22px;color:#f85149;margin-top:10px}.switch{text-align:center;color:#8b949e;margin-top:16px}.switch button{display:inline;width:auto;padding:0;margin:0;border:0;background:none;color:#a371f7;font-weight:600}</style></head><body><form class="card" id="auth"><h1>🚀 百万网红 Agent</h1><div class="sub">每个账号拥有独立的任务和历史</div><h2 id="modeTitle">登录</h2><label>账号</label><input name="username" autocomplete="username" pattern="[A-Za-z0-9_-]{3,32}" required autofocus><label>密码</label><input name="password" type="password" minlength="10" autocomplete="current-password" required><div class="confirm"><label>确认密码</label><input name="confirmPassword" type="password" minlength="10" autocomplete="new-password"></div><button id="submit">登录</button><div class="err" id="err"></div><div class="switch"><span id="switchText">没有账号？</span> <button type="button" id="switchMode">立即注册</button></div></form><script>let mode='login';const form=document.getElementById('auth'),confirmBox=document.querySelector('.confirm'),confirmInput=document.querySelector('[name=confirmPassword]'),error=document.getElementById('err'),submit=document.getElementById('submit');document.getElementById('switchMode').onclick=()=>{mode=mode==='login'?'register':'login';const registering=mode==='register';document.getElementById('modeTitle').textContent=registering?'创建账号':'登录';submit.textContent=registering?'注册并登录':'登录';confirmBox.style.display=registering?'block':'none';confirmInput.required=registering;document.getElementById('switchText').textContent=registering?'已有账号？':'没有账号？';document.getElementById('switchMode').textContent=registering?'返回登录':'立即注册';error.textContent=''};form.onsubmit=async e=>{e.preventDefault();if(mode==='register'&&form.password.value!==confirmInput.value){error.textContent='两次输入的密码不一致';return}submit.disabled=true;const r=await fetch('/'+mode,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});const j=await r.json().catch(()=>({}));if(r.ok)location.href='/';else{error.textContent=j.error||'操作失败';submit.disabled=false}}</script></body></html>`;

/** 单步重试上限：须长于 deep.search 自身的 20 分钟，给收尾和结果落盘留余量。 */
const NODE_RETRY_TIMEOUT_MS = 1_500_000;

/** 列出历史 run（读 runs/<id>/result.json），按时间倒序，附带一个标题用于展示。 */
async function listRuns(
  userId: string,
): Promise<Array<{ id: string; title: string; done: boolean }>> {
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
      if (bag.__userId !== userId) continue;
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

/** 触发一次真跑（交互卡点：选题/风控需在网页里点选），事件经 bus 广播给所有 SSE 连接。 */
async function startRun(userId: string, state: ClientState, personaId: string): Promise<boolean> {
  if (state.running) return false;
  state.running = true;
  state.pendingGate = null;
  const runId = newRunId();
  state.currentRunId = runId;
  const onEvent = (e: PipelineEvent) => {
    if (e.type === 'run.start') state.events = [];
    state.events.push(e);
    state.bus.emit(e);
    if (e.type === 'gate.waiting') {
      state.pendingGate = {
        options: e.options,
        step: e.skill === 'risk.review' ? 'risk.approval' : 'topic.approval',
      };
    } else if (e.type === 'gate') {
      state.pendingGate = null;
    } else if (e.type === 'run.done') {
      state.running = false;
      state.currentRunId = null;
    } else if (e.type === 'run.failed') {
      state.running = false;
    }
  };
  try {
    await pipelineRuntime.start({ runId, userId, personaId, onEvent });
  } catch (e) {
    state.running = false;
    state.currentRunId = null;
    onEvent({ type: 'run.failed', error: e instanceof Error ? e.message : String(e) });
    return false;
  }
  return true;
}

/**
 * 单节点重试：对已落盘的某条 run，用已记录的前序数据重跑指定的一个节点，
 * 回写 result.json[skill]。进度经 bus 广播，UI 能看到该节点 running→done。
 */
async function retryNode(
  userId: string,
  state: ClientState,
  runId: string,
  skillName: string,
): Promise<{ ok: boolean; error?: string }> {
  if (state.running || state.retrying) return { ok: false, error: '已有任务在跑，稍后再试' };
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
    if (bag.__userId !== userId) return { ok: false, error: '找不到该 run' };
  } catch {
    return { ok: false, error: '找不到该 run' };
  }
  state.retrying = true;
  try {
    const personaId = bag.__personaId as string;
    const persona = await getAccount(userId, personaId);
    if (!persona) return { ok: false, error: '账号不存在或不属于当前用户' };
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
      emit: (m) => state.bus.emit({ type: 'stage.progress', skill: skill.name, msg: m }),
      signal: new AbortController().signal,
    };
    state.bus.emit({ type: 'stage.start', skill: skill.name, title: skill.title, index: -1 });
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
    state.bus.emit({ type: 'stage.done', skill: skill.name, output });
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    state.bus.emit({
      type: 'stage.failed',
      skill: skill.name,
      title: skill.title,
      error,
      attempt: 1,
    });
    return { ok: false, error };
  } finally {
    state.retrying = false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', service: 'macro-influencer' }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/login') {
    try {
      const body = await readJson(req);
      const userId = await authenticateUser(
        String(body.username ?? ''),
        String(body.password ?? ''),
      );
      if (!userId || !AUTH_SESSION_SECRET) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '账号或密码错误' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `mi_session=${sessionFor(userId)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
      });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '非法请求' }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/register') {
    try {
      const body = await readJson(req);
      if (body.password !== body.confirmPassword) throw new Error('两次输入的密码不一致');
      const userId = await createUser(String(body.username ?? ''), String(body.password ?? ''));
      res.writeHead(201, {
        'Content-Type': 'application/json',
        'Set-Cookie': `mi_session=${sessionFor(userId)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
      });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : '注册失败' }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/logout') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'mi_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const userId = requestUserId(req);

  if (req.method === 'GET' && url.pathname === '/') {
    if (!userId) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(LOGIN_HTML);
      return;
    }
    const html = await readFile(INDEX_HTML, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return;
  }

  if (!userId) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: '请先登录' }));
    return;
  }
  const state = stateFor(userId);

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    // 重放当前 run 已发生的事件，让刚连上的页面重建出实时状态（含未答的卡点）。
    for (const e of state.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const off = state.bus.on((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
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
      if (!(await listRuns(userId)).some((r) => r.id === runId)) throw new Error('forbidden');
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
    res.end(JSON.stringify(await listRuns(userId)));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/accounts') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(await listAccounts(userId)));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/accounts/import') {
    try {
      const body = await readJson(req);
      const account = await importAccount(userId, {
        sourceUrl: String(body.sourceUrl ?? ''),
        displayName: String(body.displayName ?? ''),
        positioning: String(body.positioning ?? ''),
        styleGuide: String(body.styleGuide ?? ''),
        sampleNotes: [
          { title: String(body.sampleTitle ?? ''), body: String(body.sampleBody ?? '') },
        ],
        topicPreferences: String(body.topicPreferences ?? '')
          .split(/[,，\n]/)
          .map((item) => item.trim())
          .filter(Boolean),
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(account));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : '导入失败' }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/accounts/analyze') {
    try {
      const body = await readJson(req);
      const analysis = await analyzeXhsProfile(String(body.url ?? ''), makeLlm());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(analysis));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : '主页分析失败' }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/runs/')) {
    const id = decodeURIComponent(url.pathname.slice('/runs/'.length));
    // 防目录穿越：只允许实际存在的 run 目录
    const runs = await listRuns(userId);
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
    const recovered =
      state.pendingGate && state.currentRunId
        ? null
        : await pipelineRuntime.findRun(userId, ['suspended']);
    const runId = state.currentRunId ?? recovered?.runId;
    const step =
      state.pendingGate?.step ??
      (recovered?.suspendedStep === 'risk.approval' ? 'risk.approval' : 'topic.approval');
    if (!runId) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '当前没有待决策的卡点' }));
      return;
    }
    // 只接受合法选项，避免乱传
    const ok = state.pendingGate ? state.pendingGate.options.includes(choice) : choice.length > 0;
    if (ok) {
      try {
        state.pendingGate = null;
        state.currentRunId = runId;
        state.running = true;
        await pipelineRuntime.resume(runId, userId, step, choice);
      } catch (error) {
        state.running = false;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : '恢复失败' }));
        return;
      }
    }
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { ok: true } : { error: '非法选项' }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/retry') {
    const choice = url.searchParams.get('choice') ?? '';
    const recovered = state.currentRunId ? null : await pipelineRuntime.findRun(userId, ['failed']);
    const runId = state.currentRunId ?? recovered?.runId;
    if (!runId) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '当前没有待处理的失败' }));
      return;
    }
    const ok = choice === 'retry' || choice === 'abort';
    if (choice === 'retry') {
      state.running = true;
      state.currentRunId = runId;
      await pipelineRuntime.restart(runId, userId);
    } else if (choice === 'abort') {
      state.currentRunId = null;
    }
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { ok: true } : { error: '非法选项' }));
    return;
  }

  // 单节点重试：用已记录的前序数据重跑某个节点，回写 result.json。
  if (req.method === 'POST' && url.pathname === '/node-retry') {
    const runId = url.searchParams.get('run') ?? '';
    const skillName = url.searchParams.get('skill') ?? '';
    const runs = await listRuns(userId);
    if (!runs.some((r) => r.id === runId) || !skillName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '非法参数' }));
      return;
    }
    const r = await retryNode(userId, state, runId, skillName);
    res.writeHead(r.ok ? 200 : state.running || state.retrying ? 409 : 400, {
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify(r.ok ? { ok: true } : { error: r.error }));
    return;
  }

  // 单张配图重试：对已落盘的某 run 重出第 index 张图（用已存的分镜文案），并回写 result.json。
  if (req.method === 'POST' && url.pathname === '/img-retry') {
    const runId = url.searchParams.get('run') ?? '';
    const index = Number(url.searchParams.get('index'));
    const runs = await listRuns(userId);
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
    const personaId = url.searchParams.get('persona') ?? '';
    if (!(await getAccount(userId, personaId))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '请先选择自己导入的账号' }));
      return;
    }
    const existing = await pipelineRuntime.findRun(userId, [
      'running',
      'pending',
      'waiting',
      'suspended',
    ]);
    const ok = existing ? false : await startRun(userId, state, personaId);
    res.writeHead(ok ? 202 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { started: true } : { error: '已有任务在跑' }));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

await initializeUsers();
await initializeAccounts();
const adminUsername = process.env.AUTH_USERNAME;
if (adminUsername) {
  const adminId = await userIdForUsername(adminUsername);
  if (adminId) await ensureAccount(adminId, gunziDarenPersona);
}
server.listen(PORT, () => {
  console.log(`\n🖥  生产链路可视化已启动： http://localhost:${PORT}`);
  console.log('   打开后点「开始跑」，用真实人设走一遍并实时观看。\n');
});
