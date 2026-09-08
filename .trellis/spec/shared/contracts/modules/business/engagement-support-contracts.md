---
module_id: shared.business.engagement-support-contracts
title: 互动、通知与客服契约
scope: shared
category: business
status: active
owners: [shared]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 互动、通知与客服契约

## 职责与边界

定义许愿、社区/邀请、通知、用户客服及 CS 运营接口形状。

## 当前状态

Frontend、Backend、Admin 与 CS Platform 按各自接口消费。

## 入口与调用者

由 shared 根出口导出到应用包。

## 涉及文件

| 路径                                       | 职责     |
| ------------------------------------------ | -------- |
| `packages/shared/src/api/wishes.ts`        | 许愿 DTO |
| `packages/shared/src/api/community.ts`     | 社区 DTO |
| `packages/shared/src/api/notifications.ts` | 通知 DTO |
| `packages/shared/src/api/support.ts`       | 客服 DTO |
| `packages/shared/src/api/cs-platform.ts`   | CS DTO   |

## 关键实现链路

契约 → Backend route → 用户端/运营端 query helper。

## 数据、契约与外部依赖

不得包含 token、消息数据库行或内部审计实现。

## 关键节点与约束

分页、消息状态和部分失败语义需在 producer/consumer 一致。

## 验证方式

Shared tests 与四个消费者 typecheck。

## 已知缺口与待核验项

跨 Telegram 能力的供应商响应不进入公开契约。

## 关联模块

`backend.business.engagement-support`、`frontend.business.engagement-support`、`cs-platform.business.telegram-outreach`。
