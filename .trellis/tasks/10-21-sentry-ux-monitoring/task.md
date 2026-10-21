# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status  | Task                                                                                                                                                                                                           | Files / Scope                                                                         | Depends On | Verification                                                                                     |
| --- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| T0  | Todo    | 核实待验证项：`Sentry.metrics` API 在 10.69 可用；`captureMessage` 是否触发 Replay 缓冲；INP/Web Vitals 是否已在面板；`enableHTTPTimings`；Prisma client extension 可包裹现有调用；Sentry MCP 能否建 dashboard | `packages/frontend`、`packages/backend` 只读/小脚本                                   | -          | 每条结论写入 `research/t0-verification.md`，不通过则改 design                                    |
| T1  | Todo    | 修 `sanitizeValue` 深度/节点上限；Replay 事件改浅层脱敏                                                                                                                                                        | `packages/shared/src/telemetry/sanitize.ts`、`frontend/src/lib/sentry/client.ts`      | T0         | shared 测试 + 所有消费者 typecheck；用深层嵌套对象人工验证不再栈溢出（是否新增测试需负责人确认） |
| T2  | Todo    | 后端：`onResponse` 耗时 metrics、慢请求日志、事件循环延迟、Prisma 操作耗时、采样改为继承+0.2、`Timing-Allow-Origin`                                                                                            | `backend/src/lib/perf-metrics.ts`、`app.ts`、`instrumentation.ts`、`lib/db.ts`        | T0         | backend typecheck/test；development 环境人工制造慢请求，Sentry 看到 metrics 与日志               |
| T3  | Todo    | 前端：`tracePropagationTargets`、`apiClient` 耗时/超时/in-flight、`slow_request` 事件、采样调整                                                                                                                | `frontend/src/instrumentation-client.ts`、`lib/api/client.ts`、`lib/perf/inflight.ts` | T2         | 前端 typecheck/test/lint/build；Sentry 里同一条 trace 含前端 `http.client` 与后端 `http.server`  |
| T4  | Todo    | 前端：页面就绪与看门狗、`page.entry_window`、环境标签、资源加载失败                                                                                                                                            | `lib/perf/page-tracker.ts`、`env-tags.ts`、四个页面的就绪标记                         | T3         | 弱网/节流下制造慢页，出现 `page_stall` 且带 Replay 与在途请求                                    |
| T5  | Todo    | 前端：三个按钮动作反馈                                                                                                                                                                                         | `lib/perf/action-tracker.ts`、选角色/发消息/充值入口                                  | T4         | 人为延迟反馈，出现 `action_stall`                                                                |
| T6  | Todo    | 看板与排查流程文档；更新 spec 与 ARCHITECTURE 的 Sentry 章节                                                                                                                                                   | Sentry Dashboards、`docs/ARCHITECTURE.md`、`.trellis/spec/frontend/app/*`             | T2–T5      | 看板按 route/tg_platform/net_type 可切分；按 `telegram_user_id` 能检索事件                       |
| T7  | Todo    | development 环境整体验收，再上 production，24 小时核对配额与首屏指标                                                                                                                                           | -                                                                                     | T1–T6      | 满足 prd 验收标准；无敏感字段（抽样）                                                            |
| T8  | Blocked | 可用性探测、`/health/deep`、定时任务心跳（R5）                                                                                                                                                                 | Sentry Uptime/Crons 或外部探测                                                        | T7         | 探测失败可见                                                                                     |
| T9  | Todo    | 飞书告警（R6），复用 `features/alerting/`                                                                                                                                                                      | `backend/src/features/alerting/`                                                      | T7 基线    | 需单独评审                                                                                       |

## Execution Log

- 2026-10-21：规划文档完成，待负责人审核。未写产品代码。
- 2026-10-21（续）：按负责人要求扩大覆盖——页面看门狗 4→17（全部页面，并加测试强制 `usePageReady` 与 `WATCHED_PAGES` 一致），关键按钮 3→9。PR #444 已开（base `dev`），Quality Gate / Docker / Vercel 预览均通过；`Ensure pr-444`（Railway 部署暂停）与 `review`（AI 审查脚本 Claude API 402）失败，均与本改动无关。
- 2026-10-21（续）：T8 部分完成。发现原有 uptime 探测指向 `st-miniapp-frontend.vercel.app` 而非用户入口 `app.themijing.com`，已新建后者（ID 2485231）但受 Sentry 额度限制处于 disabled；后端 `/health` 探测因 `*.railway.app` 达 1000 上限无法创建。详见 dashboard-and-runbook.md。
- T7（development 环境验收）因 Railway 部署暂停阻塞，未开始。
