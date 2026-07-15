// 小红书图文笔记发布驱动：用 agent-browser（CDP）驱动创作平台，把一个发布包投递成笔记。
// 登录态来自 out/xhs-auth.json（用户从已登录 Chrome 导出的 cookie，见 pnpm publish:auth）。
//
// 用法：
//   pnpm publish:xhs <runId|latest> [--live] [--session <name>]
//     默认（不带 --live）：传图+填标题正文后停在编辑器，截图 /tmp/xhs-preview.png 供人工确认，不点发布
//     --live：填完后点「发布」，真实上线
//
// 设计原则（踩过的坑）：
//   - 绝不在图文编辑器页跑整页 snapshot（DOM 巨大，默认 25s 超时 → 像卡死）。只用定向 eval / CSS 选择器。
//   - 每个 agent-browser 调用独立、带超时，串行执行，不堆后台命令（否则 daemon 队列堵死）。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT = resolve('out/publish');
const AUTH = resolve('out/xhs-auth.json');
const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official';

// 创作平台图文编辑器选择器（可能随小红书改版调整，集中在此便于维护）
const SEL = {
  fileInput: 'input.upload-input',
  titleInput: 'input[placeholder*="标题"]',
  // 小红书正文用 TipTap/ProseMirror 富文本（contenteditable），不是 Quill
  bodyEditor: '.tiptap',
};

export interface DriverArgs {
  runId?: string;
  live: boolean;
  session: string;
}

export function parseDriverArgs(argv: string[]): DriverArgs {
  const a: DriverArgs = { live: false, session: 'xhs' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] ?? '';
    if (t === '--live') a.live = true;
    else if (t === '--session') a.session = argv[++i] ?? 'xhs';
    else if (!t.startsWith('-') && t !== 'latest' && !a.runId) a.runId = t;
  }
  return a;
}

/** 跑一条 agent-browser 命令，串行、带超时，返回 stdout。 */
function ab(
  session: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): string {
  try {
    return execFileSync('agent-browser', ['--session-name', session, ...args], {
      input: opts.input,
      timeout: opts.timeoutMs ?? 40_000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `agent-browser ${args[0]} 失败：${err.stderr || err.stdout || err.message}`.trim(),
    );
  }
}

/** 用 eval 执行一段 JS（走 stdin 避免引号地狱），返回结果字符串。 */
function evalJs(session: string, js: string): string {
  return ab(session, ['eval', '--stdin'], { input: js });
}

/**
 * 点击底部 footer 的「发布」/「暂存离开」。它们在 <xhs-publish-btn> 自定义组件的**闭合 shadow DOM**
 * 里——querySelectorAll / find text 都穿不透（踩过坑）。但无障碍树 snapshot 能透出，
 * 局部 `snapshot -s xhs-publish-btn` 拿到内部 button 的 ref（如 `button "发布" [ref=e29]`）再点 ref。
 */
function clickFooterButton(session: string, label: '发布' | '暂存离开'): void {
  const snap = ab(session, ['snapshot', '-s', 'xhs-publish-btn'], { timeoutMs: 25_000 });
  // 匹配 `button "<label>" [ref=eNN]`，label 精确（避免 发布≠暂存离开）
  const re = new RegExp(`button\\s+"${label}"\\s*\\[ref=(e\\d+)\\]`);
  const ref = snap.match(re)?.[1];
  if (!ref) throw new Error(`footer 里找不到「${label}」按钮（snapshot: ${snap.slice(0, 120)}）`);
  ab(session, ['click', `@${ref}`], { timeoutMs: 15_000 });
}

function log(msg: string) {
  console.log(msg);
}

/** 读取发布包：标题、正文（caption，不含标签）、标签数组、图片绝对路径。 */
function loadPackage(runId: string): {
  title: string;
  body: string;
  tags: string[];
  images: string[];
} {
  const dir = join(OUT, runId);
  if (!existsSync(dir)) throw new Error(`发布包不存在：${dir}（先跑 pnpm publish ${runId}）`);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    title?: string;
    body?: string;
    tags?: string[];
    images?: string[];
  };
  // 正文用 package.json 的 body（纯 caption，不含 #标签）；标签单独走话题机制，
  // 避免把 "#xxx" 当普通文本键入触发小红书话题弹窗、截获输入把笔记搞乱。
  const title = (pkg.title ?? readFileSync(join(dir, 'title.txt'), 'utf8')).trim();
  const body = (pkg.body ?? '').trim();
  const tags = (pkg.tags ?? []).filter(Boolean);
  const imgDir = join(dir, 'images');
  const n = (pkg.images ?? []).length;
  const images = Array.from({ length: n }, (_, i) =>
    join(imgDir, `${String(i + 1).padStart(2, '0')}.png`),
  ).filter(existsSync);
  if (!images.length) throw new Error(`发布包没有图片：${imgDir}`);
  return { title, body, tags, images };
}

async function run(args: DriverArgs) {
  const runId = args.runId ?? 'latest';
  if (!existsSync(AUTH)) throw new Error(`缺登录态 ${AUTH}：先跑 pnpm publish:auth 注入 cookie`);
  // latest：找最新的发布包
  let id = runId;
  if (id === 'latest') {
    const { readdirSync } = await import('node:fs');
    const dirs = readdirSync(OUT)
      .filter((d) => d.startsWith('run-'))
      .sort()
      .reverse();
    if (!dirs.length) throw new Error(`${OUT} 下没有发布包`);
    id = dirs[0] as string;
  }
  const { title, body, tags, images } = loadPackage(id);
  const S = args.session;
  log(
    `📤 发布包 ${id}：标题「${title}」/ 正文 ${[...body].length} 字 / ${tags.length} 标签 / ${images.length} 图`,
  );

  log('[1/7] 关旧会话');
  try {
    ab(S, ['close'], { timeoutMs: 15_000 });
  } catch {
    /* 没有旧会话就算了 */
  }

  log('[2/7] 用登录态打开发布页');
  ab(S, ['--state', AUTH, 'open', PUBLISH_URL], { timeoutMs: 40_000 });
  ab(S, ['wait', '2500'], { timeoutMs: 10_000 });

  const who = evalJs(S, "document.body.innerText.includes('棍子大人')?'OK':'NO'");
  if (!who.includes('OK'))
    throw new Error('登录态失效（页面没出现「棍子大人」），重新 pnpm publish:auth');
  log('  ✓ 登录态有效（棍子大人）');

  log('[3/7] 切到「上传图文」');
  const tab = evalJs(
    S,
    `(()=>{const els=[...document.querySelectorAll('*')].filter(e=>e.childElementCount===0&&e.textContent.trim()==='上传图文');const t=els[els.length-1];if(t){t.click();return 'CLICKED'}return 'NOT_FOUND'})()`,
  );
  if (!tab.includes('CLICKED')) throw new Error('找不到「上传图文」tab');
  ab(S, ['wait', '1500'], { timeoutMs: 8_000 });

  log('[4/7] 上传图片');
  ab(S, ['upload', SEL.fileInput, ...images], { timeoutMs: 90_000 });
  // 等图片上传+缩略图渲染、编辑器出现
  ab(S, ['wait', SEL.titleInput, '--timeout', '60000'], { timeoutMs: 65_000 });
  ab(S, ['wait', '1500'], { timeoutMs: 8_000 });
  log('  ✓ 图片已传、编辑器就绪');

  log('[5/7] 填标题');
  ab(S, ['fill', SEL.titleInput, title], { timeoutMs: 20_000 });

  log('[6/7] 填正文 + 话题标签');
  // ProseMirror（.tiptap）是 contenteditable，fill 不生效；点聚焦后真实键入（换行→段落）。
  ab(S, ['click', SEL.bodyEditor], { timeoutMs: 15_000 });
  ab(S, ['type', SEL.bodyEditor, body], { timeoutMs: 90_000 });
  // 标签单独加做成「真·话题链接」：键入 "#词" 触发小红书话题补全框（TipTap mention 插件），
  // **总是按 Enter 选中高亮的第一个候选**——纯文本 "#词" 在小红书不是可点话题，必须从下拉选中。
  // （之前"检测到弹窗才按 Enter"，检测选择器没命中就没选 → 标签没生效，踩过坑。）
  // 候选第一项通常是已有热门话题或"新建话题 #词"，选中即成链接；万一无弹窗 Enter 只是换行，可接受。
  if (tags.length) {
    ab(S, ['type', SEL.bodyEditor, '\n'], { timeoutMs: 10_000 });
    for (const tag of tags) {
      ab(S, ['type', SEL.bodyEditor, `#${tag}`], { timeoutMs: 15_000 });
      ab(S, ['wait', '900'], { timeoutMs: 5_000 }); // 等话题下拉加载候选
      ab(S, ['press', 'Enter'], { timeoutMs: 5_000 }); // 选中第一个候选 = 话题链接
      ab(S, ['type', SEL.bodyEditor, ' '], { timeoutMs: 8_000 }); // 标签间空格分隔
    }
  }
  // 校验正文是否进去了
  const bodyLen = evalJs(
    S,
    `(()=>{const e=document.querySelector('${SEL.bodyEditor}');return e?String(e.innerText.trim().length):'0'})()`,
  );
  log(`  ✓ 正文+${tags.length}标签已填（编辑器内 ${bodyLen} 字）`);

  ab(S, ['screenshot', '/tmp/xhs-preview.png'], { timeoutMs: 20_000 });
  log('  📸 预览截图 /tmp/xhs-preview.png');

  if (!args.live) {
    log('\n⏸  草稿/预览模式：已填好，未点发布。');
    log('   人工确认无误后，加 --live 真实发布；或在浏览器里手动点「发布」。');
    return;
  }

  log('[7/7] --live：点击底部「发布」提交');
  clickFooterButton(S, '发布');
  ab(S, ['wait', '4000'], { timeoutMs: 10_000 });
  ab(S, ['screenshot', '/tmp/xhs-published.png'], { timeoutMs: 20_000 });
  log('  ✅ 已点发布。截图 /tmp/xhs-published.png，去「笔记管理」核对。');
}

if (/[/\\]xhs-driver\.(ts|js)$/.test(process.argv[1] ?? '')) {
  run(parseDriverArgs(process.argv.slice(2))).catch((e) => {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  });
}
