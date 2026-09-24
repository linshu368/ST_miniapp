---
module_id: backend.infrastructure.runtime-data-security
title: 运行时、鉴权与数据访问基建
scope: backend
category: infrastructure
status: active
owners: [backend]
last_verified_task: .trellis/tasks/09-11-batch-lab-integration-spec/
last_verified_at: 2026-09-17
---

# 运行时、鉴权与数据访问基建

## 职责与边界

## 当前状态

Supabase 按域访问，服务日志使用 Pino；模型目录由 `platform/model-tiers.ts` 集中读取 `llm_model_catalog`，损坏时降级到 `DEFAULT_CATALOG`，不再读取旧 tiers key。PostHog capture 使用 `POSTHOG_API_KEY`/`POSTHOG_HOST`/`POSTHOG_TIMEOUT_MS`，缺 key 或非法 host 时 no-op。

## 入口与调用者

## 涉及文件

| 路径                                                               | 职责                                     |
| ------------------------------------------------------------------ | ---------------------------------------- |
| `packages/backend/src/lib/supabase.ts`                             | 按域数据库 client                        |
| `packages/backend/src/platform/runtime-config.ts`                  | DB 运行配置入口                          |
| `packages/backend/src/platform/model-tiers.ts`                     | 模型目录读取/缓存                        |
| `packages/backend/src/middleware/auth.ts`                          | Telegram 鉴权                            |
| `packages/backend/src/lib/supabase.ts`                             | 按域数据库 client                        |
| `packages/backend/src/infrastructure/repositories/`                | 数据访问实现                             |
| `packages/backend/src/infrastructure/telemetry/posthog-capture.ts` | 服务端 PostHog capture、短超时、终态去重 |

## 关键实现链路

PostHog capture 用 Node 原生 fetch、短超时、无重试；支付按 `order_id:status:settled_by` 去重，图片按 `attempt_id:event:terminal_status|charge_status` 去重。

## 数据、契约与外部依赖

## 关键节点与约束

## 验证方式

## 已知缺口与待核验项

## 关联模块

`database.infrastructure.schema-security`、`database.business.conversation-storage`、`shared.business.conversation-contracts`、`backend.business.conversation-generation`,`backend.business.wallet-payment`。

## 变更记录

提供配置、Telegram/运营鉴权、域数据库 client、repository、日志、后台任务基座，以及非关键服务端 PostHog capture。不拥有具体业务状态机。

- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）记录 PostHog capture 泛化为服务端非关键终态事件；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
- 2026-09-23：任务 `Admin VIP media configuration`（`.trellis/tasks/archive/2026-09/09-23-admin-vip-media-config/`）Admin ?? VIP ??????????????????/????????????；commit：`5413afeaae67e9ef168831ec050d3b8514df33dd`。
