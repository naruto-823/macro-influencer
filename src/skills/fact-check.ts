import type {
  DeepResearch,
  FactCheckReport,
  FactClaim,
  RefineResult,
  Skill,
} from '../engine/types.js';

interface RawFactCheck {
  claims: Array<{ claim?: string; confidence?: string; basis?: string }>;
  summary?: string;
}

const COLORS = new Set(['green', 'yellow', 'red']);

/**
 * ⑥ 事实核查：独立节点（新闻业铁律——核查不能既当运动员又当裁判）。
 * 用换模型的裁判，把成稿里每条事实/数字/引语对着 ② 的调研档案逐条核，三色置信标注。
 * 只标记、不改写；🔴存疑项交人工卡点定夺。
 */
export const factCheckSkill: Skill<FactCheckReport> = {
  name: 'fact.check',
  title: '⑥ 事实核查',
  async run(ctx) {
    const draft = (ctx.bag['content.refine'] as RefineResult).final;
    const research = ctx.bag['deep.search'] as DeepResearch | undefined;
    const dossier = research?.report ?? '（无调研档案，仅凭常识与公开认知判断）';

    const raw = await ctx.judge.completeJson<RawFactCheck>({
      schema: {
        type: 'object',
        properties: {
          claims: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                claim: { type: 'string' },
                confidence: { type: 'string', enum: ['green', 'yellow', 'red'] },
                basis: { type: 'string' },
              },
              required: ['claim', 'confidence', 'basis'],
            },
          },
          summary: { type: 'string' },
        },
        required: ['claims', 'summary'],
      },
      system:
        '你是独立的事实核查员。你不写稿、不润色，只核对。把稿子里每一条可证伪的事实、数字、时间、人名、引语都揪出来，对照给你的调研档案逐条核实。严禁放水：拿不准就标黄，查无实据或与档案矛盾就标红。',
      prompt: [
        '【调研档案（这是已联网查证过的事实基准，以它为准）】：',
        dossier,
        '',
        '【待核查的成稿】：',
        `标题：${draft.title}`,
        `正文：\n${draft.body}`,
        '',
        '请逐条核查，输出 JSON：',
        '{"claims":[{"claim":"文中的一条事实/数字/引语","confidence":"green|yellow|red","basis":"green=档案/权威源支撑(注明依据或链接)；yellow=单源或档案未覆盖、待人工确认；red=与档案矛盾或查无实据，写明缺口"}],"summary":"一句话总评：整体可信度如何、最该人工复核哪几条"}',
        '只核查事实层，不评价文采。观点/判断不算事实，不要列。',
      ].join('\n'),
    });

    const claims: FactClaim[] = (Array.isArray(raw?.claims) ? raw.claims : [])
      .filter((c) => c?.claim)
      .map((c) => ({
        claim: String(c.claim),
        confidence: (COLORS.has(String(c.confidence))
          ? c.confidence
          : 'yellow') as FactClaim['confidence'],
        basis: String(c.basis ?? ''),
      }));
    const redCount = claims.filter((c) => c.confidence === 'red').length;
    const yellowCount = claims.filter((c) => c.confidence === 'yellow').length;
    ctx.emit(`  核查 ${claims.length} 条事实：🔴${redCount} 存疑 / 🟡${yellowCount} 待确认`);
    return { claims, redCount, summary: String(raw?.summary ?? '') };
  },
};
