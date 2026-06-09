import { SkillRegistry } from './engine/registry.js';
import type { SkillContext, Stage, Topic } from './engine/types.js';
import type { EngineConfig } from './engine/workflow.js';
import { WorkflowEngine } from './engine/workflow.js';
import type { LlmClient } from './llm/client.js';
import type { PersonaPack } from './persona/persona-pack.js';
import { assetAssembleSkill } from './skills/asset-assemble.js';
import { contentDraftSkill } from './skills/content-draft.js';
import { contentRefineSkill } from './skills/content-refine.js';
import { hotspotFetchSkill } from './skills/hotspot-fetch.js';
import { riskReviewSkill } from './skills/risk-review.js';
import { topicGenerateSkill } from './skills/topic-generate.js';
import type { HotspotSource } from './sources/hotspot-source.js';

export function buildRegistry(): SkillRegistry {
  const reg = new SkillRegistry();
  for (const s of [
    hotspotFetchSkill,
    topicGenerateSkill,
    contentDraftSkill,
    contentRefineSkill,
    riskReviewSkill,
    assetAssembleSkill,
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
  {
    skillName: 'topic.generate',
    gateAfter: { question: '选择一个选题（输入 id）', options: topicGateOptions },
  },
  { skillName: 'content.draft' },
  { skillName: 'content.refine' },
  {
    skillName: 'risk.review',
    gateAfter: { question: '风控结果是否通过？', options: ['通过', '打回'], haltOn: ['打回'] },
  },
  { skillName: 'asset.assemble' },
];

export interface RunDeps {
  llm: LlmClient;
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
    persona: deps.persona,
    sources: { hotspot: deps.hotspot },
    emit: (m) => console.log(m),
    signal: new AbortController().signal,
  };
  return engine.run(runId, STAGES, ctxBase);
}
