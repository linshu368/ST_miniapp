# Task Breakdown

## Tasks

| ID  | Status | Task                                       | Files / Scope                                              | Depends On | Verification                  |
| --- | ------ | ------------------------------------------ | ---------------------------------------------------------- | ---------- | ----------------------------- |
| T1  | Done   | 对比两日报告、提交和现有埋点，完成因果分级 | `research/performance-regression.md`                       | -          | 证据与口径互相校验            |
| T2  | Done   | 实现 sink 首个可见字符通知                 | `features/conversations/sse.ts`、现有测试                  | T1         | 定向 Vitest 通过              |
| T3  | Done   | 实现 Sentry 首字/完整流双口径并接线        | `lib/perf-metrics.ts`、`routes/conversations.ts`、现有测试 | T2         | 定向 Vitest、typecheck 通过   |
| T4  | Done   | 全量验证、代码审查和任务归档               | 任务验证文档、工作树                                       | T3         | backend test、diff check 通过 |

## Execution Log

- 2026-11-02：完成报告、提交、SSE sink、Sentry/Grafana 指标复用调研；确认问题为“完整流被当作响应 P95”的口径偏差与真实完整生成长尾叠加。
- 2026-11-02：实现首字/完整流双指标，更新日报提示词与模板；定向 22 项和后端全量 1153 项测试通过。
- 2026-11-02：完成最终审查与模块知识校验；任务按用户要求自动归档，不创建提交、不推送。
