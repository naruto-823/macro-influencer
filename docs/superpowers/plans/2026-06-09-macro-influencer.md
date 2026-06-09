# 百万网红 Agent 实施计划（macro-influencer）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一条 CLI 流水线，根据账号人设与历史风格，从热点产出可发布的小红书图文作品（标题/正文/配图 prompt）。

**Architecture:** 借鉴 ug-agents 的「编排式领域」模式——`WorkflowEngine` 顺序跑 `Stage[]`，每个 Stage 是一个干一件事、产一个产物、可独立测的 `Skill`；Skill 间通过黑板 `bag` 传数据；关键节点设 `gateAfter` 人工卡点（CLI 下走终端交互）。数据来源用 Adapter 隔离（先 Mock）。单包工程，产物落盘 `runs/`。

**Tech Stack:** TypeScript (ES2022/ESNext, strict) · pnpm · vitest · biome · @anthropic-ai/sdk（Claude）

---

## 文件结构总览

```
macro-influencer/
├── package.json / tsconfig.json / biome.json / vitest.config.ts / .gitignore
├── src/
│   ├── engine/
│   │   ├── types.ts          # Skill / SkillContext / Stage / 全部领域类型
│   │   ├── registry.ts       # SkillRegistry
│   │   └── workflow.ts       # WorkflowEngine：跑 Stage[]、gate、halt、超时
│   ├── persona/
│   │   ├── persona-pack.ts    # PersonaPack 类型 + definePersona 校验
│   │   └── examples/demo.ts   # 示例人设
│   ├── llm/
│   │   ├── client.ts          # LlmClient 接口 + Claude 实现
│   │   └── fake.ts            # 测试用 FakeLlmClient
│   ├── sources/
│   │   └── hotspot-source.ts  # HotspotSource 接口 + MockHotspotSource
│   ├── skills/
│   │   ├── hotspot-fetch.ts
│   │   ├── topic-generate.ts
│   │   ├── content-draft.ts
│   │   ├── content-refine.ts
│   │   ├── risk-review.ts
│   │   └── asset-assemble.ts
│   ├── guardrails/
│   │   ├── sensitive-words.ts # 词库 + 检测
│   │   └── xhs-rules.ts       # 词表数据
│   ├── output/
│   │   └── persist.ts         # 产物落盘 runs/<id>/
│   ├── run.ts                 # 组装 stages + 跑一次完整 run
│   └── cli.ts                 # CLI 入口 + 终端 gate
├── personas/                  # 真实人设（gitignore）
└── runs/                      # 产物（gitignore）
```

每个 Skill 的 `run(ctx)` 从 `ctx.bag` 读输入、返回产物，引擎把返回值写回 `ctx.bag[skill.name]`。bag 约定键：`hotspots` / `topics` / `gate.topic.generate` / `draft` / `refine` / `risk` / `gate.risk.review` / `asset`。

---

## Task 1: 工程脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `.gitignore`

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "macro-influencer",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "百万网红 Agent — 人设驱动的小红书图文选题与成稿流水线",
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20.10.0", "pnpm": ">=9" },
  "bin": { "influencer": "./dist/cli.js" },
  "scripts": {
    "build": "tsc -b",
    "start": "tsx src/cli.ts",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.65.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "@types/node": "^20.16.5",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "verbatimModuleSyntax": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "coverage"]
}
```

- [ ] **Step 3: 写 biome.json（复用 ug-agents 约定：单引号、行宽100、空格缩进）**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignore": ["dist", "coverage", "node_modules", "personas", "runs"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "warn", "noConsoleLog": "off" },
      "style": { "useImportType": "error", "useExportType": "error", "noNonNullAssertion": "warn" },
      "correctness": { "noUnusedImports": "error", "noUnusedVariables": "error" }
    }
  },
  "javascript": {
    "formatter": { "quoteStyle": "single", "semicolons": "always", "trailingCommas": "all" }
  }
}
```

- [ ] **Step 4: 写 vitest.config.ts 与 .gitignore**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
```

`.gitignore`:
```
node_modules
dist
coverage
.env
personas
runs
*.tsbuildinfo
```

- [ ] **Step 5: 安装依赖并验证脚手架**

Run: `pnpm install && pnpm typecheck`
Expected: 安装成功；typecheck 通过（此时 src 为空，tsc 无报错）。

- [ ] **Step 6: 提交**

```bash
git init && git add -A && git commit -m "chore: scaffold macro-influencer project"
```

---

## Task 2: 核心类型 + PersonaPack

**Files:**
- Create: `src/engine/types.ts`
- Create: `src/persona/persona-pack.ts`
- Create: `src/persona/examples/demo.ts`
- Test: `src/persona/persona-pack.test.ts`

- [ ] **Step 1: 写 src/engine/types.ts（纯类型，无逻辑，无需测试）**

```ts
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
```

- [ ] **Step 2: 写失败测试 src/persona/persona-pack.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { definePersona } from './persona-pack.js';

describe('definePersona', () => {
  const base = {
    id: 'demo',
    displayName: '示例账号',
    positioning: '面向职场新人的效率工具分享',
    styleGuide: '亲切、口语化、多用 emoji、分点叙述',
    sampleNotes: [{ title: '一个标题', body: '一段正文' }],
  };

  it('填充默认阈值与轮数', () => {
    const p = definePersona(base);
    expect(p.refineThreshold).toBe(80);
    expect(p.maxRefineRounds).toBe(3);
  });

  it('保留显式传入的阈值', () => {
    const p = definePersona({ ...base, refineThreshold: 90, maxRefineRounds: 5 });
    expect(p.refineThreshold).toBe(90);
    expect(p.maxRefineRounds).toBe(5);
  });

  it('id 非 kebab-case 时报错', () => {
    expect(() => definePersona({ ...base, id: 'Demo Account' })).toThrow(/id/);
  });

  it('缺 positioning 时报错', () => {
    expect(() => definePersona({ ...base, positioning: '' })).toThrow(/positioning/);
  });

  it('sampleNotes 为空时报错', () => {
    expect(() => definePersona({ ...base, sampleNotes: [] })).toThrow(/sampleNotes/);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run src/persona/persona-pack.test.ts`
Expected: FAIL（`definePersona` 未定义 / 模块不存在）。

- [ ] **Step 4: 写实现 src/persona/persona-pack.ts**

```ts
/** 历史笔记样本 */
export interface SampleNote {
  title: string;
  body: string;
  metrics?: { likes?: number; collects?: number; comments?: number };
}

/** 声明式账号配置：加一个账号 = 写一份 PersonaPack。 */
export interface PersonaPack {
  /** 账号唯一标识，kebab-case */
  id: string;
  /** 账号展示名 */
  displayName: string;
  /** 人设定位：是谁、给谁看、提供什么价值 */
  positioning: string;
  /** 内容风格指南：语气、句式、emoji 习惯、结构偏好 */
  styleGuide: string;
  /** 历史爆款笔记样本 */
  sampleNotes: SampleNote[];
  /** 选题偏好方向 */
  topicPreferences?: string[];
  /** 内容禁区 */
  forbiddenZones?: string[];
  /** 打磨打分阈值（满分100），缺省 80 */
  refineThreshold?: number;
  /** 打磨最大轮数，缺省 3 */
  maxRefineRounds?: number;
}

export function definePersona(p: PersonaPack): Required<Pick<PersonaPack, 'refineThreshold' | 'maxRefineRounds'>> & PersonaPack {
  if (!p.id || !/^[a-z0-9-]+$/.test(p.id)) {
    throw new Error(`PersonaPack.id 非法: ${JSON.stringify(p.id)}（要求 kebab-case）`);
  }
  if (!p.displayName?.trim()) throw new Error(`PersonaPack(${p.id}).displayName 必填`);
  if (!p.positioning?.trim()) throw new Error(`PersonaPack(${p.id}).positioning 必填`);
  if (!p.styleGuide?.trim()) throw new Error(`PersonaPack(${p.id}).styleGuide 必填`);
  if (!p.sampleNotes?.length) throw new Error(`PersonaPack(${p.id}).sampleNotes 至少 1 条`);
  return {
    ...p,
    refineThreshold: p.refineThreshold ?? 80,
    maxRefineRounds: p.maxRefineRounds ?? 3,
  };
}
```

- [ ] **Step 5: 写示例人设 src/persona/examples/demo.ts**

```ts
import { definePersona } from '../persona-pack.js';

export const demoPersona = definePersona({
  id: 'demo',
  displayName: '小桃职场效率',
  positioning: '面向 22-30 岁职场新人，分享好用的效率工具与方法，帮他们少加班。',
  styleGuide: '第一人称、亲切口语化、每段不超过 3 行、适量 emoji、开头一句强钩子、结尾给行动建议与互动提问。',
  sampleNotes: [
    {
      title: '打工人必备！这个工具帮我每天省下2小时⏰',
      body: '刚入职那会儿我天天加班…直到同事甩给我这个工具📌\n用了一周，重复工作全自动化\n姐妹们冲！评论区告诉我你想看哪类工具～',
      metrics: { likes: 12000, collects: 8000, comments: 600 },
    },
  ],
  topicPreferences: ['效率工具', '职场避坑', '时间管理'],
  forbiddenZones: ['政治', '医疗功效', '金融荐股'],
});
```

- [ ] **Step 6: 运行测试确认通过并提交**

Run: `pnpm vitest run src/persona/persona-pack.test.ts && pnpm typecheck`
Expected: PASS（typecheck 可能因 llm/sources 尚未创建而报缺模块——本任务只需 persona 测试 PASS；types.ts 的导入将在后续任务补齐。若 typecheck 因缺模块失败属预期，待 Task 3/4 后再整体 typecheck）。

```bash
git add -A && git commit -m "feat: core types + PersonaPack with definePersona"
```

---

## Task 3: LLM 客户端（Claude）+ 测试假件

**Files:**
- Create: `src/llm/client.ts`
- Create: `src/llm/fake.ts`
- Test: `src/llm/fake.test.ts`

- [ ] **Step 1: 写失败测试 src/llm/fake.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { FakeLlmClient } from './fake.js';

describe('FakeLlmClient', () => {
  it('complete 按顺序吐预置回复', async () => {
    const llm = new FakeLlmClient(['一', '二']);
    expect(await llm.complete({ prompt: 'x' })).toBe('一');
    expect(await llm.complete({ prompt: 'y' })).toBe('二');
  });

  it('completeJson 解析 JSON 回复', async () => {
    const llm = new FakeLlmClient(['{"a":1}']);
    expect(await llm.completeJson<{ a: number }>({ prompt: 'x' })).toEqual({ a: 1 });
  });

  it('记录收到的 prompt', async () => {
    const llm = new FakeLlmClient(['ok']);
    await llm.complete({ system: 's', prompt: 'hello' });
    expect(llm.calls[0]?.prompt).toBe('hello');
    expect(llm.calls[0]?.system).toBe('s');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/llm/fake.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写接口 src/llm/client.ts**

```ts
import Anthropic from '@anthropic-ai/sdk';

export interface LlmCompleteOpts {
  system?: string;
  prompt: string;
}

export interface LlmClient {
  complete(opts: LlmCompleteOpts): Promise<string>;
  completeJson<T>(opts: LlmCompleteOpts): Promise<T>;
}

/** 从模型文本里抠出 JSON（兼容被 ```json 包裹的情况）。 */
export function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.search(/[[{]/);
  const slice = start >= 0 ? raw.slice(start) : raw;
  return JSON.parse(slice) as T;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';

export class ClaudeLlmClient implements LlmClient {
  private readonly client: Anthropic;
  constructor(
    private readonly model: string = DEFAULT_MODEL,
    apiKey: string = process.env.ANTHROPIC_API_KEY ?? '',
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(opts: LlmCompleteOpts): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: opts.system,
      messages: [{ role: 'user', content: opts.prompt }],
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  async completeJson<T>(opts: LlmCompleteOpts): Promise<T> {
    const text = await this.complete({
      ...opts,
      prompt: `${opts.prompt}\n\n只输出 JSON，不要任何解释或 markdown 代码块。`,
    });
    return parseJson<T>(text);
  }
}
```

- [ ] **Step 4: 写假件 src/llm/fake.ts**

```ts
import { type LlmClient, type LlmCompleteOpts, parseJson } from './client.js';

/** 测试用：按构造顺序吐预置回复，并记录所有调用。 */
export class FakeLlmClient implements LlmClient {
  readonly calls: LlmCompleteOpts[] = [];
  private i = 0;
  constructor(private readonly replies: string[]) {}

  async complete(opts: LlmCompleteOpts): Promise<string> {
    this.calls.push(opts);
    const r = this.replies[this.i++];
    if (r === undefined) throw new Error(`FakeLlmClient 回复用尽（第 ${this.i} 次调用）`);
    return r;
  }

  async completeJson<T>(opts: LlmCompleteOpts): Promise<T> {
    return parseJson<T>(await this.complete(opts));
  }
}
```

- [ ] **Step 5: 运行测试确认通过并提交**

Run: `pnpm vitest run src/llm/fake.test.ts`
Expected: PASS

```bash
git add -A && git commit -m "feat: Claude LlmClient + FakeLlmClient for tests"
```

---

## Task 4: 数据源适配器（HotspotSource + Mock）

**Files:**
- Create: `src/sources/hotspot-source.ts`
- Test: `src/sources/hotspot-source.test.ts`

- [ ] **Step 1: 写失败测试 src/sources/hotspot-source.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { MockHotspotSource } from './hotspot-source.js';

describe('MockHotspotSource', () => {
  it('返回内置热点，受 limit 限制', async () => {
    const src = new MockHotspotSource();
    const hits = await src.fetch({ limit: 2 });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.title).toBeTruthy();
    expect(hits[0]?.keywords.length).toBeGreaterThan(0);
  });

  it('按 keywords 过滤命中标题或关键词的热点', async () => {
    const src = new MockHotspotSource();
    const hits = await src.fetch({ keywords: ['效率'] });
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.every((h) => h.title.includes('效率') || h.keywords.some((k) => k.includes('效率'))),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/sources/hotspot-source.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现 src/sources/hotspot-source.ts**

```ts
import type { Hotspot } from '../engine/types.js';

export interface FetchOpts {
  keywords?: string[];
  limit?: number;
}

/** 热点来源适配器。本期 Mock；真源（爬虫/三方榜单 API）后续实现同一接口即可。 */
export interface HotspotSource {
  fetch(opts: FetchOpts): Promise<Hotspot[]>;
}

const SEED: Hotspot[] = [
  {
    id: 'h1',
    title: '年轻人开始用AI管理时间了',
    heat: 9800,
    source: 'mock-trending',
    keywords: ['效率', 'AI', '时间管理'],
    summary: '越来越多职场新人用 AI 工具规划日程、自动化重复工作。',
  },
  {
    id: 'h2',
    title: '通勤包里到底该装什么',
    heat: 7200,
    source: 'mock-trending',
    keywords: ['好物', '通勤', '职场'],
    summary: '通勤好物清单类内容持续走高。',
  },
  {
    id: 'h3',
    title: '副业搞钱的5个低成本方向',
    heat: 8600,
    source: 'mock-trending',
    keywords: ['副业', '搞钱', '效率'],
    summary: '低门槛副业方向引发讨论。',
  },
];

export class MockHotspotSource implements HotspotSource {
  constructor(private readonly seed: Hotspot[] = SEED) {}

  async fetch(opts: FetchOpts): Promise<Hotspot[]> {
    let list = this.seed;
    const kws = opts.keywords?.filter(Boolean) ?? [];
    if (kws.length > 0) {
      list = list.filter((h) =>
        kws.some((kw) => h.title.includes(kw) || h.keywords.some((k) => k.includes(kw))),
      );
    }
    return list.slice(0, opts.limit ?? list.length);
  }
}
```

- [ ] **Step 4: 运行测试确认通过，并整体 typecheck**

Run: `pnpm vitest run src/sources/hotspot-source.test.ts && pnpm typecheck`
Expected: 测试 PASS；typecheck 此时应通过（types/llm/persona/sources 已齐）。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: HotspotSource adapter + MockHotspotSource"
```

---

## Task 5: SkillRegistry + WorkflowEngine

**Files:**
- Create: `src/engine/registry.ts`
- Create: `src/engine/workflow.ts`
- Test: `src/engine/workflow.test.ts`

- [ ] **Step 1: 写 src/engine/registry.ts（简单，随引擎一起测）**

```ts
import type { Skill } from './types.js';

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  register(skill: Skill): void {
    if (this.skills.has(skill.name)) throw new Error(`skill already registered: ${skill.name}`);
    this.skills.set(skill.name, skill);
  }

  get(name: string): Skill {
    const s = this.skills.get(name);
    if (!s) throw new Error(`unknown skill: ${name}`);
    return s;
  }
}
```

- [ ] **Step 2: 写失败测试 src/engine/workflow.test.ts**

```ts
import { describe, expect, it, vi } from 'vitest';
import { SkillRegistry } from './registry.js';
import type { Skill, SkillContext, Stage } from './types.js';
import { WorkflowEngine } from './workflow.js';

function ctxBase(): Omit<SkillContext, 'bag'> {
  return {
    runId: 'r1',
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩，引擎不触碰这些字段
    llm: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    persona: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    sources: {} as any,
    emit: () => {},
    signal: new AbortController().signal,
  };
}

function skill(name: string, run: Skill['run']): Skill {
  return { name, title: name, run };
}

describe('WorkflowEngine', () => {
  it('顺序跑各 Skill，并把返回值写入 bag[name]', async () => {
    const reg = new SkillRegistry();
    reg.register(skill('a', async () => 1));
    reg.register(skill('b', async (ctx) => (ctx.bag.a as number) + 1));
    const eng = new WorkflowEngine(reg, {
      skillTimeoutMs: 1000,
      runWallclockMs: 5000,
      gate: async () => '',
    });
    const bag = await eng.run('r1', [{ skillName: 'a' }, { skillName: 'b' }], ctxBase());
    expect(bag.a).toBe(1);
    expect(bag.b).toBe(2);
  });

  it('gateAfter 调用 gate 并把选择写入 bag[gate.<skill>]', async () => {
    const reg = new SkillRegistry();
    reg.register(skill('a', async () => ['x', 'y']));
    const gate = vi.fn(async () => 'y');
    const eng = new WorkflowEngine(reg, { skillTimeoutMs: 1000, runWallclockMs: 5000, gate });
    const stages: Stage[] = [
      { skillName: 'a', gateAfter: { question: '选?', options: (bag) => bag.a as string[] } },
    ];
    const bag = await eng.run('r1', stages, ctxBase());
    expect(gate).toHaveBeenCalledWith('选?', ['x', 'y']);
    expect(bag['gate.a']).toBe('y');
  });

  it('haltOn 命中则中止后续 Skill', async () => {
    const reg = new SkillRegistry();
    const bRun = vi.fn(async () => 2);
    reg.register(skill('a', async () => 1));
    reg.register(skill('b', bRun));
    const eng = new WorkflowEngine(reg, {
      skillTimeoutMs: 1000,
      runWallclockMs: 5000,
      gate: async () => '打回',
    });
    const stages: Stage[] = [
      { skillName: 'a', gateAfter: { question: '?', options: ['通过', '打回'], haltOn: ['打回'] } },
      { skillName: 'b' },
    ];
    await eng.run('r1', stages, ctxBase());
    expect(bRun).not.toHaveBeenCalled();
  });

  it('Skill 超时则抛错', async () => {
    const reg = new SkillRegistry();
    reg.register(skill('slow', () => new Promise((r) => setTimeout(() => r(1), 50))));
    const eng = new WorkflowEngine(reg, {
      skillTimeoutMs: 10,
      runWallclockMs: 5000,
      gate: async () => '',
    });
    await expect(eng.run('r1', [{ skillName: 'slow' }], ctxBase())).rejects.toThrow(/超时|timeout/);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm vitest run src/engine/workflow.test.ts`
Expected: FAIL（WorkflowEngine 不存在）。

- [ ] **Step 4: 写实现 src/engine/workflow.ts**

```ts
import type { SkillRegistry } from './registry.js';
import type { SkillContext, Stage } from './types.js';

export interface EngineConfig {
  skillTimeoutMs: number;
  runWallclockMs: number;
  /** 人工卡点交互：给出问题与选项，返回用户选择。 */
  gate: (question: string, options: string[]) => Promise<string>;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export class WorkflowEngine {
  constructor(private readonly registry: SkillRegistry, private readonly cfg: EngineConfig) {}

  /** 跑完整条流水线，返回最终 bag。 */
  async run(
    runId: string,
    stages: Stage[],
    ctxBase: Omit<SkillContext, 'bag'>,
  ): Promise<Record<string, unknown>> {
    const bag: Record<string, unknown> = {};
    const ctx: SkillContext = { ...ctxBase, bag };
    const deadline = Date.now() + this.cfg.runWallclockMs;

    for (const stage of stages) {
      if (Date.now() > deadline) throw new Error('run 整体超时');
      const skill = this.registry.get(stage.skillName);
      ctx.emit(`▶ ${skill.title}`);
      bag[skill.name] = await withTimeout(skill.run(ctx), this.cfg.skillTimeoutMs, skill.title);

      if (stage.gateAfter) {
        const opts =
          typeof stage.gateAfter.options === 'function'
            ? stage.gateAfter.options(bag)
            : stage.gateAfter.options;
        const choice = await this.cfg.gate(stage.gateAfter.question, opts);
        bag[`gate.${skill.name}`] = choice;
        if (stage.gateAfter.haltOn?.includes(choice)) {
          ctx.emit(`⏹ 在「${skill.title}」后中止（选择：${choice}）`);
          return bag;
        }
      }
    }
    return bag;
  }
}
```

- [ ] **Step 5: 运行测试确认通过并提交**

Run: `pnpm vitest run src/engine/workflow.test.ts`
Expected: PASS（4 个用例全绿）。

```bash
git add -A && git commit -m "feat: SkillRegistry + WorkflowEngine with gate/halt/timeout"
```

---

## Task 6: Skill ① hotspot.fetch

**Files:**
- Create: `src/skills/hotspot-fetch.ts`
- Test: `src/skills/hotspot-fetch.test.ts`

- [ ] **Step 1: 写失败测试 src/skills/hotspot-fetch.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import type { SkillContext } from '../engine/types.js';
import { MockHotspotSource } from '../sources/hotspot-source.js';
import { hotspotFetchSkill } from './hotspot-fetch.js';

function ctx(persona: Partial<{ topicPreferences: string[] }>): SkillContext {
  return {
    runId: 'r1',
    // biome-ignore lint/suspicious/noExplicitAny: 该 skill 不触碰 llm
    llm: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: 仅用到 topicPreferences
    persona: { topicPreferences: persona.topicPreferences } as any,
    sources: { hotspot: new MockHotspotSource() },
    bag: {},
    emit: () => {},
    signal: new AbortController().signal,
  };
}

describe('hotspot.fetch', () => {
  it('用 persona 偏好作为关键词抓热点', async () => {
    const hits = await hotspotFetchSkill.run(ctx({ topicPreferences: ['效率'] }));
    expect(Array.isArray(hits)).toBe(true);
    expect((hits as unknown[]).length).toBeGreaterThan(0);
  });

  it('无偏好时返回全部热点', async () => {
    const hits = (await hotspotFetchSkill.run(ctx({}))) as unknown[];
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/skills/hotspot-fetch.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现 src/skills/hotspot-fetch.ts**

```ts
import type { Hotspot, Skill } from '../engine/types.js';

export const hotspotFetchSkill: Skill<Hotspot[]> = {
  name: 'hotspot.fetch',
  title: '① 抓取热点',
  async run(ctx) {
    const keywords = ctx.persona.topicPreferences ?? [];
    const hits = await ctx.sources.hotspot.fetch({ keywords, limit: 10 });
    ctx.emit(`  抓到 ${hits.length} 条热点`);
    return hits;
  },
};
```

- [ ] **Step 4: 运行测试确认通过并提交**

Run: `pnpm vitest run src/skills/hotspot-fetch.test.ts`
Expected: PASS

```bash
git add -A && git commit -m "feat: hotspot.fetch skill"
```

---

## Task 7: Skill ② topic.generate

**Files:**
- Create: `src/skills/topic-generate.ts`
- Test: `src/skills/topic-generate.test.ts`

- [ ] **Step 1: 写失败测试 src/skills/topic-generate.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import type { Hotspot, SkillContext } from '../engine/types.js';
import { FakeLlmClient } from '../llm/fake.js';
import { topicGenerateSkill } from './topic-generate.js';

const hotspots: Hotspot[] = [
  { id: 'h1', title: '年轻人用AI管理时间', heat: 9800, source: 'm', keywords: ['效率', 'AI'] },
];

function ctx(llm: FakeLlmClient): SkillContext {
  return {
    runId: 'r1',
    llm,
    // biome-ignore lint/suspicious/noExplicitAny: 仅读 positioning/styleGuide/topicPreferences
    persona: { positioning: '职场效率', styleGuide: '口语化', topicPreferences: ['效率'] } as any,
    // biome-ignore lint/suspicious/noExplicitAny: 该 skill 不触碰 sources
    sources: {} as any,
    bag: { 'hotspot.fetch': hotspots },
    emit: () => {},
    signal: new AbortController().signal,
  };
}

describe('topic.generate', () => {
  it('基于热点与人设产出带 id 的选题集', async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({
        topics: [{ title: '选题1', angle: '角度1', rationale: '契合理由1' }],
      }),
    ]);
    const topics = await topicGenerateSkill.run(ctx(llm));
    expect(topics).toHaveLength(1);
    expect(topics[0]?.id).toBe('t1');
    expect(topics[0]?.title).toBe('选题1');
    // prompt 里应带上热点标题与人设定位
    expect(llm.calls[0]?.prompt).toContain('年轻人用AI管理时间');
    expect(llm.calls[0]?.prompt).toContain('职场效率');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/skills/topic-generate.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现 src/skills/topic-generate.ts**

```ts
import type { Hotspot, Skill, Topic } from '../engine/types.js';

interface RawTopics {
  topics: Array<{ title: string; angle: string; rationale: string }>;
}

export const topicGenerateSkill: Skill<Topic[]> = {
  name: 'topic.generate',
  title: '② 生成选题集',
  async run(ctx) {
    const hotspots = (ctx.bag['hotspot.fetch'] as Hotspot[]) ?? [];
    const { persona } = ctx;
    const hotspotLines = hotspots
      .map((h) => `- ${h.title}（热度${h.heat}，关键词：${h.keywords.join('、')}）`)
      .join('\n');

    const raw = await ctx.llm.completeJson<RawTopics>({
      system: '你是资深小红书内容策划，擅长把热点结合账号人设拆成高潜力选题。',
      prompt: [
        `账号定位：${persona.positioning}`,
        `内容风格：${persona.styleGuide}`,
        persona.topicPreferences?.length ? `选题偏好：${persona.topicPreferences.join('、')}` : '',
        persona.forbiddenZones?.length ? `内容禁区（必须规避）：${persona.forbiddenZones.join('、')}` : '',
        '',
        '当前热点：',
        hotspotLines,
        '',
        '请产出 3-5 个选题，每个包含 title（选题名）、angle（切入角度）、rationale（为什么契合这个账号）。',
        '输出 JSON：{"topics":[{"title":"","angle":"","rationale":""}]}',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    const topics: Topic[] = raw.topics.map((t, i) => ({ id: `t${i + 1}`, ...t }));
    ctx.emit(`  生成 ${topics.length} 个选题`);
    return topics;
  },
};
```

- [ ] **Step 4: 运行测试确认通过并提交**

Run: `pnpm vitest run src/skills/topic-generate.test.ts`
Expected: PASS

```bash
git add -A && git commit -m "feat: topic.generate skill"
```

---

## Task 8: Skill ③a content.draft

**Files:**
- Create: `src/skills/content-draft.ts`
- Test: `src/skills/content-draft.test.ts`

- [ ] **Step 1: 写失败测试 src/skills/content-draft.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import type { SkillContext, Topic } from '../engine/types.js';
import { FakeLlmClient } from '../llm/fake.js';
import { contentDraftSkill } from './content-draft.js';

const topics: Topic[] = [
  { id: 't1', title: '选题1', angle: '角度1', rationale: 'r1' },
  { id: 't2', title: '选题2', angle: '角度2', rationale: 'r2' },
];

function ctx(llm: FakeLlmClient, gateChoice: string): SkillContext {
  return {
    runId: 'r1',
    llm,
    // biome-ignore lint/suspicious/noExplicitAny: 仅读风格与样本
    persona: { styleGuide: '口语化', sampleNotes: [{ title: 's', body: 'b' }] } as any,
    // biome-ignore lint/suspicious/noExplicitAny: 不触碰 sources
    sources: {} as any,
    bag: { 'topic.generate': topics, 'gate.topic.generate': gateChoice },
    emit: () => {},
    signal: new AbortController().signal,
  };
}

describe('content.draft', () => {
  it('按 gate 选中的选题 id 出初稿，并把选中选题写入 prompt', async () => {
    const llm = new FakeLlmClient([JSON.stringify({ title: '标题A', body: '正文A' })]);
    const draft = await contentDraftSkill.run(ctx(llm, 't2'));
    expect(draft.title).toBe('标题A');
    expect(draft.body).toBe('正文A');
    expect(llm.calls[0]?.prompt).toContain('选题2');
  });

  it('gate 选了不存在的 id 则退回第一个选题', async () => {
    const llm = new FakeLlmClient([JSON.stringify({ title: 't', body: 'b' })]);
    await contentDraftSkill.run(ctx(llm, 'nope'));
    expect(llm.calls[0]?.prompt).toContain('选题1');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/skills/content-draft.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现 src/skills/content-draft.ts**

```ts
import type { Draft, Skill, Topic } from '../engine/types.js';

export const contentDraftSkill: Skill<Draft> = {
  name: 'content.draft',
  title: '③ 生成初稿',
  async run(ctx) {
    const topics = (ctx.bag['topic.generate'] as Topic[]) ?? [];
    const choiceId = ctx.bag['gate.topic.generate'] as string | undefined;
    const topic = topics.find((t) => t.id === choiceId) ?? topics[0];
    if (!topic) throw new Error('content.draft: 没有可用选题');

    const samples = ctx.persona.sampleNotes
      .map((n) => `【标题】${n.title}\n【正文】${n.body}`)
      .join('\n---\n');

    const draft = await ctx.llm.completeJson<Draft>({
      system: '你是小红书爆款写手，严格模仿账号既有风格写笔记。',
      prompt: [
        `内容风格指南：${ctx.persona.styleGuide}`,
        '',
        '历史爆款样本（模仿其口吻、结构、emoji 习惯）：',
        samples,
        '',
        `本次选题：${topic.title}`,
        `切入角度：${topic.angle}`,
        '',
        '请写一篇小红书图文笔记，输出 JSON：{"title":"标题","body":"正文"}。',
        '标题要有钩子，正文分段、口语化、含适量 emoji 与话题标签。',
      ].join('\n'),
    });
    ctx.emit(`  初稿完成：${draft.title}`);
    return draft;
  },
};
```

- [ ] **Step 4: 运行测试确认通过并提交**

Run: `pnpm vitest run src/skills/content-draft.test.ts`
Expected: PASS

```bash
git add -A && git commit -m "feat: content.draft skill"
```

---

## Task 9: Skill ③b content.refine（自评打磨循环）

**Files:**
- Create: `src/skills/content-refine.ts`
- Test: `src/skills/content-refine.test.ts`

- [ ] **Step 1: 写失败测试 src/skills/content-refine.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import type { Draft, SkillContext } from '../engine/types.js';
import { FakeLlmClient } from '../llm/fake.js';
import { contentRefineSkill } from './content-refine.js';

const draft: Draft = { title: 't0', body: 'b0' };

function ctx(llm: FakeLlmClient, threshold = 80, maxRounds = 3): SkillContext {
  return {
    runId: 'r1',
    llm,
    // biome-ignore lint/suspicious/noExplicitAny: 仅读风格与阈值
    persona: { styleGuide: '口语化', refineThreshold: threshold, maxRefineRounds: maxRounds } as any,
    // biome-ignore lint/suspicious/noExplicitAny: 不触碰 sources
    sources: {} as any,
    bag: { 'content.draft': draft },
    emit: () => {},
    signal: new AbortController().signal,
  };
}

// 一次打磨返回：评分 + 评语 + 改写稿
function round(total: number, title: string) {
  return JSON.stringify({
    scores: { hook: total, emotion: total, density: total, style: total, structure: total },
    total,
    critique: '评语',
    revised: { title, body: `body-${title}` },
  });
}

describe('content.refine', () => {
  it('达标即停，记录轮次', async () => {
    const llm = new FakeLlmClient([round(85, 't1')]);
    const res = await contentRefineSkill.run(ctx(llm, 80));
    expect(res.rounds).toHaveLength(1);
    expect(res.final.title).toBe('t1');
    expect(res.rounds[0]?.total).toBe(85);
  });

  it('未达标则继续打磨，直到达标', async () => {
    const llm = new FakeLlmClient([round(70, 't1'), round(90, 't2')]);
    const res = await contentRefineSkill.run(ctx(llm, 80));
    expect(res.rounds).toHaveLength(2);
    expect(res.final.title).toBe('t2');
  });

  it('始终不达标则到 maxRounds 停，取最后一稿', async () => {
    const llm = new FakeLlmClient([round(50, 't1'), round(55, 't2')]);
    const res = await contentRefineSkill.run(ctx(llm, 80, 2));
    expect(res.rounds).toHaveLength(2);
    expect(res.final.title).toBe('t2');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/skills/content-refine.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现 src/skills/content-refine.ts**

```ts
import type { Draft, RefineResult, RefineRound, Skill } from '../engine/types.js';

interface RawRound {
  scores: Record<string, number>;
  total: number;
  critique: string;
  revised: Draft;
}

const DIMENSIONS =
  '钩子强度(hook) / 情绪共鸣(emotion) / 信息密度(density) / 风格契合(style) / 结构节奏(structure)，每项 0-100。';

export const contentRefineSkill: Skill<RefineResult> = {
  name: 'content.refine',
  title: '③ 反复打磨成精品',
  async run(ctx) {
    const threshold = ctx.persona.refineThreshold ?? 80;
    const maxRounds = ctx.persona.maxRefineRounds ?? 3;
    let current = ctx.bag['content.draft'] as Draft;
    const rounds: RefineRound[] = [];

    for (let i = 1; i <= maxRounds; i++) {
      const raw = await ctx.llm.completeJson<RawRound>({
        system: '你是严苛的小红书内容评审兼改写专家。先按维度打分给评语，再据此改写出更好的一版。',
        prompt: [
          `内容风格指南：${ctx.persona.styleGuide}`,
          `评分维度：${DIMENSIONS}`,
          '',
          `当前标题：${current.title}`,
          `当前正文：\n${current.body}`,
          '',
          '请输出 JSON：',
          '{"scores":{"hook":0,"emotion":0,"density":0,"style":0,"structure":0},"total":0,"critique":"改进意见","revised":{"title":"改写后标题","body":"改写后正文"}}',
          'total 为五项综合（0-100）。revised 必须是据评语改进后的更优版本。',
        ].join('\n'),
      });
      rounds.push({ round: i, scores: raw.scores, total: raw.total, critique: raw.critique });
      current = raw.revised;
      ctx.emit(`  第${i}轮打磨：${raw.total} 分`);
      if (raw.total >= threshold) break;
    }

    return { final: current, rounds };
  },
};
```

- [ ] **Step 4: 运行测试确认通过并提交**

Run: `pnpm vitest run src/skills/content-refine.test.ts`
Expected: PASS（3 个用例全绿）。

```bash
git add -A && git commit -m "feat: content.refine self-critique loop"
```

---

## Task 10: 风控词库 guardrails

**Files:**
- Create: `src/guardrails/xhs-rules.ts`
- Create: `src/guardrails/sensitive-words.ts`
- Test: `src/guardrails/sensitive-words.test.ts`

- [ ] **Step 1: 写词表 src/guardrails/xhs-rules.ts（数据，随检测一起测）**

```ts
import type { RiskHit } from '../engine/types.js';

/** 词库：category → 词 → 严重度。可后续外置成 JSON 热加载。 */
export const SENSITIVE_LEXICON: Array<{
  category: string;
  severity: RiskHit['severity'];
  terms: string[];
}> = [
  { category: '极限词', severity: 'mid', terms: ['最', '第一', '顶级', '国家级', '绝对', '百分百'] },
  { category: '医疗功效', severity: 'high', terms: ['治疗', '根治', '疗效', '抗癌', '消炎', '杀菌'] },
  { category: '导流词', severity: 'high', terms: ['微信', '加V', '私信我', 'vx', '威信'] },
  { category: '政治敏感', severity: 'high', terms: ['政府', '领导人'] },
];
```

- [ ] **Step 2: 写失败测试 src/guardrails/sensitive-words.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { riskLevel, scanSensitive } from './sensitive-words.js';

describe('scanSensitive', () => {
  it('命中极限词与导流词', () => {
    const hits = scanSensitive('这是最好的产品，加微信领取');
    const terms = hits.map((h) => h.term);
    expect(terms).toContain('最');
    expect(terms).toContain('微信');
  });

  it('无命中返回空数组', () => {
    expect(scanSensitive('今天分享一个好用的小工具')).toEqual([]);
  });
});

describe('riskLevel', () => {
  it('无命中为 pass', () => {
    expect(riskLevel([])).toBe('pass');
  });
  it('含 high 命中则为 high', () => {
    expect(riskLevel([{ category: '医疗功效', term: '根治', severity: 'high' }])).toBe('high');
  });
  it('只有 mid 命中则为 mid', () => {
    expect(riskLevel([{ category: '极限词', term: '最', severity: 'mid' }])).toBe('mid');
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm vitest run src/guardrails/sensitive-words.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 写实现 src/guardrails/sensitive-words.ts**

```ts
import type { RiskHit, RiskReport } from '../engine/types.js';
import { SENSITIVE_LEXICON } from './xhs-rules.js';

/** 扫描文本，返回所有命中的敏感词。 */
export function scanSensitive(text: string): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const group of SENSITIVE_LEXICON) {
    for (const term of group.terms) {
      if (text.includes(term)) {
        hits.push({ category: group.category, term, severity: group.severity });
      }
    }
  }
  return hits;
}

/** 由命中项汇总风险等级。 */
export function riskLevel(hits: RiskHit[]): RiskReport['level'] {
  if (hits.length === 0) return 'pass';
  if (hits.some((h) => h.severity === 'high')) return 'high';
  if (hits.some((h) => h.severity === 'mid')) return 'mid';
  return 'low';
}
```

- [ ] **Step 5: 运行测试确认通过并提交**

Run: `pnpm vitest run src/guardrails/sensitive-words.test.ts`
Expected: PASS

```bash
git add -A && git commit -m "feat: guardrails sensitive-words scan + risk level"
```

---

## Task 11: Skill ④ risk.review

**Files:**
- Create: `src/skills/risk-review.ts`
- Test: `src/skills/risk-review.test.ts`

- [ ] **Step 1: 写失败测试 src/skills/risk-review.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import type { RefineResult, SkillContext } from '../engine/types.js';
import { FakeLlmClient } from '../llm/fake.js';
import { riskReviewSkill } from './risk-review.js';

function ctx(llm: FakeLlmClient, body: string): SkillContext {
  const refine: RefineResult = { final: { title: '标题', body }, rounds: [] };
  return {
    runId: 'r1',
    llm,
    // biome-ignore lint/suspicious/noExplicitAny: 不读 persona
    persona: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: 不触碰 sources
    sources: {} as any,
    bag: { 'content.refine': refine },
    emit: () => {},
    signal: new AbortController().signal,
  };
}

describe('risk.review', () => {
  it('命中敏感词时调用 LLM 改写并标记风险等级', async () => {
    const llm = new FakeLlmClient([JSON.stringify({ title: '安全标题', body: '安全正文' })]);
    const report = await riskReviewSkill.run(ctx(llm, '这是最好的，加微信'));
    expect(report.level).toBe('high'); // 命中导流词
    expect(report.hits.length).toBeGreaterThan(0);
    expect(report.rewritten.body).toBe('安全正文');
  });

  it('无命中则 pass 且不调用 LLM，原文直接通过', async () => {
    const llm = new FakeLlmClient([]); // 一旦调用就会抛错
    const report = await riskReviewSkill.run(ctx(llm, '今天分享一个好用的小工具'));
    expect(report.level).toBe('pass');
    expect(report.rewritten.body).toBe('今天分享一个好用的小工具');
    expect(llm.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/skills/risk-review.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现 src/skills/risk-review.ts**

```ts
import type { Draft, RefineResult, RiskReport, Skill } from '../engine/types.js';
import { riskLevel, scanSensitive } from '../guardrails/sensitive-words.js';

export const riskReviewSkill: Skill<RiskReport> = {
  name: 'risk.review',
  title: '④ 过风控与敏感词',
  async run(ctx) {
    const draft = (ctx.bag['content.refine'] as RefineResult).final;
    const hits = scanSensitive(`${draft.title}\n${draft.body}`);
    const level = riskLevel(hits);

    if (hits.length === 0) {
      ctx.emit('  风控通过，无敏感词命中');
      return { hits, level, rewritten: draft };
    }

    const hitDesc = hits.map((h) => `「${h.term}」(${h.category})`).join('、');
    ctx.emit(`  命中 ${hits.length} 处：${hitDesc}，改写规避中…`);
    const rewritten = await ctx.llm.completeJson<Draft>({
      system: '你是小红书合规改写专家。在不损伤表达力的前提下规避平台违禁表述。',
      prompt: [
        '以下文案命中平台敏感/违禁表述，请改写规避，保持原意与风格：',
        `命中项：${hitDesc}`,
        '另外消除任何夸大功效、诱导消费、营销感过重的软性违规表述。',
        '',
        `标题：${draft.title}`,
        `正文：\n${draft.body}`,
        '',
        '输出 JSON：{"title":"改写后标题","body":"改写后正文"}',
      ].join('\n'),
    });
    return { hits, level, rewritten };
  },
};
```

- [ ] **Step 4: 运行测试确认通过并提交**

Run: `pnpm vitest run src/skills/risk-review.test.ts`
Expected: PASS

```bash
git add -A && git commit -m "feat: risk.review skill (lexicon scan + LLM rewrite)"
```

---

## Task 12: Skill ⑤ asset.assemble

**Files:**
- Create: `src/skills/asset-assemble.ts`
- Test: `src/skills/asset-assemble.test.ts`

- [ ] **Step 1: 写失败测试 src/skills/asset-assemble.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import type { RiskReport, SkillContext } from '../engine/types.js';
import { FakeLlmClient } from '../llm/fake.js';
import { assetAssembleSkill } from './asset-assemble.js';

function ctx(llm: FakeLlmClient): SkillContext {
  const risk: RiskReport = { hits: [], level: 'pass', rewritten: { title: 't', body: 'b' } };
  return {
    runId: 'r1',
    llm,
    // biome-ignore lint/suspicious/noExplicitAny: 不读 persona
    persona: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: 不触碰 sources
    sources: {} as any,
    bag: { 'risk.review': risk },
    emit: () => {},
    signal: new AbortController().signal,
  };
}

describe('asset.assemble', () => {
  it('产出多标题候选、正文、配图prompt与发布建议', async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({
        titles: ['标题1', '标题2', '标题3'],
        body: '最终正文',
        imagePrompts: ['封面：xxx', '配图2：yyy'],
        publishTips: '晚8点发，带话题#效率工具',
      }),
    ]);
    const asset = await assetAssembleSkill.run(ctx(llm));
    expect(asset.titles).toHaveLength(3);
    expect(asset.imagePrompts.length).toBeGreaterThan(0);
    expect(asset.publishTips).toContain('话题');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/skills/asset-assemble.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现 src/skills/asset-assemble.ts**

```ts
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
```

- [ ] **Step 4: 运行测试确认通过并提交**

Run: `pnpm vitest run src/skills/asset-assemble.test.ts`
Expected: PASS

```bash
git add -A && git commit -m "feat: asset.assemble skill"
```

---

## Task 13: 产物落盘 + run 组装

**Files:**
- Create: `src/output/persist.ts`
- Create: `src/run.ts`
- Test: `src/output/persist.test.ts`

- [ ] **Step 1: 写失败测试 src/output/persist.test.ts**

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { persistRun } from './persist.js';

describe('persistRun', () => {
  it('把 bag 写成 result.json 与 README.md', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mi-'));
    const bag = {
      'asset.assemble': {
        titles: ['标题1'],
        body: '正文',
        imagePrompts: ['封面'],
        publishTips: '晚8点',
      },
    };
    const dir = await persistRun(root, 'run-123', bag);
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    expect(result['asset.assemble'].titles[0]).toBe('标题1');
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('标题1');
    expect(readme).toContain('封面');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/output/persist.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现 src/output/persist.ts**

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FinalAsset } from '../engine/types.js';

/** 把一次 run 的 bag 落盘到 <root>/<runId>/，返回目录路径。 */
export async function persistRun(
  root: string,
  runId: string,
  bag: Record<string, unknown>,
): Promise<string> {
  const dir = join(root, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'result.json'), JSON.stringify(bag, null, 2), 'utf8');

  const asset = bag['asset.assemble'] as FinalAsset | undefined;
  if (asset) {
    const md = [
      '# 最终作品',
      '',
      '## 标题候选',
      ...asset.titles.map((t, i) => `${i + 1}. ${t}`),
      '',
      '## 正文',
      asset.body,
      '',
      '## 配图 / 分镜',
      ...asset.imagePrompts.map((p, i) => `- 图${i + 1}：${p}`),
      '',
      '## 发布建议',
      asset.publishTips,
    ].join('\n');
    await writeFile(join(dir, 'README.md'), md, 'utf8');
  }
  return dir;
}
```

- [ ] **Step 4: 写 run 组装 src/run.ts（编排 stages，无独立单测，由 CLI 与引擎测试覆盖）**

```ts
import type { EngineConfig } from './engine/workflow.js';
import { WorkflowEngine } from './engine/workflow.js';
import { SkillRegistry } from './engine/registry.js';
import type { SkillContext, Stage } from './engine/types.js';
import type { LlmClient } from './llm/client.js';
import type { PersonaPack } from './persona/persona-pack.js';
import { assetAssembleSkill } from './skills/asset-assemble.js';
import { contentDraftSkill } from './skills/content-draft.js';
import { contentRefineSkill } from './skills/content-refine.js';
import { hotspotFetchSkill } from './skills/hotspot-fetch.js';
import { riskReviewSkill } from './skills/risk-review.js';
import { topicGenerateSkill } from './skills/topic-generate.js';
import type { HotspotSource } from './sources/hotspot-source.js';
import type { Topic } from './engine/types.js';

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

/** 选题卡点的选项 = 实际产出的选题（"id：标题"），兜底防空。 */
function topicGateOptions(bag: Record<string, unknown>): string[] {
  const topics = (bag['topic.generate'] as Topic[]) ?? [];
  return topics.length > 0 ? topics.map((t) => t.id) : ['t1'];
}

export const STAGES: Stage[] = [
  { skillName: 'hotspot.fetch' },
  { skillName: 'topic.generate', gateAfter: { question: '选择一个选题（输入 id）', options: topicGateOptions } },
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
```

- [ ] **Step 5: 运行 persist 测试 + 整体 typecheck，提交**

Run: `pnpm vitest run src/output/persist.test.ts && pnpm typecheck`
Expected: 测试 PASS；typecheck 通过。

```bash
git add -A && git commit -m "feat: run pipeline assembly + output persistence"
```

---

## Task 14: CLI 入口 + 终端 gate

**Files:**
- Create: `src/cli.ts`
- Create: `README.md`
- Test: `src/cli.test.ts`

- [ ] **Step 1: 写失败测试 src/cli.test.ts（只测纯函数 makeTerminalGate / newRunId）**

```ts
import { describe, expect, it } from 'vitest';
import { newRunId, resolveGateChoice } from './cli.js';

describe('newRunId', () => {
  it('生成带 run- 前缀的非空 id', () => {
    const id = newRunId();
    expect(id.startsWith('run-')).toBe(true);
    expect(id.length).toBeGreaterThan(5);
  });
});

describe('resolveGateChoice', () => {
  it('精确匹配选项', () => {
    expect(resolveGateChoice('通过', ['通过', '打回'])).toBe('通过');
  });
  it('输入不在选项中时退回第一个选项', () => {
    expect(resolveGateChoice('xxx', ['通过', '打回'])).toBe('通过');
  });
  it('空输入退回第一个选项', () => {
    expect(resolveGateChoice('', ['t1', 't2'])).toBe('t1');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/cli.test.ts`
Expected: FAIL（模块不存在 / 函数未导出）。

- [ ] **Step 3: 写实现 src/cli.ts**

```ts
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { ClaudeLlmClient } from './llm/client.js';
import { persistRun } from './output/persist.js';
import { demoPersona } from './persona/examples/demo.js';
import type { PersonaPack } from './persona/persona-pack.js';
import { runPipeline } from './run.js';
import { MockHotspotSource } from './sources/hotspot-source.js';

/** 用进程启动时间戳生成 run id（在函数内取时间，保持其他模块纯净）。 */
export function newRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

/** 把用户输入规整为合法选项：命中则用之，否则退回第一个选项。 */
export function resolveGateChoice(input: string, options: string[]): string {
  const trimmed = input.trim();
  if (options.includes(trimmed)) return trimmed;
  return options[0] ?? trimmed;
}

async function terminalGate(question: string, options: string[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`\n${question}\n  选项：${options.join(' / ')}\n> `);
    return resolveGateChoice(answer, options);
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  // MVP：固定用示例人设；后续可加 --persona 从 personas/ 动态加载。
  const persona: PersonaPack = demoPersona;
  const runId = newRunId();
  console.log(`\n🚀 百万网红 Agent | 账号：${persona.displayName} | run：${runId}\n`);

  const bag = await runPipeline(runId, {
    llm: new ClaudeLlmClient(),
    persona,
    hotspot: new MockHotspotSource(),
    engineCfg: { skillTimeoutMs: 120_000, runWallclockMs: 600_000, gate: terminalGate },
  });

  const dir = await persistRun(resolve('runs'), runId, bag);
  console.log(`\n✅ 完成，产物已落盘：${dir}`);
}

// 仅在被直接执行时运行 main（被测试 import 时不触发）。
if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  main().catch((e) => {
    console.error('❌ 运行失败：', e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/cli.test.ts`
Expected: PASS

- [ ] **Step 5: 写 README.md**

````markdown
# 百万网红 Agent（macro-influencer）

人设驱动的小红书图文流水线：抓热点 → 出选题 →（选题卡点）→ 成稿 → 反复打磨 → 过风控（风控卡点）→ 产出标题/正文/配图。

## 架构

`WorkflowEngine` 顺序跑 6 个 `Skill`，Skill 间用黑板 `bag` 传数据，关键节点设人工 `gate`。数据来源用 `HotspotSource` 适配器隔离（当前 Mock）。详见 `docs/superpowers/specs/2026-06-09-macro-influencer-design.md`。

## 用法

```bash
pnpm install
export ANTHROPIC_API_KEY=sk-...
pnpm start          # 用示例人设跑一次，产物落到 runs/<id>/
pnpm test           # 跑全部单测
```

## 加一个账号

在 `personas/` 写一份 `definePersona({...})`，描述定位/风格/历史样本即可。
````

- [ ] **Step 6: 全量校验并提交**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: 全部 PASS / 无 error。

```bash
git add -A && git commit -m "feat: CLI entry with terminal gate + README"
```

---

## Task 15: 端到端冒烟（FakeLlm 全链路）

**Files:**
- Test: `src/run.e2e.test.ts`

- [ ] **Step 1: 写端到端测试 src/run.e2e.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import type { EngineConfig } from './engine/workflow.js';
import { FakeLlmClient } from './llm/fake.js';
import { demoPersona } from './persona/examples/demo.js';
import { runPipeline } from './run.js';
import { MockHotspotSource } from './sources/hotspot-source.js';

describe('runPipeline E2E（全链路用 FakeLlm）', () => {
  it('从热点跑到最终作品包', async () => {
    // 依次对应：topic.generate / content.draft / content.refine / asset.assemble
    // （risk.review 因示例文案无敏感词命中而不调用 LLM）
    const llm = new FakeLlmClient([
      JSON.stringify({ topics: [{ title: '选题1', angle: '角度', rationale: '契合' }] }),
      JSON.stringify({ title: '初稿标题', body: '初稿正文，分享一个好用的小工具' }),
      JSON.stringify({
        scores: { hook: 90, emotion: 90, density: 90, style: 90, structure: 90 },
        total: 90,
        critique: '很好',
        revised: { title: '打磨标题', body: '打磨后的正文，分享一个好用的小工具' },
      }),
      JSON.stringify({
        titles: ['终稿标题A', '终稿标题B', '终稿标题C'],
        body: '终稿正文',
        imagePrompts: ['封面图', '配图2'],
        publishTips: '晚8点发，带话题#效率工具',
      }),
    ]);

    const engineCfg: EngineConfig = {
      skillTimeoutMs: 5000,
      runWallclockMs: 30_000,
      gate: async (_q, options) => options[0] ?? '', // 选题选第一个；风控自动"通过"
    };

    const bag = await runPipeline('run-e2e', {
      llm,
      persona: demoPersona,
      hotspot: new MockHotspotSource(),
      engineCfg,
    });

    const asset = bag['asset.assemble'] as { titles: string[]; imagePrompts: string[] };
    expect(asset.titles).toHaveLength(3);
    expect(asset.imagePrompts.length).toBeGreaterThan(0);
    expect(bag['gate.topic.generate']).toBe('t1');
  });
});
```

- [ ] **Step 2: 运行确认通过**

Run: `pnpm vitest run src/run.e2e.test.ts`
Expected: PASS（若失败，多半是 bag 键名或 stage 顺序对不上，按报错对照 §文件结构总览的 bag 约定修正）。

- [ ] **Step 3: 全量校验并提交**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: 全绿。

```bash
git add -A && git commit -m "test: end-to-end pipeline smoke with FakeLlm"
```

---

## 自检结论（Spec 覆盖核对）

- spec §3.1 PersonaPack → Task 2 ✅
- spec §3.2 编排骨架（Skill/Context/Stage/Engine/Registry）→ Task 2、Task 5 ✅
- spec §4 流水线 6 Skill + 2 卡点 → Task 6-9、11-12 + Task 13 STAGES ✅
- spec §4.1 refine 5 维自评循环 → Task 9 ✅
- spec §4.2 风控两层（规则 + LLM）→ Task 10（规则层）、Task 11（LLM 层 + 卡点）✅
- spec §4.3 HotspotSource 适配器 → Task 4 ✅
- spec §5 目录结构 → 各 Task 文件路径 ✅
- spec §6 错误处理（超时/落盘）→ Task 5（超时）、Task 13（落盘）✅
- spec §7 测试策略（FakeLlm 打桩 + 引擎/词库/E2E）→ 各 Task 测试 + Task 15 ✅
```
