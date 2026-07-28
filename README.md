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

## 生产部署

项目通过公共 Docker VPS Workflow 自动部署，配置方式见 [`docs/deployment.md`](docs/deployment.md)。

## 加一个账号

在 `personas/` 写一份 `definePersona({...})`，描述定位/风格/历史样本即可。
