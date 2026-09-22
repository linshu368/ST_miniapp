---
module_id: backend.infrastructure.runtime-data-security
title: 运行时、鉴权与数据访问基建
scope: backend
category: infrastructure
status: active
owners: [backend]
last_verified_task: .trellis/tasks/09-17-batch-lab-prototype-alignment/
last_verified_at: 2026-09-22
---

# 运行时、鉴权与数据访问基建

## 职责与边界

提供配置、Telegram/运营鉴权、按域数据库 client、repository、日志和后台任务基座。Batch Lab 仅作为内部调试平台接入，不反向成为真实业务域依赖。

## 当前状态

Batch Lab 原型对齐后，样本详情/软删除、实验级 purpose 与逐变体 provider/model/output preset、结果详情读取，以及草稿启动、协作停止、软删除、单次/至多 10 次批量执行均通过同一 feature route/service/repository 边界提供；浏览器不接触 `BATCH_LAB_MODEL_KEY`。

配置由 runtime config 与 `platform/config.ts` 集中解析，Supabase 按域访问，服务日志使用 Pino。Batch Lab 入口由 feature flag、精确 CORS origin、权威数据库环境和来源只读连接共同 fail closed；样本 preview 使用专用 `pg` 只读来源连接补齐权威快照，平台写入只走 `batch_lab` repository/RPC。后处理包含不可变 processor version、display result 持久化和 worker-thread regex executor。Backend execution 新增 experiment/attempt repository、worker run-once lease runner、`SKIP LOCKED` 领取和有限重试；worker 只记录内部 ID、状态、耗时/计数摘要，不记录 prompt、回复正文、token 或 secret。
Supabase 按域访问，服务日志使用 Pino；模型目录由 `platform/model-tiers.ts` 集中读取 `llm_model_catalog`，损坏时降级到 `DEFAULT_CATALOG`，不再读取旧 tiers key。PostHog capture 使用 `POSTHOG_API_KEY`/`POSTHOG_HOST`/`POSTHOG_TIMEOUT_MS`，缺 key 或非法 host 时 no-op。

## 入口与调用者

Backend routes、features、jobs 统一消费。Batch Lab 路由提供 context、SQL template、sample preview/sample set、processor version/preview、experiment 创建/启动/列表和内部 worker run-once 入口。支付终态与图片生成终态 observer 调用 `infrastructure/telemetry/posthog-capture.ts`。

## 涉及文件

| 路径                                                                              | 职责                                     |
| --------------------------------------------------------------------------------- | ---------------------------------------- |
| `packages/backend/src/platform/config.ts`                                         | Batch Lab 环境与来源配置                 |
| `packages/backend/src/lib/supabase.ts`                                            | 按域数据库 client                        |
| `packages/backend/src/features/batch-lab/source-database.ts`                      | 来源连接池与探针                         |
| `packages/backend/src/features/batch-lab/source-query.ts`                         | 来源 SQL 编译与边界检查                  |
| `packages/backend/src/features/batch-lab/sample-service.ts`                       | 样本 preview 编排                        |
| `packages/backend/src/features/batch-lab/postprocessing-service.ts`               | 后处理执行、超时终止与安全渲染           |
| `packages/backend/src/features/batch-lab/execution-service.ts`                    | 实验 worker 状态机与 generation 编排     |
| `packages/backend/src/infrastructure/repositories/BatchLabSampleRepository.ts`    | 样本持久化                               |
| `packages/backend/src/infrastructure/repositories/BatchLabProcessorRepository.ts` | processor/display result 持久化          |
| `packages/backend/src/infrastructure/repositories/BatchLabExecutionRepository.ts` | experiment/attempt 持久化与 lease        |
| `packages/backend/src/routes/batch-lab.ts`                                        | Batch Lab HTTP 边界                      |
| `packages/backend/src/platform/runtime-config.ts`                                 | DB 运行配置入口                          |
| `packages/backend/src/platform/model-tiers.ts`                                    | 模型目录读取/缓存                        |
| `packages/backend/src/middleware/auth.ts`                                         | Telegram 鉴权                            |
| `packages/backend/src/lib/supabase.ts`                                            | 按域数据库 client                        |
| `packages/backend/src/infrastructure/repositories/`                               | 数据访问实现                             |
| `packages/backend/src/infrastructure/telemetry/posthog-capture.ts`                | 服务端 PostHog capture、短超时、终态去重 |

## 关键实现链路

启动解析配置 -> route feature guard/source guard -> service 编排 -> repository/domain client -> Pino 结果摘要。Batch Lab execution 创建 draft experiment，start 时按 sample/variant/turn 冻结 attempt，worker run-once 通过数据库 lease 领取 pending work；前序失败会阻塞同样本同 variant 的后续轮次，成功事实不覆盖。
PostHog capture 用 Node 原生 fetch、短超时、无重试；支付按 `order_id:status:settled_by` 去重，图片按 `attempt_id:event:terminal_status|charge_status` 去重。

## 数据、契约与外部依赖

连接 Supabase、Redis/Sentry/PostHog 等；secret 仅服务端读取。Batch Lab 来源连接必须是专用只读 PostgreSQL 凭据，不得复用 service-role、浏览器配置或真实业务写入 client。Execution 仅写 `batch_lab` 域，不查/扣钱包，也不写 `experience.chat_history`。PostHog 事件必须先通过 shared telemetry schema 和 forbidden-key 检查。

## 关键节点与约束

外部调用必须超时；日志禁止 token、连接串、SQL 参数、敏感正文和原始数据库消息。Batch Lab 来源 SQL 限定 SELECT/WITH、allowlist 关系、绑定参数、READ ONLY 事务、statement/lock timeout、行数与字节上限。Regex processor 通过 worker thread 隔离灾难性回溯；experiment worker 通过 `FOR UPDATE SKIP LOCKED`、lease、attempt_count 和 idempotency key 控制重复启动、双 worker 与重启恢复。未配置 PostHog 时 observer 不反查 Telegram 用户。服务端 telemetry 超时、失败或重复跳过不得延迟、回滚或改变业务终态。

## 验证方式

`pnpm --filter @miniapp/backend typecheck && pnpm --filter @miniapp/backend test`，并配合 shared/batch-lab consumer typecheck。

## 已知缺口与待核验项

Batch Lab spec、Vercel Preview API base、CORS、发布顺序、停止条件和回滚剧本已收口到 `.trellis/spec/batch-lab/app/`；真实来源 LOGIN/secret 验证、production migration 执行和 worker 常驻调度仍需目标环境人工授权记录。`pnpm lint:imports` 当前仍受仓库 ESLint 命令 `--rule '{}'` 解析问题影响。打开生产 PostHog 是独立运维步骤。

## 关联模块

`database.infrastructure.schema-security`、`database.business.conversation-storage`、`shared.business.conversation-contracts`、`backend.business.conversation-generation`,`backend.business.wallet-payment`。

## 变更记录

- 2026-09-16：任务 `Batch Lab Backend 实验与生成执行`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-backend-execution/`）更新模块知识文档；commit：`1316d11e29cd120e61be456cb93f4795d489af9b`。
- 2026-09-17：任务 `Batch Lab 集成验收、发布与 Spec 收口`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-integration-spec/`）收口 Batch Lab integration/spec、发布回滚、环境与剩余人工核验事实；提交前归档，见本任务后续 Git 提交。
  提供配置、Telegram/运营鉴权、域数据库 client、repository、日志、后台任务基座，以及非关键服务端 PostHog capture。不拥有具体业务状态机。
- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）记录 PostHog capture 泛化为服务端非关键终态事件；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
- 2026-09-22：任务 `Batch Lab 原型一致性修复规划`（`.trellis/tasks/archive/2026-09/09-17-batch-lab-prototype-alignment/`）补充 Batch Lab 原型对齐后的当前实现事实；commit：`212942339cb51b2419b01149828a1b4ec78074d7`。
