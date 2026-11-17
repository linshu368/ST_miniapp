# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                | Files / Scope                                              | Verification                                               |
| --- | ------ | ----------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| T1  | Done   | 补齐页面 registry 与 ready          | route-template、creator/wishes pages/components            | registry/page-ready tests                                  |
| T2  | Done   | 修正普通 HTTP headers/total/timeout | request-timing、api client、api-timing                     | slow body/abort/retry tests                                |
| T3  | Done   | 修正聊天与 Creator polish 流式终点  | conversation hook、roleplay timing、creator stream         | done/commit/EOF/abort tests                                |
| T4  | Done   | 补齐 lobby proxy 中转观测           | Next route、API timing                                     | route/API timing tests                                     |
| T5  | Done   | 接入 Backend jobs/scripts           | engineering observability、background helper、jobs/scripts | backend tests/typecheck                                    |
| T6  | Done   | 输出修改后覆盖清单                  | docs/grafana                                               | 与最终 diff 逐项核对                                       |
| T7  | Done   | 全量验证与最终复核                  | frontend/backend/docs/task                                 | tests/typecheck/lint/build/diff 通过；范围外门禁阻断已记录 |

## Execution Log

- 2026-11-05：完成前一轮只读审计；用户将范围限定为 Frontend/Backend，并授权直接修复与输出清单。
- 2026-11-05：完成复用、可靠性、最小方案、发布恢复和移动端 P95 规划后进入实现。
- 2026-11-05：完成 Frontend 页面/API/SSE/NDJSON/代理计时修正，以及 Backend jobs/scripts Sentry 与 Grafana 接入。
- 2026-11-05：定向测试、两端 typecheck、Frontend 全量测试/lint/build 与 diff 检查通过；Backend 全量并行测试的 3 个既有会话用例单 worker 重跑通过。复杂度与模块知识门禁的范围外既有阻断记录在交付清单。
