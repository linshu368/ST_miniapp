# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                     | Files / Scope    | Depends On | Verification                     |
| --- | ------ | -------------------------------------------------------- | ---------------- | ---------- | -------------------------------- |
| T0  | Done   | 审核 PRD/design/implement、路由层级、按钮边界与 2 秒口径 | task docs        | -          | 规划门禁通过并已 `task.py start` |
| T1  | Done   | 扩展既有关键 action 的安全 Grafana 投影                  | frontend perf    | T0         | 既有 tests/typecheck             |
| T2  | Done   | 二级页面与三级页面两份 dashboard                         | docs/grafana     | T0         | JSON/LogQL/口径检查              |
| T3  | Done   | 关键按钮 dashboard                                       | docs/grafana     | T1         | JSON/LogQL + 虚构样本            |
| T4  | Done   | 非流式 API dashboard                                     | docs/grafana     | T0         | JSON/LogQL/PromQL                |
| T5  | Done   | SSE/流式 API dashboard                                   | docs/grafana     | T0         | send/regenerate/NDJSON 分区检查  |
| T6  | Done   | Runbook、全量验证与发布后验收说明                        | docs/tests/build | T1-T5      | implement.md 命令                |

## Execution Log

- 2026-11-05：完成源码/既有 dashboard/历史基线调研；确认页面、API、聊天与 creator polish 大部分数据可直接复用，只有非角色关键 action 缺少 Grafana 投影。
- 2026-11-05：完成规划审核并启动任务；按明确白名单冻结 route/entry，不增加全局 listener 或业务请求。
- 2026-11-06：完成二级页面、三级页面、按钮、非流式 API、SSE/NDJSON 五张 dashboard source 与 runbook；所有九个关键 action 均有安全 Grafana 投影。
- 2026-11-06：将 `grafana.ts` 的有界属性白名单拆分后降至 486 行，并收紧复杂度基线；同时修复四处阻断 Trellis module baseline 的失效路径引用。
- 2026-11-06：全量 frontend test 63 files / 719 tests、拆分后定向 3 files / 51 tests、typecheck、lint、complexity、build、module knowledge check 均通过；lint/build 仅保留仓库既有 warning。
- 2026-11-06：dashboard JSON、变量引用、UID/panel ID、敏感字段和完整流 2 秒边界静态检查通过。Docker 未安装，`faro-loki.mjs` 无法执行真实 Loki 语法验证；Grafana Cloud 导入与生产实收按任务边界留待发布后验收。
