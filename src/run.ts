import { SkillRegistry } from './engine/registry.js';
import type { SkillContext, Stage, Topic } from './engine/types.js';
import type { EngineConfig } from './engine/workflow.js';
import { WorkflowEngine } from './engine/workflow.js';
import type { LlmClient } from './llm/client.js';
import type { PersonaPack } from './persona/persona-pack.js';
import { assetAssembleSkill } from './skills/asset-assemble.js';
import { contentDraftSkill } from './skills/content-draft.js';
import { contentOutlineSkill } from './skills/content-outline.js';
import { contentRefineSkill } from './skills/content-refine.js';
import { deepSearchSkill } from './skills/deep-search.js';
import { factCheckSkill } from './skills/fact-check.js';
import { hotspotFetchSkill } from './skills/hotspot-fetch.js';
import { hotspotRecommendSkill } from './skills/hotspot-recommend.js';
import { imageRenderSkill } from './skills/image-render.js';
import { riskReviewSkill } from './skills/risk-review.js';
import { topicGenerateSkill } from './skills/topic-generate.js';
import type { HotspotSource } from './sources/hotspot-source.js';

export function buildRegistry(): SkillRegistry {
  const reg = new SkillRegistry();
  for (const s of [
    hotspotFetchSkill,
    hotspotRecommendSkill,
    topicGenerateSkill,
    deepSearchSkill,
    contentOutlineSkill,
    contentDraftSkill,
    contentRefineSkill,
    factCheckSkill,
    riskReviewSkill,
    assetAssembleSkill,
    imageRenderSkill,
  ]) {
    reg.register(s);
  }
  return reg;
}

/** 选题卡点的选项 = 实际产出的选题 id；兜底防空。 */
function topicGateOptions(bag: Record<string, unknown>): string[] {
  const topics = (bag['topic.generate'] as Topic[]) ?? [];
  return topics.length > 0 ? topics.map((t) => t.id) : ['t1'];
}

export const STAGES: Stage[] = [
  { skillName: 'hotspot.fetch' },
  { skillName: 'hotspot.recommend' },
  {
    skillName: 'topic.generate',
    gateAfter: { question: '选择一个选题（输入 id）', options: topicGateOptions },
  },
  // 内部联网调用最多 15 分钟；外层多留 5 分钟供降级整理与结果落盘。
  { skillName: 'deep.search', timeoutMs: 1_200_000 },
  { skillName: 'content.outline' },
  { skillName: 'content.draft' },
  // 多轮精修（每维度：fox 裁判 + claude-p 整篇改写，后者偶尔回退 fox），给足时间。
  { skillName: 'content.refine', timeoutMs: 1_500_000 },
  // 事实核查发现的🔴/🟡项不再交给用户手工放行；下一步风控会自动删除、
  // 弱化或加限定语。修复后的全文仍会在风控卡点展示，供最终确认。
  { skillName: 'fact.check' },
  {
    skillName: 'risk.review',
    gateAfter: { question: '风控结果是否通过？', options: ['通过', '打回'], haltOn: ['打回'] },
  },
  { skillName: 'asset.assemble' },
  // 出图：每张分镜 claude -p 出 SVG 再渲染，较慢，给足 12 分钟。
  { skillName: 'image.render', timeoutMs: 720_000 },
];

export interface RunDeps {
  llm: LlmClient;
  /** 评审模型（精修循环/事实核查当裁判）；缺省退回 llm。 */
  judge?: LlmClient;
  persona: PersonaPack;
  hotspot: HotspotSource;
  engineCfg: EngineConfig;
}

/** 跑一次完整流水线，返回最终 bag。 */
export async function runPipeline(runId: string, deps: RunDeps): Promise<Record<string, unknown>> {
  const engine = new WorkflowEngine(buildRegistry(), deps.engineCfg);
  const ctxBase: Omit<SkillContext, 'bag'> = {
    runId,
    llm: deps.llm,
    judge: deps.judge ?? deps.llm,
    persona: deps.persona,
    sources: { hotspot: deps.hotspot },
    emit: (m) => console.log(m),
    signal: new AbortController().signal,
  };
  return engine.run(runId, STAGES, ctxBase);
}
