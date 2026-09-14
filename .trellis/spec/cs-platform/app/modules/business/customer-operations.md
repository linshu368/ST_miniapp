---
module_id: cs-platform.business.customer-operations
title: Telegram 回访与站内客服
scope: cs-platform
category: business
status: active
owners: [cs-platform]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# Telegram 回访与站内客服

## 职责与边界

管理画像/用户队列、Telegram 回访、群发及 MiniApp 客服会话。

## 当前状态

回访和站内客服两条隔离业务流均已落地。

## 入口与调用者

内部 CS 操作员登录后使用工作台。

## 涉及文件

| 路径                                                               | 职责       |
| ------------------------------------------------------------------ | ---------- |
| `packages/cs-platform/src/components/ConversationPanel.tsx`        | 回访会话   |
| `packages/cs-platform/src/components/BroadcastModal.tsx`           | 群发       |
| `packages/cs-platform/src/components/SupportWorkbench.tsx`         | 客服工作台 |
| `packages/cs-platform/src/components/SupportConversationPanel.tsx` | 客服会话   |

## 关键实现链路

管理员 token/operator → React Query → Backend CS API → cs_platform/Telegram。

## 数据、契约与外部依赖

依赖 shared CS/support 契约、Backend 和 Telegram Bot。

## 关键节点与约束

两条业务流的 ID/query key 不得混用；群发需确认并报告部分失败。

## 验证方式

CS typecheck/build 与 test 环境双向消息人工回归。

## 已知缺口与待核验项

本包当前无自动测试 script。

## 关联模块

`cs-platform.infrastructure.cs-client-auth`、`shared.business.engagement-support-contracts`。
