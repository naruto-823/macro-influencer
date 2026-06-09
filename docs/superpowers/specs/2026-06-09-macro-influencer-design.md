# 百万网红 Agent 设计文档（macro-influencer）

> 立项日期：2026-06-09
> 架构参考：`/Users/naruo/Workspace/ug-agents` 的「编排式领域」模式（WorkflowEngine + Skill + 黑板 bag + gate 卡点）。
> 本工程为**独立 TS 工程**，借鉴该架构但不依赖 ug-agents 任何包。

## 1. 目标

根据「我的账号人设 + 历史作品数据与风格」，自动产出可直接发布的小红书图文作品。一条流水线覆盖：

1. 实时抓取热点 / 爆点信息
2. 结合账号内容风格生成选题集
3. 生成符合历史笔记风格的内容，并反复打磨成精品
4. 过小红书风控（敏感词、软性违规）
5. 产出最终作品：标题（多候选）、正文、配图 prompt / 分镜脚本

## 2. 范围（MVP 边界）

| 维度 | MVP 决定 | 说明 |
|------|----------|------|
| 工程形态 | 独立 TS 工程 | 借鉴 ug-agents 架构，与之解耦 |
| 数据来源 | **先 Mock**，留 Adapter 接口 | 抓取层抽象成 `HotspotSource` 接口，先 `MockHotspotSource`；真源（爬虫/三方 API）后续只换实现 |
| 图片/视频 | **先只做图文** | 配图产出 prompt / 分镜脚本，不真调文生图/文生视频模型 |
| 交互形态 | **CLI** | 一条命令跑完整流水线，gate 走终端交互，产物落盘 |
| LLM | Claude（opus/sonnet） | 通过 `src/llm` 封装统一调用 |

**显式不做（YAGNI）**：HTTP 服务、WebSocket 事件流、数据库持久化、Web UI、真实爬虫、真生图/生视频、多账号并发调度。这些都通过保留清晰接口为后续留口子，但本期不实现。

## 3. 核心抽象

### 3.1 PersonaPack —— 声明式账号配置

类比 ug-agents 的 `DomainPack`。一个文件完整描述「这个账号是谁」，加一个新账号 = 写一份 PersonaPack，不碰引擎。

```ts
interface PersonaPack {
  id: string;                    // 账号唯一标识，kebab-case
  displayName: string;           // 账号展示名
  positioning: string;           // 人设定位：是谁、给谁看、提供什么价值
  styleGuide: string;            // 内容风格指南：语气、句式、emoji 习惯、结构偏好
  sampleNotes: SampleNote[];     // 历史爆款笔记样本（标题 + 正文 + 表现数据）
  topicPreferences?: string[];   // 选题偏好方向
  forbiddenZones?: string[];     // 内容禁区（不碰的话题）
  refineThreshold?: number;      // 打磨打分阈值，缺省取默认
  maxRefineRounds?: number;      // 打磨最大轮数，缺省取默认
}

interface SampleNote {
  title: string;
  body: string;
  metrics?: { likes?: number; collects?: number; comments?: number };
}
```

`definePersona(pack)` 做基本校验 + 默认值填充（参照 `defineDomain`）。

真实人设放 `personas/`（gitignore，像 `.env`）；仓库内放一份 `src/persona/examples/` 示例供测试和上手。

### 3.2 编排骨架（裁剪自 seo-orchestrator）

- `Skill<I, O>`：`{ name, title, run(input, ctx) }`，干一件事、产一个清晰产物、可独立测试。
- `SkillContext`：`{ runId, llm, persona, sources, bag, logger, signal, emit }`。`bag` 是跨 Skill 的黑板，传递热点 / 选题 / 初稿 / 终稿 / 风控结论。
- `Stage`：`{ skillName, gateAfter? }`。`gateAfter` 定义人工卡点，CLI 下表现为终端交互式选择 / 确认；选项可静态或读 bag 动态生成。
- `WorkflowEngine`：按 `Stage[]` 顺序跑，遇 gate 暂停等终端输入再续跑，统一超时 / 错误处理，emit 进度到终端。
- `SkillRegistry`：注册 / 取 Skill。

## 4. 流水线

```
①hotspot.fetch
  → ②topic.generate ─[卡点A: 从选题集里选 1 个]→
③content.draft
  → ③content.refine (自评打磨 N 轮)
  → ④risk.review ─[卡点B: 通过 / 打回重写]→
⑤asset.assemble → 落盘 runs/<id>/
```

| Skill | 输入 | 产物（写入 bag / 落盘） |
|-------|------|------------------------|
| `hotspot.fetch` | persona 偏好方向 | 热点列表（标题、热度、来源、关键词） |
| `topic.generate` | 热点 + persona | 选题集（3-5 个：选题 + 角度 + 与账号契合理由） |
| `content.draft` | 选中选题 + persona | 初稿（标题 + 正文） |
| `content.refine` | 初稿 + persona | 终稿 + 每轮评分理由 |
| `risk.review` | 终稿 + 词库/规则 | 风控结论（命中项、改写后文本、风险等级） |
| `asset.assemble` | 终稿 + 风控结论 | 最终作品包：标题候选、正文、配图 prompt 列表、发布建议 |

### 4.1 ③ content.refine —— 打磨成精品

self-critique 循环：对照 `styleGuide` + `sampleNotes`，从 5 维打分（满分各项可加权）：

- 钩子强度（开头 3 秒留人）
- 情绪共鸣
- 信息密度 / 干货含量
- 风格契合（与历史笔记口吻一致度）
- 结构（分段、节奏、行动召唤）

总分低于 `refineThreshold` 则带着具体批评意见重写，最多 `maxRefineRounds` 轮。输出保留每轮分数与改进理由，便于复盘。

### 4.2 ④ risk.review —— 过风控

两层串联：

1. **规则层**：扫敏感词库与小红书规则，命中标红。词库分类：医疗功效 / 极限词（最 / 第一 / 国家级）/ 导流词（微信 / 加V / 私）/ 政治敏感 / 竞品。词库可配置、可热加载（`guardrails/sensitive-words.ts` + 词表文件）。
2. **LLM 层**：判软性违规——夸大功效、诱导消费、营销感过重、虚假承诺。

命中后自动改写规避，产出「命中项 + 改写文本 + 风险等级」，再走卡点 B 让人确认（通过 / 打回重写）。

### 4.3 数据源适配器

```ts
interface HotspotSource {
  fetch(opts: { keywords?: string[]; limit?: number }): Promise<Hotspot[]>;
}
```

本期 `MockHotspotSource` 返回本地 JSON / 内置样本。真源（爬虫、第三方榜单 API）后续实现同一接口，引擎与 Skill 零改动。

## 5. 目录结构

```
macro-influencer/
├── src/
│   ├── cli.ts                 # 入口：influencer run --persona <id>
│   ├── engine/
│   │   ├── workflow.ts        #   WorkflowEngine：跑 Stage[]、gate、bag
│   │   └── types.ts          #   Stage / Skill / SkillContext
│   ├── skills/
│   │   ├── registry.ts
│   │   ├── hotspot-fetch.ts
│   │   ├── topic-generate.ts
│   │   ├── content-draft.ts
│   │   ├── content-refine.ts
│   │   ├── risk-review.ts
│   │   └── asset-assemble.ts
│   ├── sources/
│   │   └── hotspot-source.ts  # interface + MockHotspotSource
│   ├── persona/
│   │   ├── persona-pack.ts    # definePersona + 校验
│   │   └── examples/          # 示例人设
│   ├── guardrails/
│   │   ├── sensitive-words.ts # 词库加载 + 检测
│   │   └── xhs-rules.ts       # 小红书规则
│   ├── llm/
│   │   └── client.ts          # Claude 封装（含 JSON 输出助手）
│   └── output/                # 产物落盘
├── personas/                  # 真实人设（gitignore）
├── runs/                      # 每次产出
├── package.json / tsconfig.json / biome.json / vitest.config.ts
└── README.md
```

## 6. 错误处理与可观测

- 每个 Skill 有超时；整条 run 有 wallclock 上限。
- Skill 失败 emit `skill.failed` 并中止该 run；CLI 打印失败阶段与原因。
- 每次 run 落 `runs/<id>/`：含各阶段中间产物、refine 评分历史、风控报告、最终作品包，便于复盘与单步重跑。
- LLM 调用失败重试有限次后降级报错。

## 7. 测试策略

- TDD：每个 Skill 先写测试。LLM 调用以注入的 fake `llm` 客户端打桩，断言 prompt 组装与产物解析，不打真模型。
- `WorkflowEngine` 测试覆盖：顺序执行、gate 暂停/续跑、超时、失败中止。
- `guardrails` 测试覆盖词库命中、改写、风险分级。
- `MockHotspotSource` 与 `definePersona` 校验各有单测。
- 工具链：vitest + biome，与 ug-agents 一致。

## 8. 后续可扩展（本期留口子，不实现）

- 真实 `HotspotSource`（爬虫 / 三方 API）
- 真生图 / 真生视频 Skill
- 服务化（HTTP + 事件流 + DB），复用现有 Skill
- Web UI 审稿台
- 多账号调度与发布日历
