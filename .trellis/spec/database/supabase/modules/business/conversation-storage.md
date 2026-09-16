---
module_id: database.business.conversation-storage
title: 会话与语音存储
scope: database
category: business
status: active
owners: [database]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 会话与语音存储

## 职责与边界

维护 experience 域会话、轮次、Prompt 快照和语音元数据。

## 当前状态

多会话、revision、软删、上下文水位与原子开轮 RPC 已落地。

## 入口与调用者

Backend conversation/voice repositories 通过按域 client/RPC 使用。

## 涉及文件

| 路径                                                       | 职责       |
| ---------------------------------------------------------- | ---------- |
| `packages/shared/migrations/069_miniapp_chat_sessions.sql` | 会话基线   |
| `packages/shared/migrations/077_context_window.sql`        | 上下文水位 |
| `packages/shared/migrations/080_chat_message_voice.sql`    | 语音元数据 |

## 关键实现链路

会话行锁 → 分配 turn/revision → 写 streaming → 收口终态/语音状态。

## 数据、契约与外部依赖

权威表位于 experience，音频正文位于 Supabase Storage。

## 关键节点与约束

并发以会话行为串行点；不删除历史轮次，仅调整窗口起点。

## 验证方式

Backend repository integration 与 MVP regression。

## 已知缺口与待核验项

`chat_history.history` 容量治理仍待专项处理。

## 关联模块

`backend.business.conversation-generation`。
