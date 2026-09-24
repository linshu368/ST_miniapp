---
module_id: shared.business.conversation-contracts
title: 会话、语音与图片共享契约
scope: shared
category: business
status: active
owners: [shared]
last_verified_at: 2026-09-17
---

# 会话与语音共享契约

## 职责与边界

## 当前状态

## 入口与调用者

## 涉及文件

| 路径                                       | 职责                                   |
| ------------------------------------------ | -------------------------------------- |
| `packages/shared/src/api/conversations.ts` | 会话与 SSE DTO                         |
| `packages/shared/src/api/voice.ts`         | 语音 DTO                               |
| `packages/shared/src/api/models.ts`        | 模型 catalog DTO                       |
| `packages/shared/src/api/images.ts`        | 图片 DTO 与校验                        |
| `packages/shared/src/api/telemetry.ts`     | replay context、支付与图片生成事件契约 |
| `packages/shared/src/index.ts`             | 公共出口                               |

## 关键实现链路

## 数据、契约与外部依赖

仅依赖 Zod；不得暴露数据库 row。`TELEMETRY_FORBIDDEN_PROPERTY_KEYS` 拒绝正文、`pay_url`、initData、token、图片 prompt、图片 URL、Storage path 和 provider request id 的 snake_case/camelCase 变体。
Shared 只定义浏览器可见 DTO、错误码、容量上限和 runtime validation schema，不包含数据库 row、连接串、service-role key、供应商 secret 或原始错误。

## 关键节点与约束

## 验证方式

## 已知缺口与待核验项

## 关联模块

`backend.infrastructure.runtime-data-security`、`database.infrastructure.schema-security`、`backend.business.conversation-generation`、`frontend.business.conversation-ui`、`frontend.infrastructure.client-ui-foundation`。

## 变更记录

- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）写入图片生成 telemetry 事件契约与禁止字段；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
