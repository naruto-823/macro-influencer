// 注入小红书登录态：把从已登录 Chrome 导出的 cookie（DevTools「Copy as cURL」里的 -b 串，
// 或纯 "k=v; k=v" 串）灌进 agent-browser 会话，验证登录后存成 out/xhs-auth.json 供发布驱动复用。
// cookie 时效约一周，过期后重导一次即可。
//
// 用法：
//   pnpm publish:auth <cookie文件>      # 文件内容是 cookie 串（或整段 curl，会自动抠出 -b）
//   pbpaste | pnpm publish:auth -       # 从剪贴板读
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AUTH_OUT = resolve('out/xhs-auth.json');
const COOKIE_DOMAIN = '.xiaohongshu.com';
const VERIFY_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official';

/** 从输入里抠出 cookie 串：支持整段 curl（取 -b/--cookie 的引号内容）或裸 "k=v; k=v"。 */
export function extractCookieString(raw: string): string {
  const m = raw.match(/(?:-b|--cookie)\s+'([^']+)'/) || raw.match(/(?:-b|--cookie)\s+"([^"]+)"/);
  if (m?.[1]) return m[1].trim();
  // 没有 -b：当作裸 cookie 串（取含有最多 '=' 和 ';' 的那部分）
  return raw.trim();
}

/** 解析 "k=v; k=v" 成键值对（value 里可能含 = / + 等，按首个 = 切）。 */
export function parseCookiePairs(cookieStr: string): Array<{ name: string; value: string }> {
  return cookieStr
    .split(/;\s*/)
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim() };
    })
    .filter((c) => c.name && c.value);
}

function ab(session: string, args: string[], input?: string): string {
  return execFileSync('agent-browser', ['--session-name', session, ...args], {
    input,
    encoding: 'utf8',
    timeout: 40_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

async function main() {
  const src = process.argv[2];
  if (!src) throw new Error('用法：pnpm publish:auth <cookie文件|->');
  const raw = src === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(src), 'utf8');
  const cookies = parseCookiePairs(extractCookieString(raw));
  if (!cookies.length) throw new Error('没解析到任何 cookie');
  const S = 'xhs';

  console.log(`🍪 解析到 ${cookies.length} 个 cookie，注入会话 ${S}…`);
  try {
    ab(S, ['close']);
  } catch {
    /* 无旧会话 */
  }
  ab(S, ['open', 'about:blank']);
  let ok = 0;
  for (const c of cookies) {
    try {
      ab(S, [
        'cookies',
        'set',
        c.name,
        c.value,
        '--domain',
        COOKIE_DOMAIN,
        '--path',
        '/',
        '--secure',
      ]);
      ok++;
    } catch (e) {
      console.warn(`  ⚠️ ${c.name} 注入失败：${(e as Error).message.split('\n')[0]}`);
    }
  }
  console.log(`  注入 ${ok}/${cookies.length}`);

  console.log('🔎 验证登录态…');
  ab(S, ['open', VERIFY_URL]);
  ab(S, ['wait', '2500']);
  const who = ab(S, ['eval', '--stdin'], "document.body.innerText.includes('棍子大人')?'OK':'NO'");
  if (!who.includes('OK'))
    throw new Error('登录态无效（页面没出现「棍子大人」）：cookie 可能过期或不全');

  mkdirSync(resolve('out'), { recursive: true });
  ab(S, ['state', 'save', AUTH_OUT]);
  console.log(`✅ 登录态有效（棍子大人），已存 ${AUTH_OUT}`);
  console.log(
    '   下一步：pnpm publish <runId> 出包 → pnpm publish:xhs <runId>（草稿预览）/ --live（真发）',
  );
}

if (/[/\\]auth-setup\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  });
}
