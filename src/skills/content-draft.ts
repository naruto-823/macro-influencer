import type { DeepResearch, Draft, Outline, Skill, Topic } from '../engine/types.js';

export const MIN_FINAL_BODY_CHARS = 1500;

export function charCount(text: string): number {
  return [...text].length;
}

export const contentDraftSkill: Skill<Draft> = {
  name: 'content.draft',
  title: '④ 写初稿',
  async run(ctx) {
    const topics = (ctx.bag['topic.generate'] as Topic[]) ?? [];
    const choiceId = ctx.bag['gate.topic.generate'] as string | undefined;
    const topic = topics.find((t) => t.id === choiceId) ?? topics[0];
    if (!topic) throw new Error('content.draft: 没有可用选题');

    const samples = ctx.persona.sampleNotes
      .map((n) => `【标题】${n.title}\n【正文】${n.body}`)
      .join('\n---\n');

    // 框架先行：严格按 ③ 搭框架 定下的骨架来写（有则用）。
    const outline = ctx.bag['content.outline'] as Outline | undefined;
    const outlineBlock = outline
      ? [
          '',
          '【必须严格遵循的结构大纲（③ 已搭好的骨架，按它来写，别另起炉灶）】：',
          `开头钩子策略：${outline.hookStrategy}`,
          `核心立场：${outline.thesis}`,
          '段落骨架：',
          ...(outline.sections ?? []).map(
            (s, i) => `  ${i + 1}. ${s.heading}：${(s.points ?? []).join('；')}`,
          ),
          `预设金句落点：${(outline.goldenLines ?? []).join(' / ')}`,
          `结尾收法：${outline.ending}`,
        ].join('\n')
      : '';

    // 深度调研档案（联网查证的真实资料）作为事实底料；缺省则照旧凭选题写。
    const research = ctx.bag['deep.search'] as DeepResearch | undefined;
    const researchBlock = research?.report
      ? [
          '',
          research.online
            ? '【深度调研档案 —— 这是针对本选题联网查证过的资料。务必只使用档案明确支持的事实，不要编造】：'
            : '【有限证据档案 —— 当前未联网。只能使用档案中明确来自原始热榜摘要的事件事实，且必须写明“据该热榜题干/摘要”；背景分析不能冒充事件事实，禁止声称检索过任何网站】：',
          research.report,
        ].join('\n')
      : '';

    const draft = await ctx.llm.completeJson<Draft>({
      schema: {
        type: 'object',
        properties: { title: { type: 'string' }, body: { type: 'string' } },
        required: ['title', 'body'],
      },
      system:
        '你是顶级小红书爆款写手。你写的不是说明文或技术博客，而是「沉浸式叙事长文」——像讲故事一样把读者拽进去，用具体场景、金句和情绪打动人。严格对标给你的历史爆款样本的水准与文风。',
      prompt: [
        `内容风格指南：${ctx.persona.styleGuide}`,
        '',
        '【这是必须对标的质量标杆样本，请把它的文风、叙事感、金句密度、具体细节学到位】：',
        samples,
        '',
        `本次选题：${topic.title}`,
        `切入角度：${topic.angle}`,
        outlineBlock,
        researchBlock,
        '',
        '要求（务必做到）：',
        '1. 开篇用一个具体场景/反常事实/思想实验制造钩子，别上来就讲道理。',
        '2. 通篇是有人味的叙事与论证，大量具体可感的细节和例子；多用反问、对"你"喊话；金句密集、敢下判断。',
        '3. 方法论/要点要揉进故事里讲，绝不干巴巴罗列 1.2.3.4。',
        '4. 禁止代码块、禁止 markdown 标题(#)、禁止技术文档式死板分点和说教注水。技术选题也要写成有钩子有共鸣的故事。',
        '5. 不要 AI 腔：别用机械过渡词（首先/其次/然而/总之），别用空泛套话（“在这个XX的时代”“不仅…而且”“让我们”），别堆成语，别每段同一种句式、工整到假。像真人随口把一件事讲透：长短句交错、有具体细节和真实例子、有态度有锋芒。',
        '6. 标题强钩子且不超过20个字符；结尾落在一句有力的金句 + 互动引导；正文结尾带 8 个左右话题标签。',
        `7. 【硬性字数】正文按中文字符（含标点、不含标题）计算不得少于 ${MIN_FINAL_BODY_CHARS} 字，建议写 1800-2200 字。必须充分展开事实背景、逻辑推演、普通人的机会、现实门槛与行动建议，禁止重复观点凑字数。`,
        '8. 【真实性铁律，违反即废稿】绝不许编造任何具体的评分、播放量、销量、百分比、金额、日期、排名、人名、引语——这类「可被核查的硬数据」只能用上面调研档案里明确写到的；档案里没有的，就用定性说法（如「口碑下滑」「争议很大」）或干脆不写，绝不为了显得可信而杜撰一个数字。宁可少给数据，也不能给假数据。',
        '',
        '输出 JSON：{"title":"标题","body":"正文"}。',
      ].join('\n'),
    });
    if (charCount(draft.body) < MIN_FINAL_BODY_CHARS) {
      throw new Error(
        `content.draft: 正文仅 ${charCount(draft.body)} 字，低于 ${MIN_FINAL_BODY_CHARS} 字硬性要求`,
      );
    }
    ctx.emit(`  初稿完成：${draft.title}`);
    return draft;
  },
};
