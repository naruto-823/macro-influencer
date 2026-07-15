// 把长文成稿压成「小红书原生 caption」：钩子开头 + 3-5 个要点 + 互动引导，≤900 字，
// 再配 5-8 个精准话题标签。长内容由配图承载，正文只负责勾人点击 + 引导互动。
import type { LlmClient } from '../llm/client.js';
import { XHS_LIMITS, stripMarkdown } from './package.js';

export interface XhsCaption {
  body: string;
  tags: string[];
}

const CAPTION_BUDGET = 880; // 给标签留出 ~120 字预算（标签计入 1000 字总额）

/** 用 LLM 把成稿压成小红书 caption；失败时调用方应回退到按句裁剪。 */
export async function composeCaption(
  llm: LlmClient,
  input: { title: string; body: string; topic?: string },
): Promise<XhsCaption> {
  const raw = await llm.completeJson<XhsCaption>({
    schema: {
      type: 'object',
      properties: {
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['body', 'tags'],
    },
    system:
      '你是小红书爆款运营。把一篇长文成稿改写成小红书图文笔记的「正文文案」。长文细节由配图承载，正文只负责：① 一句强钩子开头勾人；② 3-5 个最有冲击力的要点（短句、可用 emoji 分点）；③ 结尾一句互动引导。口语、真诚、有网感，绝不堆砌。【硬性要求】禁止使用任何 markdown 标记：不要 **加粗**、不要 # 标题、不要反引号、不要 - 列表符号——小红书不渲染 markdown，符号会原样裸露。要强调就用 emoji 或【】把词括起来。',
    prompt: [
      `选题：${input.topic ?? input.title}`,
      `标题：${input.title}`,
      '长文成稿（仅供你提炼，不要整段照搬）：',
      input.body,
      '',
      `产出 JSON：{"body":"小红书正文文案，${CAPTION_BUDGET}字以内，不含话题标签","tags":["5-8个精准话题标签，纯词不带#"]}`,
    ].join('\n'),
  });

  let body = stripMarkdown((raw.body ?? '').trim()).trim();
  if ([...body].length > CAPTION_BUDGET) {
    body = [...body].slice(0, CAPTION_BUDGET).join('');
  }
  const tags = (raw.tags ?? [])
    .map((t) => t.replace(/[#＃\s]/g, '').trim())
    .filter((t) => t && [...t].length <= 18)
    .slice(0, 8);

  // 安全网：caption 异常空时让调用方回退（抛错由 CLI 兜底）
  if (!body) throw new Error('composeCaption 返回空正文');
  // 再保险：caption + 标签整体不超 1000 字
  const tagLen = tags.map((t) => `#${t}`).join(' ').length;
  if ([...body].length + tagLen + 2 > XHS_LIMITS.BODY_MAX) {
    body = [...body].slice(0, XHS_LIMITS.BODY_MAX - tagLen - 2).join('');
  }
  return { body, tags };
}
