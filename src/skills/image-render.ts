import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import type {
  FinalAsset,
  ImagePanel,
  ImageSet,
  RenderedImage,
  RiskReport,
  Skill,
} from '../engine/types.js';
import type { LlmClient } from '../llm/client.js';

const W = 1080;
const H = 1440;
/** 人物素材集目录（透明 .cut.png + manifest.json）；可用 CHAR_ASSETS_DIR 覆盖（测试里指向空目录即跳过出图）。 */
function defaultCharDir(): string {
  return resolve(process.env.CHAR_ASSETS_DIR ?? 'assets/characters/doraemon');
}

/** 一套明亮、活泼但协调的漫画渐变背景，按分镜轮换，让 6 张图彩而不乱。 */
const PALETTES: Array<[string, string]> = [
  ['#bfe6ff', '#79c4ff'],
  ['#fff0a8', '#ffd05a'],
  ['#c9f6e4', '#76e0bd'],
  ['#ffd6e7', '#ff9ec6'],
  ['#ddd6ff', '#a99bff'],
  ['#ffe2c0', '#ffb46e'],
];
/** 每张图的强调色（高亮关键词/数据牌），跟背景搭。 */
const ACCENTS = ['#ff3b30', '#ff7a00', '#10b981', '#ff2d8a', '#7c4dff', '#ff6a00'];

interface CharAsset {
  file: string;
  w: number;
  h: number;
  desc: string;
}

function loadManifest(): CharAsset[] {
  try {
    return JSON.parse(readFileSync(join(defaultCharDir(), 'manifest.json'), 'utf8')) as CharAsset[];
  } catch {
    return [];
  }
}

function xesc(s: string): string {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );
}

/** CJK 友好的折行：超过 maxPerLine 就在靠中间、且不切断数字/英文词的位置断成 2 行。 */
function splitLines(text: string, maxPerLine: number): string[] {
  const chars = [...text.trim()];
  if (chars.length <= maxPerLine) return [chars.join('')];
  const isTok = (c?: string) => !!c && /[0-9A-Za-z%.]/.test(c);
  const mid = Math.ceil(chars.length / 2);
  let best = mid;
  for (let d = 0; d <= Math.floor(chars.length / 2); d++) {
    const cand = [mid - d, mid + d].filter((i) => i > 0 && i < chars.length);
    const ok = cand.find((i) => !(isTok(chars[i - 1]) && isTok(chars[i])));
    if (ok !== undefined) {
      best = ok;
      break;
    }
  }
  return [chars.slice(0, best).join(''), chars.slice(best).join('')];
}

/** 五角星 path。 */
function star(cx: number, cy: number, r: number, fill: string): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}" stroke="#1a1a2e" stroke-width="4" stroke-linejoin="round"/>`;
}

/** 把一张设计稿（含选定素材）合成成 PNG：真实人物素材 + 对话气泡 + 数据牌 + 漫画装饰。纯代码、不调 LLM。 */
export async function renderPanel(
  panel: ImagePanel,
  index: number,
  dir: string,
  charDir = defaultCharDir(),
): Promise<RenderedImage> {
  const name = `${String(index + 1).padStart(2, '0')}.png`;
  try {
    const manifest = (() => {
      try {
        return JSON.parse(readFileSync(join(charDir, 'manifest.json'), 'utf8')) as CharAsset[];
      } catch {
        return [];
      }
    })();
    const asset =
      manifest.find((m) => m.file === panel.asset) ??
      manifest[index % Math.max(manifest.length, 1)];
    if (!asset || !existsSync(join(charDir, asset.file))) {
      return { index, panel, file: null, ok: false, error: '缺少人物素材' };
    }
    const b64 = readFileSync(join(charDir, asset.file)).toString('base64');

    const [c1, c2] = PALETTES[index % PALETTES.length] as [string, string];
    const accent = ACCENTS[index % ACCENTS.length] as string;
    // 人物：贴底居中，限制高度。
    const charH = 760;
    const charW = Math.round((charH * asset.w) / asset.h);
    const charX = Math.round((W - charW) / 2);
    const charY = H - charH - 30;

    // 主文案气泡。
    const lines = splitLines(panel.headline || '', 7);
    const maxLen = Math.max(1, ...lines.map((l) => [...l].length));
    const fs = Math.max(48, Math.min(104, Math.floor(820 / maxLen)));
    const bw = Math.min(940, Math.max(560, maxLen * fs + 120));
    const lineH = Math.round(fs * 1.24);
    const subH = panel.sub ? 52 : 0;
    const bh = lines.length * lineH + 80 + subH;
    const bx = Math.round((W - bw) / 2);
    const by = 80;
    const tailX = charX + charW / 2 < W / 2 ? bx + bw * 0.32 : bx + bw * 0.68;

    // 主文案：把 emphasis 关键词/数字用强调色标出，其余深色，整体居中。
    const emph = panel.emphasis?.trim();
    const dark = (s: string) => (s ? `<tspan fill="#1a1a2e">${xesc(s)}</tspan>` : '');
    const headText = lines
      .map((l, i) => {
        const y = by + 56 + i * lineH + fs * 0.32;
        let inner = dark(l);
        if (emph) {
          const k = l.indexOf(emph);
          if (k >= 0) {
            inner = `${dark(l.slice(0, k))}<tspan fill="${accent}">${xesc(l.slice(k, k + emph.length))}</tspan>${dark(l.slice(k + emph.length))}`;
          }
        }
        return `<text x="${W / 2}" y="${y}" font-family="PingFang SC, sans-serif" font-size="${fs}" font-weight="800" text-anchor="middle">${inner}</text>`;
      })
      .join('');
    const subText = panel.sub
      ? `<text x="${W / 2}" y="${by + 56 + lines.length * lineH + 30}" font-family="PingFang SC, sans-serif" font-size="34" font-weight="600" fill="#5b6470" text-anchor="middle">${xesc(panel.sub)}</text>`
      : '';

    // 数据徽章（有 data 才画），斜放在人物上方一侧。
    const badge = panel.data
      ? (() => {
          const onLeft = charX + charW / 2 >= W / 2;
          const cx = onLeft ? 250 : W - 250;
          const cy = by + bh + 120;
          const txt = panel.data.slice(0, 10);
          const bwid = Math.max(180, [...txt].length * 40 + 60);
          return `<g transform="rotate(${onLeft ? -7 : 7} ${cx} ${cy})"><rect x="${cx - bwid / 2}" y="${cy - 56}" width="${bwid}" height="112" rx="22" fill="${accent}" stroke="#1a1a2e" stroke-width="6"/><text x="${cx}" y="${cy + 18}" font-family="PingFang SC, sans-serif" font-size="50" font-weight="800" fill="#fff" text-anchor="middle">${xesc(txt)}</text></g>`;
        })()
      : '';

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
  <radialGradient id="halo" cx="0.5" cy="0.42" r="0.6"><stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
  <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#1a1a2e" flood-opacity="0.18"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<ellipse cx="${W / 2}" cy="${charY + charH * 0.55}" rx="${W * 0.55}" ry="${H * 0.4}" fill="url(#halo)"/>
${star(140, 470, 46, '#ffd84d')}${star(W - 120, 430, 34, '#fff')}${star(W - 170, 700, 26, '#ffd84d')}${star(95, 760, 28, '#fff')}
<circle cx="${W - 90}" cy="560" r="12" fill="#ffffff" opacity="0.8"/><circle cx="120" cy="600" r="10" fill="#ffffff" opacity="0.8"/>
<ellipse cx="${W / 2}" cy="${H - 70}" rx="${charW * 0.42}" ry="34" fill="#1a1a2e" opacity="0.12"/>
<image x="${charX}" y="${charY}" width="${charW}" height="${charH}" xlink:href="data:image/png;base64,${b64}"/>
${badge}
<g filter="url(#sh)">
  <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="44" fill="#ffffff" stroke="#1a1a2e" stroke-width="8"/>
  <polygon points="${tailX - 36},${by + bh - 6} ${tailX + 36},${by + bh - 6} ${tailX - 10},${by + bh + 70}" fill="#ffffff" stroke="#1a1a2e" stroke-width="8" stroke-linejoin="round"/>
  <rect x="${tailX - 30}" y="${by + bh - 14}" width="60" height="16" fill="#ffffff"/>
</g>
${headText}
${subText}
</svg>`;

    const png = new Resvg(svg, {
      font: { loadSystemFonts: true },
      fitTo: { mode: 'width', value: W },
    })
      .render()
      .asPng();
    await writeFile(join(dir, name), png);
    return { index, panel, file: name, ok: true };
  } catch (e) {
    return {
      index,
      panel,
      file: null,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 某 run 配图目录。 */
export function imageDir(runId: string): string {
  return resolve('runs', runId, 'imgs');
}

const ART_DIRECTOR_SYSTEM =
  '你是百万粉小红书爆款操盘手 + 文案高手。你为一篇笔记设计一套【哆啦A梦漫画风、风格统一的 6 张竖版配图】，每张图哆啦A梦在对话气泡里说一句【爆款级钩子文案】。你最擅长写一眼勾住人、口语化、有冲突/悬念/反常识的短句——绝不写干巴巴的概括或说明。你只负责挑素材 + 写文案，合成由系统完成。';

interface RawPlan {
  concept?: string;
  panels?: Array<{
    role?: string;
    headline?: string;
    emphasis?: string;
    sub?: string;
    data?: string;
    asset?: string;
  }>;
}

/** 艺术指导：读成稿 + 素材清单，设计 6 张分镜（每张选一个素材、给文案）。 */
async function designPanels(
  llm: LlmClient,
  title: string,
  body: string,
  manifest: CharAsset[],
): Promise<{ concept: string; panels: ImagePanel[] }> {
  const assetList = manifest.map((m, i) => `${i + 1}. file="${m.file}" — ${m.desc}`).join('\n');
  const fallbackFile = (i: number) => manifest[i % manifest.length]?.file ?? '';
  try {
    const raw = await llm.completeJson<RawPlan>({
      schema: {
        type: 'object',
        properties: {
          concept: { type: 'string' },
          panels: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string' },
                headline: { type: 'string' },
                emphasis: { type: 'string' },
                sub: { type: 'string' },
                data: { type: 'string' },
                asset: { type: 'string' },
              },
              required: ['role', 'headline', 'emphasis', 'asset'],
            },
          },
        },
        required: ['concept', 'panels'],
      },
      system: ART_DIRECTOR_SYSTEM,
      prompt: [
        `标题：${title}`,
        `正文：\n${body}`,
        '',
        '可用的哆啦A梦素材（按表情/姿势挑最贴的，asset 字段填对应 file 名）：',
        assetList,
        '',
        '设计 6 张，输出 JSON：',
        '{"concept":"整套图的视觉主线一句话","panels":[{"role":"封面|数据|对比|金句|结尾","headline":"气泡里的爆款钩子(<=11字)","emphasis":"headline里要高亮的关键词或数字(必须是headline的子串)","sub":"补一刀的小字(可空,<=14字)","data":"数据牌上的短数字(可空,如3000台/76万/2203%)","asset":"选中的素材file名"}]}',
        '',
        '【文案怎么写才算爆款钩子】（这是重点，别敷衍）：',
        '· 口语、像人说话、带情绪或反差；制造好奇缺口或冲突，让人想点进去。',
        '· 多用：数字冲击 / 反常识断言 / 设问 / 「你」字代入 / 一刀见血的金句。',
        '· 好例子：「8天，3000个成年人下单」「越孤独，越好赚」「76万的它，不如3000块的它」「你买的不是陪伴，是不被拒绝」「连分手都能起诉了？」',
        '· 反面（别这样写）：「购买限制：仅限成年人」「从76万工具到情感陪伴」这种干巴巴的标签/概括。',
        '· emphasis 挑出 headline 里最该被一眼看到的词或数字（如「3000」「越好赚」「不被拒绝」），会被高亮成彩色。',
        '',
        '· 第1张封面：最热闹/惊讶姿势 + 最炸的钩子 + 大数字。',
        '· 中间 4 张各攻一个点（数据/对比/机制/洞察），按语气挑姿势（震惊用举手、介绍用指向、担忧用捧脸），data 尽量给具体数字。',
        '· 第6张金句或互动 CTA（摊手/疑惑姿势），sub 可放「评论区聊聊」。',
        '· headline 全部取自正文真实内容；6 张 asset 尽量不重复。',
      ].join('\n'),
    });
    const panels = (Array.isArray(raw?.panels) ? raw.panels : [])
      .filter((p) => p?.headline)
      .slice(0, 6)
      .map((p, i) => ({
        role: String(p.role ?? '配图'),
        headline: String(p.headline),
        emphasis: p.emphasis ? String(p.emphasis) : undefined,
        sub: p.sub ? String(p.sub) : undefined,
        data: p.data ? String(p.data) : undefined,
        asset:
          p.asset && manifest.some((m) => m.file === p.asset) ? String(p.asset) : fallbackFile(i),
      }));
    if (panels.length) return { concept: String(raw?.concept ?? ''), panels };
  } catch {
    // 落到兜底
  }
  // 兜底：用素材轮流配空文案（极少触发）。
  const panels = manifest.slice(0, 6).map((m, i) => ({
    role: i === 0 ? '封面' : '配图',
    headline: '',
    asset: m.file,
  }));
  return { concept: '', panels };
}

/**
 * ⑨ 出图（合成模式）：艺术指导读成稿 + 人物素材清单设计 6 张分镜，
 * 再把真实人物素材 + 对话气泡 + 数据牌 + 漫画装饰合成成 PNG 落盘。
 */
export const imageRenderSkill: Skill<ImageSet> = {
  name: 'image.render',
  title: '⑨ 出图',
  async run(ctx) {
    const asset = ctx.bag['asset.assemble'] as FinalAsset | undefined;
    const risk = ctx.bag['risk.review'] as RiskReport | undefined;
    const title = asset?.titles?.[0] ?? risk?.rewritten?.title ?? '';
    const body = asset?.body ?? risk?.rewritten?.body ?? '';
    const manifest = loadManifest();
    if (manifest.length === 0) {
      ctx.emit('  未找到人物素材（assets/characters/doraemon/manifest.json），跳过出图');
      return { images: [] };
    }
    if (!body) {
      ctx.emit('  无成稿正文，跳过出图');
      return { images: [] };
    }
    const dir = imageDir(ctx.runId);
    await mkdir(dir, { recursive: true });

    const { concept, panels } = await designPanels(ctx.llm, title, body, manifest);
    ctx.emit(
      `  配图设计就绪：${panels.length} 张分镜${concept ? `（${concept.slice(0, 24)}）` : ''}`,
    );

    const images = await Promise.all(panels.map((p, i) => renderPanel(p, i, dir)));
    ctx.emit(`  出图完成：${images.filter((r) => r.ok).length}/${panels.length} 张已合成落盘`);
    return { concept, images };
  },
};
