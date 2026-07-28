import type { FinalAsset, RiskReport, Skill } from '../engine/types.js';
import { trimBodyToSentence, trimTitle } from '../publish/package.js';
import { charCount, MIN_FINAL_BODY_CHARS } from './content-draft.js';

export const MAX_STAGED_BODY_CHARS = 950;

/** LLM 只产「发布周边」，不碰正文。 */
interface RawPackaging {
  titles: string[];
  stagedBody: string;
  imagePrompts: string[];
  publishTips: string;
}

export const assetAssembleSkill: Skill<FinalAsset> = {
  name: 'asset.assemble',
  title: '⑧ 标题与封面',
  async run(ctx) {
    // 正文用打磨/风控后的成稿原文，一字不改（不再让模型重写正文，避免改短改差）。
    const draft = (ctx.bag['risk.review'] as RiskReport).rewritten;

    const pkg = await ctx.llm.completeJson<RawPackaging>({
      schema: {
        type: 'object',
        properties: {
          titles: { type: 'array', items: { type: 'string' } },
          stagedBody: { type: 'string' },
          imagePrompts: { type: 'array', items: { type: 'string' } },
          publishTips: { type: 'string' },
        },
        required: ['titles', 'stagedBody', 'imagePrompts', 'publishTips'],
      },
      system: '你是小红书运营专家，负责把一篇已定稿的笔记打包成可直接发布的作品。不要改动正文。',
      prompt: [
        '下面是已经定稿的笔记（正文不要改）。请只产出「发布前要准备的周边」：',
        `当前标题：${draft.title}`,
        `正文（仅供你理解，不要改写、不要输出）：\n${draft.body}`,
        '',
        '产出 JSON：',
        `{"titles":["8-12个标题候选，每个不超过20字符；套爆款公式，可挑选A/B"],"stagedBody":"阶段版正文：保留核心观点、关键依据和行动建议，不超过${MAX_STAGED_BODY_CHARS}字符","imagePrompts":["配图分镜，每张一句画面描述/文案，3-6张，第一张是封面"],"publishTips":"最佳发布时间 + 话题标签建议"}`,
      ].join('\n'),
    });

    if (charCount(draft.body) < MIN_FINAL_BODY_CHARS) {
      throw new Error(
        `asset.assemble: 完整正文仅 ${charCount(draft.body)} 字，低于 ${MIN_FINAL_BODY_CHARS} 字，拒绝打包`,
      );
    }
    const titles = (pkg.titles?.length ? pkg.titles : [draft.title])
      .map((title) => trimTitle(title))
      .filter(Boolean);
    const asset: FinalAsset = {
      titles: titles.length ? titles : [trimTitle(draft.title)],
      body: draft.body, // 正文沿用成稿原文
      stagedBody: trimBodyToSentence(pkg.stagedBody || draft.body, MAX_STAGED_BODY_CHARS),
      imagePrompts: pkg.imagePrompts ?? [],
      publishTips: pkg.publishTips ?? '',
    };
    ctx.emit(
      `  作品就绪：${asset.titles.length} 个标题候选 / ${asset.imagePrompts.length} 张配图（正文沿用成稿）`,
    );
    return asset;
  },
};
