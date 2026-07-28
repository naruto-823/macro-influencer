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

/** ② 深度调研档案：基于选定热点联网查证的真实资料，作为初稿的事实底料。 */
export interface DeepResearch {
  /** 调研所围绕的选题 */
  topic: string;
  /** 联网调研产出的完整档案（markdown 纯文本：背景/始末/关键事实/时间线/争议/对普通人的意义） */
  report: string;
  /** 档案中引用到的真实资料链接 */
  sources: string[];
  /** 是否真·联网查证（claude -p 走 web）；false 表示退回模型知识（无实时检索） */
  online: boolean;
}

/** ③ 结构大纲（搭框架，不含正文）。框架先行：先把骨架定死，再写正文。 */
export interface Outline {
  /** 开头钩子策略（用悬念/故事/数据/反差里的哪种、具体怎么开） */
  hookStrategy: string;
  /** 核心立场/判断（敢下判断，不骑墙） */
  thesis: string;
  /** 段落骨架：每段标题 + 要写的要点（要点尽量取自调研档案的真实事实） */
  sections: Array<{ heading: string; points: string[] }>;
  /** 预设金句落点 */
  goldenLines: string[];
  /** 结尾收法（升华/金句 + 互动引导） */
  ending: string;
}

/** ④ 初稿 / 终稿 */
export interface Draft {
  title: string;
  body: string;
}

/** ⑤ 单轮精修记录：一轮只攻一个维度，记录裁判评分与结构化改动清单。 */
export interface RefineRound {
  round: number;
  /** 本轮聚焦的维度（信息密度 / 论证逻辑 / 钩子节奏 / 去AI味精炼） */
  dimension: string;
  /** 裁判给该维度的得分（0-100） */
  total: number;
  /** 裁判点出的具体硬伤 */
  critique: string;
  /** 本轮实际改动清单（改了什么 + 为什么），即可见 changelog */
  changes: string[];
  /** 是否采纳了改写（达标跳过则为 false） */
  applied: boolean;
}

/** ⑤ 精修结果 */
export interface RefineResult {
  final: Draft;
  rounds: RefineRound[];
}

/** ⑥ 单条事实核查项 */
export interface FactClaim {
  /** 文中的一条事实/数字/引语 */
  claim: string;
  /** 置信：green=有档案/权威源支撑，yellow=单源待确认，red=查无实据需人工 */
  confidence: 'green' | 'yellow' | 'red';
  /** 支撑依据（来源链接或档案中的对应事实）；red 时写明缺口 */
  basis: string;
}

/** ⑥ 事实核查报告（独立核查；非绿项由后续风控自动净化） */
export interface FactCheckReport {
  claims: FactClaim[];
  redCount: number;
  summary: string;
}

/** ⑦ 风控命中项 */
export interface RiskHit {
  category: string;
  term: string;
  severity: 'low' | 'mid' | 'high';
}

/** ⑦ 合规改写对照（看得见改了什么） */
export interface RiskFix {
  from: string;
  to: string;
  rule: string;
}

/** ⑦ 风控报告 */
export interface RiskReport {
  hits: RiskHit[];
  level: 'pass' | 'low' | 'mid' | 'high';
  /** 合规改写对照清单（可见 diff） */
  fixes: RiskFix[];
  rewritten: Draft;
}

/** ⑧ 最终作品包 */
export interface FinalAsset {
  titles: string[];
  /** 完整定稿，按 Unicode 字符计不少于 1500 字。 */
  body: string;
  /** 用于阶段性展示/平台预览的精简版，按 Unicode 字符计不超过 950 字。 */
  stagedBody: string;
  imagePrompts: string[];
  publishTips: string;
}

/** ⑨ 单张配图的设计稿（艺术指导产出，内容驱动）。 */
export interface ImagePanel {
  /** 角色：封面 / 数据 / 对比 / 场景 / 金句 / 结尾 等 */
  role: string;
  /** 图上最大的主文案（从正文提炼，<=12 字、1-2 行） */
  headline: string;
  /** 辅助小字（可空） */
  sub?: string;
  /** 要突出的具体数据（可空） */
  data?: string;
  /** 主文案里要高亮的关键词/数字（合成时用亮色突出） */
  emphasis?: string;
  /** 选中的人物素材文件名（合成模式用）；旧数据可能没有 */
  asset?: string;
  /** 画面要画什么（旧的 SVG 模式用）；合成模式可空 */
  visual?: string;
}

/** ⑨ 单张配图渲染结果 */
export interface RenderedImage {
  index: number;
  /** 该图的设计稿（供展示与单张重试复用） */
  panel: ImagePanel;
  /** 相对 runs/<runId>/ 的文件名（如 '01.png'）；失败为 null */
  file: string | null;
  ok: boolean;
  error?: string;
}

/** ⑨ 出图产物：先做艺术指导设计一套图集，再逐张 claude -p 出 SVG、渲染成 PNG 落盘。 */
export interface ImageSet {
  /** 整套图集的视觉主线/概念 */
  concept?: string;
  images: RenderedImage[];
}

/** Skill 运行时上下文 */
export interface SkillContext {
  runId: string;
  /** 主力写手模型（默认本机 claude -p，长文强） */
  llm: LlmClient;
  /** 评审/裁判模型（默认 fox 的另一模型，换模型评审破「自我偏爱」偏差）；缺省退回 llm */
  judge: LlmClient;
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
  /** 该阶段单独的超时（毫秒）；缺省用引擎全局 skillTimeoutMs。慢节点（联网调研/多轮精修）可放宽。 */
  timeoutMs?: number;
  gateAfter?: {
    question: string;
    options: string[] | ((bag: Record<string, unknown>) => string[]);
    haltOn?: string[];
  };
}
