# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                         | Files / Scope                                       | Depends On | Verification                                                                      |
| --- | ------ | ---------------------------- | --------------------------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| T1  | Done   | 读取架构、规范和现有观测文档 | README、docs、.trellis/spec                         | -          | 已核对架构、前后端/admin/shared/database/cross-layer 规范与 observability runbook |
| T2  | Done   | 枚举所有运行链路与入口       | packages、ops、workspace 配置                       | T1         | 已覆盖 27 个页面、HTTP/SSE、jobs/scripts、proxy、DB cron 与 workspace packages    |
| T3  | Done   | 映射 Sentry/Grafana 覆盖     | instrumentation、telemetry、日志、dashboard         | T2         | 覆盖矩阵和证据索引已写入 research 报告                                            |
| T4  | Done   | 审计页面耗时起止点           | Frontend/Admin 页面与 tracker                       | T2         | 已区分 document、Telegram-ready mount、React commit、paint/critical visual        |
| T5  | Done   | 审计 HTTP/SSE 耗时起止点     | API client、Fastify route、stream parser/generation | T2         | 已区分 headers/body/total、first token/done/EOF/close                             |
| T6  | Done   | 只读核对线上可见数据         | Sentry API；Grafana 配置/可用只读入口               | T3-T5      | Sentry region/default API 均 403；无 Grafana 只读连接，限制已明确记录             |
| T7  | Done   | 汇总分级报告与修复顺序       | research、最终答复                                  | T3-T6      | 报告已完成；现有性能测试通过                                                      |

## Execution Log

- 2026-11-05：创建任务并通过规划门禁，进入只读执行阶段。
- 2026-11-05：完成全仓入口、Sentry/Grafana 覆盖、页面/HTTP/SSE 计时口径审计；报告位于 `research/observability-audit.md`。
- 2026-11-05：Sentry 只读 API 对 region/default endpoint 均返回 403 permission denied；未读取业务数据或敏感信息。
- 2026-11-05：Frontend 6 个性能测试文件 130 项通过；Backend 2 个观测测试文件 13 项通过；Fastify hijack/onResponse 最小验证通过。
