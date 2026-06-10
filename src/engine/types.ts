import type { LlmClient } from '../llm/client.js';
import type { PersonaPack } from '../persona/persona-pack.js';
import type { HotspotSource } from '../sources/hotspot-source.js';

/** ① 热点 */
export interface Hotspot {
  id: string;
  title: string;
  heat: number;
  source: string;
  keywords: string[];
  summary?: string;
}

/** ①.5 精选推荐：结合人设从海量热搜里挑出的高匹配爆款（带推荐理由与切入角度）。 */
export interface RecommendedHotspot {
  title: string;
  source: string;
  heat: number;
  reason: string;
  angle: string;
}

/** ② 选题 */
export interface Topic {
  id: string;
  title: string;
  angle: string;
  rationale: string;
}

/** ③ 初稿 / 终稿 */
export interface Draft {
  title: string;
  body: string;
}

/** ③ 单轮打磨记录 */
export interface RefineRound {
  round: number;
  scores: Record<string, number>;
  total: number;
  critique: string;
}

/** ③ 打磨结果 */
export interface RefineResult {
  final: Draft;
  rounds: RefineRound[];
}

/** ④ 风控命中项 */
export interface RiskHit {
  category: string;
  term: string;
  severity: 'low' | 'mid' | 'high';
}

/** ④ 风控报告 */
export interface RiskReport {
  hits: RiskHit[];
  level: 'pass' | 'low' | 'mid' | 'high';
  rewritten: Draft;
}

/** ⑤ 最终作品包 */
export interface FinalAsset {
  titles: string[];
  body: string;
  imagePrompts: string[];
  publishTips: string;
}

/** Skill 运行时上下文 */
export interface SkillContext {
  runId: string;
  llm: LlmClient;
  persona: PersonaPack;
  sources: { hotspot: HotspotSource };
  bag: Record<string, unknown>;
  emit: (msg: string) => void;
  signal: AbortSignal;
}

/** 一个 Skill 干一件事、产一个产物、可独立测试。 */
export interface Skill<O = unknown> {
  name: string;
  title: string;
  run(ctx: SkillContext): Promise<O>;
}

/** 流水线阶段。gateAfter 定义人工卡点；haltOn 命中则中止后续阶段。 */
export interface Stage {
  skillName: string;
  gateAfter?: {
    question: string;
    options: string[] | ((bag: Record<string, unknown>) => string[]);
    haltOn?: string[];
  };
}
