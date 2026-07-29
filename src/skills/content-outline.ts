import type { DeepResearch, Outline, Skill, Topic } from '../engine/types.js';

type RawOutline = Partial<Outline> & { outline?: unknown };

function parseJsonField(value: unknown, errorMessage: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(errorMessage);
  }
}

function toStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const strings = Object.values(value).filter((x): x is string => typeof x === 'string');
    return strings.length ? strings.join('：') : JSON.stringify(value);
  }
  return String(value ?? '');
}

function listFrom(value: unknown, field: string, allowPlainString = true): unknown[] {
  const candidate = parseJsonField(value, `模型返回的 ${field} 字段不是有效 JSON`);
  if (Array.isArray(candidate)) return candidate;
  if (candidate && typeof candidate === 'object') {
    return Object.values(candidate as Record<string, unknown>);
  }
  if (allowPlainString && typeof candidate === 'string') return [candidate];
  throw new Error(`模型返回的 ${field} 必须是数组`);
}

function normalizeOutline(raw: unknown): Outline {
  let candidate = parseJsonField(raw, '模型返回的大纲不是有效 JSON');
  if (
    candidate &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    (candidate as RawOutline).outline
  ) {
    candidate = (candidate as RawOutline).outline;
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('模型返回的大纲必须是对象');
  }

  const outline = candidate as RawOutline;
  const sections = listFrom(outline.sections, 'sections', false).map((section, index) => {
    if (typeof section === 'string') return { heading: section, points: [] };
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw new Error(`模型返回的第 ${index + 1} 个 section 格式错误`);
    }
    const record = section as Record<string, unknown>;
    return {
      heading: toStr(record.heading),
      points: listFrom(record.points ?? [], `sections[${index + 1}].points`).map(toStr),
    };
  });
  if (sections.length === 0) throw new Error('模型返回的 sections 不能为空');

  return {
    hookStrategy: toStr(outline.hookStrategy),
    thesis: toStr(outline.thesis),
    sections,
    goldenLines: listFrom(outline.goldenLines ?? [], 'goldenLines').map(toStr),
    ending: toStr(outline.ending),
  };
}

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
      ? `\n\n【${research.online ? '联网查证档案' : '有限证据档案（未联网，仅可使用有来源限定的内容）'}】：\n${research.report}`
      : '';

    const raw = await ctx.llm.completeJson<Outline>({
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

    const outline = normalizeOutline(raw);

    ctx.emit(
      `  框架就绪：${outline.sections.length} 段骨架 / ${outline.goldenLines.length} 个金句落点`,
    );
    return outline;
  },
};
