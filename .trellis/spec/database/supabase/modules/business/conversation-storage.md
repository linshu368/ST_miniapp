---
module_id: database.business.conversation-storage
title: 会话、语音与图片存储
scope: database
category: business
status: active
owners: [database]
last_verified_task: .trellis/tasks/09-28-rich-text-process/
last_verified_at: 2026-09-30
---

# 会话与语音存储

## 职责与边界

## 当前状态

新发送与重生成使用 `experience.start_chat_history_*_with_current_postprocess`：在开轮事务内读取 `app_core.runtime_config` 当前正式指针、校验不可变 artifact 快照，再复用既有显式版本 wrapper 写入非空 `chat_history.postprocess_version`。旧 wrapper 的 `NULL=不绑定` 保留兼容，旧行不回填。

## 入口与调用者

## 涉及文件

| 路径                                                                                  | 职责                                |
| ------------------------------------------------------------------------------------- | ----------------------------------- |
| `packages/shared/migrations/069_miniapp_chat_sessions.sql`                            | 会话基线                            |
| `packages/shared/migrations/077_context_window.sql`                                   | 上下文水位                          |
| `packages/shared/migrations/080_chat_message_voice.sql`                               | 语音元数据                          |
| `packages/shared/migrations/20260914_chat_message_images.sql`                         | 图片 attempt、租约与 Storage bucket |
| `packages/shared/migrations/20260930_bind_current_text_postprocess_on_turn_start.sql` | 开轮原子绑定当前正式展示版本        |

## 关键实现链路

## 数据、契约与外部依赖

## 关键节点与约束

“当前”只认 `miniapp_text_postprocess_config` 指针，不使用 `MAX(version)`。配置缺失、协议错版、artifact 快照不可用或 RPC 未部署时整轮失败，不留下 history 半写；发布顺序为 migration → Backend。

## 验证方式

## 已知缺口与待核验项

## 关联模块

`backend.business.conversation-generation`、`backend.infrastructure.runtime-data-security`。

## 变更记录

last_verified_task: .trellis/tasks/09-11-chat-image-generation-plan/
last_verified_at: 2026-09-14
