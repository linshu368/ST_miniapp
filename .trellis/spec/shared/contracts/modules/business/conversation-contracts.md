---
module_id: shared.business.conversation-contracts
title: 会话与语音共享契约
scope: shared
category: business
status: active
owners: [shared]
last_verified_task: .trellis/tasks/09-11-package-spec-module-sync/
last_verified_at: 2026-09-11
---

# 会话与语音共享契约

## 职责与边界

定义会话、SSE、生成配置和语音消息的跨进程数据形状，不包含业务执行。

## 当前状态

Backend 与 Frontend 已共同消费统一契约；模型只保留 catalog 契约，旧 tiers 契约和端点已删除。

## 入口与调用者

由 shared 根出口导出，供两个消费者编译期与运行时校验。

## 涉及文件

| 路径                                       | 职责             |
| ------------------------------------------ | ---------------- |
| `packages/shared/src/api/conversations.ts` | 会话与 SSE DTO   |
| `packages/shared/src/api/voice.ts`         | 语音 DTO         |
| `packages/shared/src/api/models.ts`        | 模型 catalog DTO |
| `packages/shared/src/index.ts`             | 公共出口         |

## 关键实现链路

Zod/schema 与类型 → Backend 校验/响应 → Frontend client 与状态处理。

## 数据、契约与外部依赖

仅依赖 Zod；不得暴露数据库 row。

## 关键节点与约束

流事件 start/delta/done/error 语义必须保持消费者兼容。

## 验证方式

`pnpm --filter @miniapp/shared test` 与消费者 typecheck。

## 已知缺口与待核验项

自建预设契约尚未定义。

## 关联模块

`backend.business.conversation-generation`、`frontend.business.conversation-ui`。
