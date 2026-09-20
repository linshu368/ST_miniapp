---
module_id: backend.infrastructure.runtime-data-security
title: 运行时、鉴权与数据访问基建
scope: backend
category: infrastructure
status: active
owners: [backend]
last_verified_task: .trellis/tasks/09-17-image-generation-posthog-plan/
last_verified_at: 2026-09-18
---

# 运行时、鉴权与数据访问基建

## 职责与边界

提供配置、Telegram/运营鉴权、域数据库 client、repository、日志、后台任务基座，以及非关键服务端 PostHog capture。不拥有具体业务状态机。

## 当前状态

配置与 runtime config 已集中，Supabase 按域访问，服务日志使用 Pino；模型目录由 `platform/model-tiers.ts` 集中读取 `llm_model_catalog`，损坏时降级到 `DEFAULT_CATALOG`，不再读取旧 tiers key。PostHog capture 使用 `POSTHOG_API_KEY`/`POSTHOG_HOST`/`POSTHOG_TIMEOUT_MS`，缺 key 或非法 host 时 no-op。

## 入口与调用者

Backend routes、features、jobs 统一消费。支付终态与图片生成终态 observer 调用 `infrastructure/telemetry/posthog-capture.ts`。

## 涉及文件

| 路径                                                               | 职责                                     |
| ------------------------------------------------------------------ | ---------------------------------------- |
| `packages/backend/src/platform/config.ts`                          | 环境配置解析                             |
| `packages/backend/src/platform/runtime-config.ts`                  | DB 运行配置入口                          |
| `packages/backend/src/platform/model-tiers.ts`                     | 模型目录读取/缓存                        |
| `packages/backend/src/middleware/auth.ts`                          | Telegram 鉴权                            |
| `packages/backend/src/lib/supabase.ts`                             | 按域数据库 client                        |
| `packages/backend/src/infrastructure/repositories/`                | 数据访问实现                             |
| `packages/backend/src/infrastructure/telemetry/posthog-capture.ts` | 服务端 PostHog capture、短超时、终态去重 |

## 关键实现链路

启动解析配置 → route 鉴权 → feature → repository/domain client → Pino 结果摘要。PostHog capture 用 Node 原生 fetch、短超时、无重试；支付按 `order_id:status:settled_by` 去重，图片按 `attempt_id:event:terminal_status|charge_status` 去重。

## 数据、契约与外部依赖

连接 Supabase、Redis/Sentry/PostHog 等；secret 仅服务端读取。PostHog 事件必须先通过 shared telemetry schema 和 forbidden-key 检查。

## 关键节点与约束

外部调用必须超时；日志禁止 token/敏感正文/`pay_url`/initData。未配置 PostHog 时 observer 不反查 Telegram 用户。服务端 telemetry 超时、失败或重复跳过不得延迟、回滚或改变业务终态。

## 验证方式

`pnpm --filter @miniapp/backend typecheck && pnpm --filter @miniapp/backend test`。

## 已知缺口与待核验项

部署控制台遗留资源仍需人工清理；打开生产 PostHog 是独立运维步骤。

## 关联模块

`backend.business.conversation-generation`、`backend.business.wallet-payment`、`database.infrastructure.schema-security`。

## 变更记录

- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）记录 PostHog capture 泛化为服务端非关键终态事件；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
