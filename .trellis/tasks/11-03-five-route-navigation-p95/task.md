# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status  | Task                                                                      | Files / Scope                       | Depends On | Verification                          |
| --- | ------- | ------------------------------------------------------------------------- | ----------------------------------- | ---------- | ------------------------------------- |
| T1  | Done    | 读取规范、复用链路并采集 7d 生产基线                                      | specs、Grafana Loki、research       | -          | 基线含 route/platform/N 与无样本说明  |
| T2  | Done    | 完成 PRD、设计、执行计划和移动性能门禁                                    | task artifacts                      | T1         | `task.py validate` / `task.py start`  |
| T3  | Done    | 补齐五路由统一就绪语义与 2 秒预算维度                                     | perf tracker、creation、profile     | T2         | 既有 perf tests                       |
| T4  | Done    | 增加导航意图主数据预取和平台优先级；短剧按回归结果仅保留 route chunk 预热 | API hooks、BottomNav、mobile policy | T2         | existing tests/typecheck/UI           |
| T5  | Done    | 增加五路由 Grafana dashboard 与运维文档                                   | docs/grafana                        | T3         | JSON parse + live LogQL review        |
| T6  | Done    | 运行完整验证并更新模块事实                                                | frontend/ui-tests/spec/task         | T3,T4,T5   | typecheck/test/lint/build/UI          |
| T7  | Blocked | 将 dashboard JSON 导入 Grafana Cloud 并按 release 验证生产目标            | Grafana Cloud                       | T5,T6      | 当前连接只读；发布后每路由/平台 N≥100 |

## Execution Log

- 2026-11-03：完成当前代码链路、Android/iOS 7d 基线、API 聚合基线与缺口审计。
- 2026-11-04：完成五路由 ready/预算维度、平台 route warmup、characters/favorites/wallet intent 预取和 dashboard JSON；Cloud 连接可查询但不可写，在线导入待有写权限的工程师执行。
- 2026-11-04：完整 frontend test 69 files/757 tests、typecheck、lint、build 通过；Android/窄屏五入口导航通过，Android/窄屏充值空态分别通过，Android 剧场布局通过。组合 profile 套件曾出现场景切换抖动，隔离复跑通过。
- 2026-11-04：短剧 intent 数据预取曾令五入口用例稳定停在首批6张卡；移除该分支后 Android/窄屏均通过，因此短剧只保留 route chunk 预热和既有缓存。
