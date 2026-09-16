---
module_id: backend.infrastructure.runtime-data-security
title: 运行时、鉴权与数据访问基建
scope: backend
category: infrastructure
status: active
owners: [backend]
last_verified_task: .trellis/tasks/09-11-batch-lab-backend-execution/
last_verified_at: 2026-09-16
---

# 运行时、鉴权与数据访问基建

## 职责与边界

提供配置、Telegram/运营鉴权、按域数据库 client、repository、日志和后台任务基座。Batch Lab 仅作为内部调试平台接入，不反向成为真实业务域依赖。

## 当前状态

配置由 runtime config 与 `platform/config.ts` 集中解析，Supabase 按域访问，服务日志使用 Pino。Batch Lab 入口由 feature flag、精确 CORS origin、权威数据库环境和来源只读连接共同 fail closed；样本 preview 使用专用 `pg` 只读来源连接补齐权威快照，平台写入只走 `batch_lab` repository/RPC。后处理包含不可变 processor version、display result 持久化和 worker-thread regex executor。Backend execution 新增 experiment/attempt repository、worker run-once lease runner、`SKIP LOCKED` 领取和有限重试；worker 只记录内部 ID、状态、耗时/计数摘要，不记录 prompt、回复正文、token 或 secret。

## 入口与调用者

Backend routes、features、jobs 统一消费。Batch Lab 路由提供 context、SQL template、sample preview/sample set、processor version/preview、experiment 创建/启动/列表和内部 worker run-once 入口。

## 涉及文件

| 路径                                                                              | 职责                                 |
| --------------------------------------------------------------------------------- | ------------------------------------ |
| `packages/backend/src/platform/config.ts`                                         | Batch Lab 环境与来源配置             |
| `packages/backend/src/lib/supabase.ts`                                            | 按域数据库 client                    |
| `packages/backend/src/features/batch-lab/source-database.ts`                      | 来源连接池与探针                     |
| `packages/backend/src/features/batch-lab/source-query.ts`                         | 来源 SQL 编译与边界检查              |
| `packages/backend/src/features/batch-lab/sample-service.ts`                       | 样本 preview 编排                    |
| `packages/backend/src/features/batch-lab/postprocessing-service.ts`               | 后处理执行、超时终止与安全渲染       |
| `packages/backend/src/features/batch-lab/execution-service.ts`                    | 实验 worker 状态机与 generation 编排 |
| `packages/backend/src/infrastructure/repositories/BatchLabSampleRepository.ts`    | 样本持久化                           |
| `packages/backend/src/infrastructure/repositories/BatchLabProcessorRepository.ts` | processor/display result 持久化      |
| `packages/backend/src/infrastructure/repositories/BatchLabExecutionRepository.ts` | experiment/attempt 持久化与 lease    |
| `packages/backend/src/routes/batch-lab.ts`                                        | Batch Lab HTTP 边界                  |

## 关键实现链路

启动解析配置 -> route feature guard/source guard -> service 编排 -> repository/domain client -> Pino 结果摘要。Batch Lab execution 创建 draft experiment，start 时按 sample/variant/turn 冻结 attempt，worker run-once 通过数据库 lease 领取 pending work；前序失败会阻塞同样本同 variant 的后续轮次，成功事实不覆盖。

## 数据、契约与外部依赖

连接 Supabase、Redis/Sentry 等；secret 仅服务端读取。Batch Lab 来源连接必须是专用只读 PostgreSQL 凭据，不得复用 service-role、浏览器配置或真实业务写入 client。Execution 仅写 `batch_lab` 域，不查/扣钱包，也不写 `experience.chat_history`。

## 关键节点与约束

外部调用必须超时；日志禁止 token、连接串、SQL 参数、敏感正文和原始数据库消息。Batch Lab 来源 SQL 限定 SELECT/WITH、allowlist 关系、绑定参数、READ ONLY 事务、statement/lock timeout、行数与字节上限。Regex processor 通过 worker thread 隔离灾难性回溯；experiment worker 通过 `FOR UPDATE SKIP LOCKED`、lease、attempt_count 和 idempotency key 控制重复启动、双 worker 与重启恢复。

## 验证方式

`pnpm --filter @miniapp/backend typecheck && pnpm --filter @miniapp/backend test`，并配合 shared/batch-lab consumer typecheck。

## 已知缺口与待核验项

Batch Lab 真实来源 LOGIN/secret 验证、execution migration 执行和 worker 常驻调度需要 integration-spec 统筹；当前提供 run-once 内部入口和可复用 service。`pnpm lint:imports` 当前仍受仓库 ESLint 命令 `--rule '{}'` 解析问题影响。

## 关联模块

`database.infrastructure.schema-security`、`database.business.conversation-storage`、`shared.business.conversation-contracts`、`backend.business.conversation-generation`。

## 变更记录

- 2026-09-16：任务 `Batch Lab Backend 实验与生成执行`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-backend-execution/`）更新模块知识文档；commit：`1316d11e29cd120e61be456cb93f4795d489af9b`。
