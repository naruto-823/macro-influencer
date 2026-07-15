import type { DeepResearch, Outline, Skill, Topic } from '../engine/types.js';

/**
 * ③ 搭框架：框架先行（行业 SOP：选题定了先写大纲再动笔）。
 * 只定骨架——钩子策略 / 核心立场 / 段落结构 / 金句落点 / 结尾收法，不写正文。
 */
export const contentOutlineSkill: Skill<Outline> = {
  name: 'content.outline',
  title: '③ 搭框架',
  async run(ctx) {
    const topics = (ctx.bag['topic.generate'] as Topic[]) ?? [];
    const choiceId = ctx.bag['gate.topic.generate'] as string | undefined;
    const topic = topics.find((t) => t.id === choiceId) ?? topics[0];
    if (!topic) throw new Error('content.outline: 没有可用选题');

    const research = ctx.bag['deep.search'] as DeepResearch | undefined;
    const researchBlock = research?.report
      ? `\n\n【深度调研档案（真实事实，骨架要点尽量取材于此）】：\n${research.report}`
      : '';

    const outline = await ctx.llm.completeJson<Outline>({
      schema: {
        type: 'object',
        properties: {
          hookStrategy: { type: 'string' },
          thesis: { type: 'string' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string' },
                points: { type: 'array', items: { type: 'string' } },
              },
              required: ['heading', 'points'],
            },
          },
          goldenLines: { type: 'array', items: { type: 'string' } },
          ending: { type: 'string' },
        },
        required: ['hookStrategy', 'thesis', 'sections', 'goldenLines', 'ending'],
      },
      system:
        '你是顶级内容架构师。动笔前先搭骨架——这是爆文 SOP 的第一铁律。你只产出结构大纲，绝不写正文段落。骨架要让文章「立得住、说得通、有钩子、有判断」。',
      prompt: [
        `账号定位：${ctx.persona.positioning}`,
        `内容风格：${ctx.persona.styleGuide}`,
        `本次选题：${topic.title}`,
        `切入角度：${topic.angle}`,
        researchBlock,
        '',
        '请为这篇深度解读/锐评搭一份结构大纲，产出 JSON：',
        '- hookStrategy：开头钩子策略。从「悬念 / 故事 / 数据 / 反差结论」里选最合适的一种，写清第一段具体怎么开（要在前 3 行抓住人）。',
        '- thesis：核心立场与判断。一句话讲清你这篇要下的判断、要推翻的常识——敢站队，别骑墙。',
        '- sections：3-6 个段落的骨架，每段给 heading（这段干什么）+ points（要写的要点，要点尽量挂上调研档案里的真实事实/数据/细节）。整体要有「还原→解读→升华」的递进，论证主线清晰、过渡顺滑。',
        '- goldenLines：3-5 个预设的金句落点（点明在哪个段落、大概什么意思，正文里再展开）。',
        '- ending：结尾收法（升华或金句 + 一句互动引导）。',
        '',
        '只输出大纲，不要写成段落正文。',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    // 归一：模型偶尔把金句/要点返回成对象（如 {段落,金句}），统一压成字符串，避免下游与 UI 出现 [object Object]。
    const toStr = (v: unknown): string => {
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object') {
        const ss = Object.values(v).filter((x): x is string => typeof x === 'string');
        return ss.length ? ss.join('：') : JSON.stringify(v);
      }
      return String(v ?? '');
    };
    outline.goldenLines = (outline.goldenLines ?? []).map(toStr);
    outline.sections = (outline.sections ?? []).map((s) => ({
      heading: toStr(s?.heading),
      points: (s?.points ?? []).map(toStr),
    }));

    ctx.emit(
      `  框架就绪：${outline.sections.length} 段骨架 / ${outline.goldenLines.length} 个金句落点`,
    );
    return outline;
  },
};
