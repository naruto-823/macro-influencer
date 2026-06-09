import type { FinalAsset, RiskReport, Skill } from '../engine/types.js';

export const assetAssembleSkill: Skill<FinalAsset> = {
  name: 'asset.assemble',
  title: '⑤ 组装最终作品',
  async run(ctx) {
    const draft = (ctx.bag['risk.review'] as RiskReport).rewritten;
    const asset = await ctx.llm.completeJson<FinalAsset>({
      system: '你是小红书运营专家，负责把成稿打包成可直接发布的作品。',
      prompt: [
        '基于以下成稿，产出可直接发布的作品包：',
        `标题：${draft.title}`,
        `正文：\n${draft.body}`,
        '',
        '要求输出 JSON：',
        '{"titles":["3个标题候选"],"body":"最终正文(含话题标签)","imagePrompts":["每张配图的画面描述/分镜，3-6张"],"publishTips":"最佳发布时间与话题标签建议"}',
      ].join('\n'),
    });
    ctx.emit(`  作品就绪：${asset.titles.length} 个标题候选 / ${asset.imagePrompts.length} 张配图`);
    return asset;
  },
};
