---
module_id: database.business.conversation-storage
title: 会话、语音与图片存储
scope: database
category: business
status: active
owners: [database]
last_verified_at: 2026-09-17
---

# 会话与语音存储

## 职责与边界

## 当前状态

## 入口与调用者

## 涉及文件

| 路径                                                          | 职责                                |
| ------------------------------------------------------------- | ----------------------------------- |
| `packages/shared/migrations/069_miniapp_chat_sessions.sql`    | 会话基线                            |
| `packages/shared/migrations/077_context_window.sql`           | 上下文水位                          |
| `packages/shared/migrations/080_chat_message_voice.sql`       | 语音元数据                          |
| `packages/shared/migrations/20260914_chat_message_images.sql` | 图片 attempt、租约与 Storage bucket |

## 关键实现链路

## 数据、契约与外部依赖

## 关键节点与约束

## 验证方式

## 已知缺口与待核验项

## 关联模块

`backend.business.conversation-generation`、`backend.infrastructure.runtime-data-security`。

## 变更记录

last_verified_task: .trellis/tasks/09-11-chat-image-generation-plan/
last_verified_at: 2026-09-14
