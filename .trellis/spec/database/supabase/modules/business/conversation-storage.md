---
module_id: database.business.conversation-storage
title: 会话、语音与图片存储
scope: database
category: business
status: active
owners: [database]
last_verified_task: .trellis/tasks/09-11-chat-image-generation-plan/
last_verified_at: 2026-09-14
---

# 会话、语音与图片存储

## 职责与边界

维护 experience 域会话、轮次、Prompt 快照、语音和图片 attempt 元数据。

## 当前状态

多会话、revision、软删、上下文水位与原子开轮 RPC 已落地；图片 attempt、单 message active/current 唯一约束与 SKIP LOCKED 租约领取已由 test migration 落地。

## 入口与调用者

Backend conversation/voice/image repositories 通过按域 client/RPC 使用。

## 涉及文件

| 路径                                                          | 职责                                |
| ------------------------------------------------------------- | ----------------------------------- |
| `packages/shared/migrations/069_miniapp_chat_sessions.sql`    | 会话基线                            |
| `packages/shared/migrations/077_context_window.sql`           | 上下文水位                          |
| `packages/shared/migrations/080_chat_message_voice.sql`       | 语音元数据                          |
| `packages/shared/migrations/20260914_chat_message_images.sql` | 图片 attempt、租约与 Storage bucket |

## 关键实现链路

会话行锁分配 turn/revision；图片确认创建 pending，claim RPC 领取 leased，provider dispatch 后禁止自动重领，结算 RPC 收口 ready/current。

## 数据、契约与外部依赖

权威元数据位于 experience，音频与图片正文位于 Supabase Storage。

## 关键节点与约束

并发以会话行为串行点；不删除历史轮次，仅调整窗口起点。

## 验证方式

Backend repository integration 与 MVP regression。

## 已知缺口与待核验项

`chat_history.history` 容量治理仍待专项处理；图片 claim 并发、锁等待、恢复和 rollback guard 的 test 证据仍待运维验收记录。

## 关联模块

`backend.business.conversation-generation`。
