# Sentry 体验与可用性监控

## Goal

用户反馈"偶尔卡顿、点了半天才出页面、偶尔打不开，退出重进又好了"。这类问题不必现、多数不抛异常，现有 Sentry 只能看到报错，看不到"慢但成功"和"一直没出来"。

本任务用 Sentry 建立体验监控：**捕捉到卡顿行为本身**，并持续给出 p95/p99 耗时基线。飞书告警是最后一期，不在前几期范围内。

## 背景数据（2026-10-21，Sentry org `wangqiao` / project `st-miniapp`，近 14 天，production）

- 后端 Prisma 连接池超时：`Timed out fetching a new connection from the connection pool (pool timeout: 10, connection limit: 5)`，6 个 issue 合计约 4000 次，集中在 `GET /api/characters`、`/api/characters/:id`、`/api/characters/latest-badge`（大厅和详情，进页必调）。
- 5 秒以上的非对话请求按天：10-14 有 1752 次，10-18 有 4280 次，其余日子百位数。是突发性的，与"一阵一阵，刚进去最慢"吻合（推断，待本任务的埋点验证）。
- 前端 `RangeError: Maximum call stack size exceeded` 5 个 issue 合计约 800 次、79 个用户，栈指向 `packages/shared/src/telemetry/sanitize.ts` 的递归（无深度上限，被挂在 Replay 事件上）。
- chunk 加载失败（ST-MINIAPP-34）46 次；上游返回 HTML 错误页（"查询 MiniApp 用户失败：<!DOCTYPE html>"）约 390 次。
- 首屏 p75 LCP：`/` 4.4s、`/chats` 5.1s、`/create` 4.2s。普通接口 p75 约 100~250ms，p95 偶发 10s 以上，问题在长尾。
- 对话生成接口 p50 约 16s，属于大模型正常耗时，监控口径必须与普通接口分开。

## Requirements

### R1 前端体感监控（核心）

1. 每个 API 请求记录耗时、结果类型（成功/超时/断网/5xx/4xx）、`requestId`、是否被重试；超过 3 秒记为慢请求事件。`apiClient` 增加客户端超时。
2. 关键页面（大厅、会话页、聊天列表、充值）定义"可用时刻"，记录路由开始到可用的耗时；超过阈值仍未可用，上报 `page_stall`，附带未完成请求列表。
3. 关键按钮（选角色、发消息、充值）记录点击到界面反馈的耗时；超过 3 秒无反馈上报 `action_stall`。
4. 采集 INP（若当前 SDK 版本未默认采集则补上）和长任务。
5. 资源（chunk/脚本）加载失败按比例统计，带资源地址与 release。
6. 统一标签：Telegram 平台与版本、设备、网络类型与 RTT、地区、路由、release、telegram_user_id。
7. 卡顿事件作为 Sentry 事件上报，以便关联 Session Replay，支持按用户 ID 检索回看。
8. 统计"进入页面后 10 秒内的请求数与慢请求占比"，用于验证"刚进去最容易慢"的推断。

### R2 后端指标与因果定位

1. 每个路由模板的 p50/p95/p99 与错误率；SSE/对话生成接口单独口径。
2. Prisma 连接池等待与活跃数、事件循环延迟、进程内存。
3. 前后端 trace 串联：已核实**没有串起来**（前端 trace `035c37b3…` 只有 `http.client` 与 `ui.long-animation-frame` span，没有后端 `http.server` 子 span）。补 `tracePropagationTargets` 使其串联。
4. pino 请求耗时字段（AGENTS.md 已要求）。

### R3 基线与看板

- 在 Sentry 建立关键页面与关键接口的 p75/p95/p99 看板，口径按 R1/R2 的分类。
- 阈值不预设：先用新埋点跑一段时间得到基线，再定目标。

### R4 监控自身的健康（顺带修复）

- `sanitizeValue` 增加深度与节点数上限，修复栈溢出，避免监控代码丢数据或拖慢主线程。

### R5 可用性探测（后期）

- 前端首页与后端做定时探测。`/health` 目前只返回时间戳、不访问数据库，需要新增深度检查。
- Railway 定时任务（支付过期/对账/VIP 提醒/告警监控）加心跳监控。

### R6 飞书告警（最后一期）

- 复用 `packages/backend/src/features/alerting/` 与现有告警群。
- "后端不可用"类告警必须不依赖后端进程本身。

## 范围外

- 连接池根因修复（`connection_limit`/`pool_timeout`、`characters/:id` 的 4 路并发查询）：独立任务，与本任务并行，否则告警上线后会先被它刷屏。
- chunk 加载失败、HTML 错误页的根因排查：本任务只负责让它们可度量。

## 约束

- 所有上报经 `sanitizeTelemetry`；禁止 initData、token、支付信息、聊天正文、完整 API body 进入事件、日志或自定义属性。
- 外部调用必须有明确超时；新增埋点不得拖慢主线程或首屏。
- 遵守 `.trellis/spec/frontend/app/testing-quality-and-deployment.md`：Sentry Replay 现有 `maskAllText: false` 与 100% 采样"本期不改"。**与降采样诉求冲突，见待决问题 1。**
- 前端数据获取走 `src/lib/api/`；契约在 `packages/shared/src/api/*`；不跨应用 import。
- 环境变量与 DSN 不入源码。

## 已确认决策（项目负责人，2026-10-21）

1. **采样**：按建议执行。普通 trace 与 Replay 会话采样降低；慢请求、卡顿、报错事件一律全量主动上报，并带 Replay。同步更新 `.trellis/spec/frontend/app/testing-quality-and-deployment.md` 里"Replay 100% 采样本期不改"一句（已改）。`maskAllText: false` 不变。
2. **套餐**：暂不处理，遇到限制再说。R5 先按 Sentry 原生能力设计，不可用时再换外部探测。
3. **阈值**：页面卡住 4 秒（`page_stall`），按钮无反馈 2.5 秒（`action_stall`）。慢请求阈值沿用 3 秒。均为初值，跑出基线后再调。
4. **飞书告警**放最后一期，沿用现有告警群。
5. **连接池**：能解决就解决；不能的交工程。调查结论见 `research/pool-findings.md`——配置层面已经被改过，本任务不再改它，剩余的代码层优化交工程。被告警刷屏可接受。
6. **目标**：用户再反馈"哪里卡"时，能在 Sentry 里按该用户 ID 直接看到对应的卡顿事件、耗时图表和 Replay。

## 待决问题

1. 页面"可用时刻"的具体定义见 `design.md` §3.2，我按代码里的页面做了初版，需要你确认是否符合产品理解。
2. 发消息的"首字延迟"阈值未定（对话生成 p50 约 16 秒是正常的），先只采集不告警，跑出分布后再定。

## Acceptance Criteria

- [ ] 在 Sentry 能按路由、Telegram 版本、设备、网络类型、地区、release 切分页面可用耗时、请求耗时和卡住率。
- [ ] 人为制造慢请求/超时/不可用页面，能在 Sentry 看到对应事件，且带 `requestId` 与可回看的 Replay。
- [ ] 能按 telegram_user_id 检索某用户最近的卡顿事件。
- [ ] 看板给出关键页面与关键接口的 p75/p95/p99，对话生成与普通接口分开。
- [ ] 能回答"进入页面后 10 秒内是否更容易慢"。
- [ ] 栈溢出类 issue 不再产生新事件。
- [ ] 事件中无敏感字段（抽样检查）。
- [ ] 前端 typecheck/test/lint/build 与后端 typecheck/test 通过；新增埋点对首屏无可测量退化。
- [ ] 飞书告警在最后一期完成，不阻塞前几期验收。
