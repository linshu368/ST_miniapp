---
module_id: backend.business.engagement-support
title: 许愿、社区、消息与客服
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 许愿、社区、消息与客服

## 职责与边界

负责许愿池、邀请/社区奖励、站内通知和用户客服会话。

## 当前状态

主要互动 API 已实现，奖励写入使用业务唯一键和原子钱包流水。

## 入口与调用者

Frontend profile、通知与客服页面调用对应 `/api/*`。

## 涉及文件

| 路径                                           | 职责     |
| ---------------------------------------------- | -------- |
| `packages/backend/src/routes/wishes.ts`        | 许愿 API |
| `packages/backend/src/routes/community.ts`     | 社区奖励 |
| `packages/backend/src/routes/notifications.ts` | 消息中心 |
| `packages/backend/src/routes/support.ts`       | 用户客服 |

## 关键实现链路

用户鉴权 → 业务校验/幂等 → repository/RPC → 通知或客服响应。

## 数据、契约与外部依赖

依赖 miniapp_features、cs_platform、billing 和 shared 互动契约。

## 关键节点与约束

奖励不可由前端去重充当真相；客服内容不得进入普通遥测。

## 验证方式

对应 route/repository tests 与 Frontend 人工回归。

## 已知缺口与待核验项

跨 Telegram 官方社区成员状态依赖外部 API 可用性。

## 关联模块

`frontend.business.engagement-support`、`database.business.engagement-support-data`。
