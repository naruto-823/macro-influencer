// ⑩ 发布打包：把成稿作品（标题/正文/配图）适配成小红书图文笔记可直接发布的字段。
// 小红书图文硬约束：标题 ≤20 字、正文（含话题标签）≤1000 字、最多 18 张图。
// 长文公众号体裁塞不进 1000 字正文，所以正文走「caption（钩子+要点+引导）+ 话题标签」，
// 长内容由配图承载；caption 可由 LLM 现压（见 caption.ts），缺省退化为按句裁剪兜底。
import type { FinalAsset } from '../engine/types.js';

/** 小红书图文笔记硬约束。 */
export const XHS_LIMITS = {
  /** 标题最大字符数 */
  TITLE_MAX: 20,
  /** 正文（含话题标签）最大字符数 */
  BODY_MAX: 1000,
  /** 单篇最多配图 */
  IMAGES_MAX: 18,
} as const;

/** 一篇可直接投递到小红书创作平台的图文笔记。 */
export interface PublishPackage {
  /** 来源 run，便于追溯 */
  sourceRunId: string;
  /** 实际投递的标题（已裁到 ≤20 字） */
  title: string;
  /** 其余可选标题（供人工 A/B 挑选） */
  titleAlternatives: string[];
  /** 正文 caption（不含话题标签） */
  body: string;
  /** 话题标签（不带 # 前缀，纯词） */
  tags: string[];
  /** 配图绝对路径，封面在前，已截到 ≤18 张 */
  images: string[];
  /** 发布建议原文（最佳时间等，仅供人工参考） */
  publishTips: string;
}

/**
 * 剥离 markdown 标记：小红书正文不渲染 markdown，`**加粗**`/`#标题`/反引号会原样裸露。
 * 强调改用 emoji/【】。安全网——即使提示模型别用，偶尔仍会带，必须代码兜底。
 */
export function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(\S(?:[^*]*\S)?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '');
}

/** 把标题裁到 ≤20 字：超长时砍到最后一个标点边界、再不行硬截。 */
export function trimTitle(raw: string, max = XHS_LIMITS.TITLE_MAX): string {
  const t = raw.trim().replace(/\s+/g, ' ');
  if ([...t].length <= max) return t;
  const chars = [...t];
  // 在 max 以内找最后一个标点，从那里断开更自然
  const head = chars.slice(0, max).join('');
  const m = head.match(/^(.*[：:，,。.！!？?、])[^：:，,。.！!？?、]*$/);
  if (m?.[1] && [...m[1]].length >= Math.floor(max * 0.6)) {
    return [...m[1]]
      .slice(0, max)
      .join('')
      .replace(/[：:，,、]$/, '');
  }
  return head;
}

/** 从「发布建议」自由文本里抽话题标签：先抓 #xxx，没有再抓"标签：a、b"式列举。 */
export function extractTags(publishTips: string): string[] {
  const tags = new Set<string>();
  // #话题# 或 #话题（空格/换行/#结束）
  for (const m of publishTips.matchAll(/#([^#\s，,。.\n]{1,18})#?/g)) {
    const t = m[1]?.trim();
    if (t) tags.add(t);
  }
  if (tags.size === 0) {
    // 兜底：从"标签/话题"行里按顿号/逗号切
    const line = publishTips.match(/(?:标签|话题)[：:]\s*([^\n]+)/);
    if (line?.[1]) {
      for (const part of line[1].split(/[、，,\s]+/)) {
        const t = part.replace(/[#＃]/g, '').trim();
        if (t && [...t].length <= 18) tags.add(t);
      }
    }
  }
  return [...tags].slice(0, 10);
}

/** 按句子边界把正文裁到 maxChars 以内（保留完整句，结尾不留半句）。 */
export function trimBodyToSentence(body: string, maxChars: number): string {
  const text = body.trim();
  if ([...text].length <= maxChars) return text;
  const chars = [...text];
  const head = chars.slice(0, maxChars).join('');
  // 最后一个句末标点处断开
  const idx = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('\n'),
  );
  if (idx > maxChars * 0.5) return head.slice(0, idx + 1).trim();
  return `${head.trim()}…`;
}

/** caption + 话题标签拼成的最终正文（标签放末尾，每个带 # 前缀）。 */
export function renderCaption(body: string, tags: string[]): string {
  const tagLine = tags.map((t) => `#${t}`).join(' ');
  return tagLine ? `${body.trim()}\n\n${tagLine}` : body.trim();
}

/** 组装发布包。caption 缺省时用成稿正文按句裁剪兜底，确保正文+标签 ≤1000 字。 */
export function assemblePackage(input: {
  asset: FinalAsset;
  images: string[];
  sourceRunId: string;
  /** 预先压好的 caption（LLM 产）；不传则用 asset.body 按句裁剪 */
  caption?: { body: string; tags: string[] };
}): PublishPackage {
  const { asset, images, sourceRunId } = input;
  const titles = asset.titles?.length ? asset.titles : [''];
  const title = trimTitle(stripMarkdown(titles[0] ?? ''));

  const tags = input.caption?.tags ?? extractTags(asset.publishTips ?? '');
  // 标签占位长度（含 # 前缀、空格、两段换行），正文要给它们让出预算
  const tagLine = tags.map((t) => `#${t}`).join(' ');
  const reserve = tagLine ? [...tagLine].length + 2 : 0;
  const bodyBudget = XHS_LIMITS.BODY_MAX - reserve;
  // 兜底剥 markdown：caption 路径已剥，--no-llm 走成稿原文这里再保险一次
  const rawBody = stripMarkdown(input.caption?.body ?? asset.body ?? '');
  const body = trimBodyToSentence(rawBody, bodyBudget);

  return {
    sourceRunId,
    title,
    titleAlternatives: titles
      .slice(1)
      .map((t) => t.trim())
      .filter(Boolean),
    body,
    tags,
    images: images.slice(0, XHS_LIMITS.IMAGES_MAX),
    publishTips: asset.publishTips ?? '',
  };
}
