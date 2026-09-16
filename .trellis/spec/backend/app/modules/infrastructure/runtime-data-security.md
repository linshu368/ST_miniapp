---
module_id: backend.infrastructure.runtime-data-security
title: 运行时、鉴权与数据访问基建
scope: backend
category: infrastructure
status: active
owners: [backend]
last_verified_task: .trellis/tasks/09-11-batch-lab-data-samples/
last_verified_at: 2026-09-16
---

# 运行时、鉴权与数据访问基建

## 职责与边界

提供配置、Telegram/运营鉴权、域数据库 client、repository、日志和后台任务基座。

## 当前状态

配置与 runtime config 已集中，Supabase 按域访问，服务日志使用 Pino；模型目录由 `platform/model-tiers.ts` 集中读取 `llm_model_catalog`，损坏时降级到 `DEFAULT_CATALOG`，不再读取旧 tiers key。Batch Lab 入口由 feature flag、精确 CORS origin 与权威数据库环境共同 fail closed；样本 preview 使用专用 `pg` 只读来源连接读取锚点快照，平台写入只走 `batch_lab` repository/RPC。

## 入口与调用者

Backend routes、features、jobs 统一消费。

## 涉及文件

| 路径                                                                           | 职责                    |
| ------------------------------------------------------------------------------ | ----------------------- |
| `packages/backend/src/platform/config.ts`                                      | 环境与 Batch Lab 配置   |
| `packages/backend/src/platform/runtime-config.ts`                              | DB 运行配置入口         |
| `packages/backend/src/platform/model-tiers.ts`                                 | 模型目录读取/缓存       |
| `packages/backend/src/middleware/auth.ts`                                      | Telegram 鉴权           |
| `packages/backend/src/lib/supabase.ts`                                         | 按域数据库 client       |
| `packages/backend/src/features/batch-lab/source-config.ts`                     | Batch Lab 来源配置      |
| `packages/backend/src/features/batch-lab/source-database.ts`                   | 来源连接池与探针        |
| `packages/backend/src/features/batch-lab/source-query.ts`                      | 来源 SQL 编译与有界查询 |
| `packages/backend/src/features/batch-lab/sample-service.ts`                    | 样本 preview 编排       |
| `packages/backend/src/infrastructure/repositories/BatchLabSampleRepository.ts` | Batch Lab 样本持久化    |
| `packages/backend/src/infrastructure/repositories/`                            | 其他数据访问实现        |

## 关键实现链路

启动解析配置 → route 鉴权/feature guard → feature → repository/domain client → Pino 结果摘要。Batch Lab preview 先编译只读 SQL 锚点查询，再用来源只读连接补齐权威快照，最后通过 `batch_lab` RPC 持久化 preview 或冻结样本集。

## 数据、契约与外部依赖

连接 Supabase、Redis/Sentry 等；secret 仅服务端读取。Batch Lab 来源连接必须是专用只读 PostgreSQL 凭据，不得复用 service-role、浏览器配置或真实业务写入 client。

## 关键节点与约束

外部调用必须超时；日志禁止 token/敏感正文；跨域访问走 RPC/repository/API。Batch Lab 来源 SQL 限定 SELECT/WITH、allowlist 关系、绑定参数、READ ONLY 事务、statement/lock timeout、行数与字节上限；失败响应不得泄露连接串、endpoint、SQL 参数或原始数据库消息。

## 验证方式

`pnpm --filter @miniapp/backend typecheck && pnpm --filter @miniapp/backend test`。

## 已知缺口与待核验项

部署控制台遗留资源仍需人工清理。Batch Lab 真实来源 LOGIN/secret 验证必须单独授权；失败时立即撤 URI/NOLOGIN，不用离线测试冒充真实连通。

## 关联模块

`database.infrastructure.schema-security`。

## 变更记录

- 2026-09-16：任务 `Batch Lab 数据库域、环境与样本集`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-data-samples/`）更新模块知识文档；commit：`14124a5b9df62627bb9fddfd722194206a0aa83b`。
