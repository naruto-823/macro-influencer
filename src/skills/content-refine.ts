import type { DeepResearch, Draft, RefineResult, RefineRound, Skill } from '../engine/types.js';
import { MIN_FINAL_BODY_CHARS, charCount } from './content-draft.js';

/** 一轮裁判的结构化输出。 */
interface JudgeVerdict {
  score: number;
  defects: string[];
}
/**
 * 精修维度队列：一轮只攻一个维度（其余冻结），从「内容」到「形态」逐层下降。
 * 顺序有讲究：先把信息和逻辑做厚，再调钩子节奏，最后去 AI 味——避免来回返工。
 */
const DIMENSIONS = [
  {
    key: '信息密度',
    judge:
      '只评「信息密度」：有没有把抽象观点落到具体事实/数据/案例/专有名词/反常识细节上？是不是在说正确的废话、泛泛而谈、缺乏信息增量？',
    optimize:
      '只提升信息密度：在不灌水、不显著加长的前提下，给空泛的断言补上具体的事实/数字/案例/细节——但【只能用下方调研档案里明确写到的真实数据】，绝不许自己杜撰评分、播放量、销量、百分比、日期、引语等可被核查的硬数据。档案里没有的就用定性说法或不补，宁缺毋假。同时把原文里那些档案不支持的具体数字，改成定性说法或删掉。其余维度不要动。',
  },
  {
    key: '论证与逻辑',
    judge:
      '只评「论证与逻辑」：有没有用个例/孤证伪装成普遍规律？有没有逻辑断点、以偏概全？建议是否片面危险（只讲爽不讲代价）？有没有偷换概念？',
    optimize:
      '只修论证与逻辑：把个例补上更普遍的支撑或诚实标注「这是个例」；接上逻辑断点、讲到结构性根因而非阴谋论；给片面/危险的建议补上代价与更稳的替代；删掉偷换概念的极端结论。保留钩子和金句。其余维度不要动。',
  },
  {
    key: '钩子与节奏',
    judge:
      '只评「钩子与节奏」：开头前 3 行抓不抓人？段落节奏会不会拖沓（大段平铺、缺小反转/小提问）？情绪有没有递进？金句够不够、结尾收没收住？',
    optimize:
      '只调钩子与节奏：强化开头钩子（前 3 行就要勾住），打散拖沓段落、每隔一段埋个小钩子/金句/提问，让情绪层层递进，结尾收在有力金句+互动引导。不要改动事实与论点。其余维度不要动。',
  },
  {
    key: '去AI味与精炼',
    judge:
      '只评「去 AI 味与精炼」：有没有机械过渡词（首先/其次/然而/总之）、空泛套话（"在这个XX的时代""不仅…而且""让我们"）、堆成语、每段同一种句式、工整到假？有没有冗余啰嗦？',
    optimize:
      '只去 AI 味与精炼：删掉机械过渡词、空泛套话、堆砌成语和工整假句；长短句交错，像真人随口把事讲透；砍掉冗余啰嗦，但保留真正打动人的句子。不要改动事实与论点。其余维度不要动。',
  },
];

/**
 * ⑤ 精修循环：Evaluator-Optimizer 范式。每轮只攻一个维度，
 * 裁判（换模型 ctx.judge）按该维度 rubric 打分并点出具体硬伤，达标则跳过；
 * 未达标时写手（ctx.llm）只改这一维、产出结构化改动清单（可见 changelog）。
 */
export const contentRefineSkill: Skill<RefineResult> = {
  name: 'content.refine',
  title: '⑤ 精修循环',
  async run(ctx) {
    const threshold = ctx.persona.refineThreshold ?? 85;
    const maxDims = ctx.persona.maxRefineRounds ?? DIMENSIONS.length;
    const dims = DIMENSIONS.slice(0, maxDims);
    let current = ctx.bag['content.draft'] as Draft;
    const research = ctx.bag['deep.search'] as DeepResearch | undefined;
    const rounds: RefineRound[] = [];

    for (let i = 0; i < dims.length; i++) {
      const dim = dims[i];
      if (!dim) continue;

      // 1) 评估：换模型当裁判，只看这一个维度，给分 + 点出具体硬伤。
      const verdict = await ctx.judge.completeJson<JudgeVerdict>({
        schema: {
          type: 'object',
          properties: {
            score: { type: 'number' },
            defects: { type: 'array', items: { type: 'string' } },
          },
          required: ['score', 'defects'],
        },
        system:
          '你是一位极其严苛的资深主编兼毒舌书评人。你只做评审、不改稿。每条硬伤都要具体点到句子，别泛泛而谈。',
        prompt: [
          `账号风格：${ctx.persona.styleGuide}`,
          `本轮只评这一个维度：${dim.judge}`,
          '',
          `标题：${current.title}`,
          `正文：\n${current.body}`,
          '',
          '输出 JSON：{"score":0,"defects":["具体到句子的硬伤，没有就空数组"]}。score 为该维度 0-100 分。',
        ].join('\n'),
      });
      const score = Number(verdict.score) || 0;
      const defects = Array.isArray(verdict.defects) ? verdict.defects.filter(Boolean) : [];
      ctx.emit(`  【${dim.key}】裁判评分 ${score}`);

      // 2) 达标即跳过（measurable gate：该维度已过线，不浪费一次改写）。
      // 只在「达标」时跳过。低分一律改——哪怕裁判没细列硬伤（fox 偶尔只给分不给 defects），
      // 也要按该维度标准全面提升，绝不因裁判嘴懒就漏掉一个不及格的维度。
      if (score >= threshold) {
        rounds.push({
          round: i + 1,
          dimension: dim.key,
          total: score,
          critique: defects.length ? defects.join('；') : '该维度已达标',
          changes: [],
          applied: false,
        });
        continue;
      }

      // 3) 修订：写手只改这一维。用【纯文本】整篇改写（避开长正文塞进 JSON 易空/易截断的坑），
      //    正文后跟一行 ===CHANGES=== 再列改动，解析出 changelog。
      const researchBlock =
        dim.key === '信息密度' && research?.report
          ? `\n\n【可取材的调研档案（真实资料，只能用这里有的事实，不准编造）】：\n${research.report}`
          : '';
      const raw = await ctx.llm.complete({
        system:
          '你是顶级写手，正在做定向精修。你这一轮只针对指定的单一维度动刀，其它维度一律保持原样。',
        prompt: [
          `账号风格：${ctx.persona.styleGuide}`,
          `本轮唯一任务：${dim.optimize}`,
          defects.length
            ? `裁判点出的硬伤（逐条修掉，别漏）：\n${defects.map((d, k) => `  ${k + 1}. ${d}`).join('\n')}`
            : `裁判判定本维度仅 ${score} 分、不及格但未细列问题。请按本维度标准把它系统性地提升到位。`,
          researchBlock,
          '',
          `当前标题：${current.title}`,
          `当前正文：\n${current.body}`,
          '',
          '请先输出【修订后的完整正文】（纯文本，从第一句正文开始，不要 JSON、不要 markdown、不要任何前后缀解释、不要重复标题）。',
          '正文必须是改完的整篇、确有实质改动、把上面每条硬伤都修掉；但只动本维度涉及的地方，其余保持原样。',
          `正文不得少于 ${MIN_FINAL_BODY_CHARS} 字，不能以“精炼”为由删成短稿。`,
          '正文写完后，另起一行写一行分隔符 ===CHANGES=== ，其后逐行列出你做了哪些改动（每行一条，对应上面的硬伤）。',
        ].join('\n'),
      });

      const sep = raw.indexOf('===CHANGES===');
      const newBody = (sep >= 0 ? raw.slice(0, sep) : raw).trim();
      const changes =
        sep >= 0
          ? raw
              .slice(sep + '===CHANGES==='.length)
              .split('\n')
              .map((s) => s.replace(/^[-*·•\d.、)\s]+/, '').trim())
              .filter(Boolean)
              .slice(0, 20)
          : [];
      // 采纳门槛：正文够长（防空/截断）且确有改动。标题不在精修范围，沿用原标题。
      const applied = charCount(newBody) >= MIN_FINAL_BODY_CHARS && newBody !== current.body.trim();
      if (applied) current = { title: current.title, body: newBody };
      rounds.push({
        round: i + 1,
        dimension: dim.key,
        total: score,
        critique: defects.join('；'),
        changes: applied ? changes : [],
        applied,
      });
      ctx.emit(
        `  【${dim.key}】${
          applied
            ? `已采纳改动 ${changes.length} 条（正文 ${current.body.length} 字）`
            : `改写未采纳（新 ${newBody.length} 字 / 原 ${current.body.trim().length} 字）`
        }`,
      );
    }

    return { final: current, rounds };
  },
};
