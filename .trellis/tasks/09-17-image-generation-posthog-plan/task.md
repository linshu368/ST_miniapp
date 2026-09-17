# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID | Status | Task | Files / Scope | Depends On | Verification |
| -- | ------ | ---- | ------------- | ---------- | ------------ |
| T1 | Done | 完成现有 PostHog/支付/图片链路调研并记录复用结论 | `research/posthog-image-generation-reuse.md` | - | 已检索 shared telemetry、frontend lifecycle/payment helper、backend payment observer、图片 route/worker |
| T2 | Done | 定义图片生成 PostHog 事件清单和安全字段边界 | `design.md` | T1 | 事件表覆盖 Frontend/Backend，列出禁止字段和去重策略 |
| T3 | Done | 规划 Frontend 接入节点与方式 | `design.md` | T2 | 覆盖 chat page、image footer、image API/query 终态观察、recharge trigger |
| T4 | Done | 规划 Backend 接入节点与方式 | `design.md` | T2 | 覆盖 images route、worker terminal、PostHog capture 泛化、observer |
| T5 | Done | 规划配置、可靠性、发布回滚和验证 | `design.md`、`implement.md` | T2-T4 | 覆盖 no-op、超时、幂等/去重、人工验收和命令 |
| T6 | Done | 配置后续实现所需上下文清单 | `implement.jsonl`、`check.jsonl` | T1-T5 | 文件包含真实 spec/research 条目，无 seed-only 上下文 |

## Execution Log

- 2026-09-17：创建 Trellis planning task。
- 2026-09-17：读取入口文档、frontend/backend/shared 规范、模块索引和现有 PostHog/支付/图片源码。
- 2026-09-17：完成规划 artifacts；未执行 `task.py start`，未改产品代码。
