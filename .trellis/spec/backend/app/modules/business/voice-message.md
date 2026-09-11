---
module_id: backend.business.voice-message
title: 角色回复语音
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 角色回复语音

## 职责与边界

生成角色回复台词和 TTS 音频，维护异步状态；不负责普通文字生成。

## 当前状态

DeepSeek 写稿、MiniMax TTS、Storage 落盘、重生成和当前语音查询已实现。

## 入口与调用者

Frontend 会话气泡和自定义台词页调用 `/api/v1/.../voice`。

## 涉及文件

| 路径                                                                             | 职责       |
| -------------------------------------------------------------------------------- | ---------- |
| `packages/backend/src/routes/voice.ts`                                           | 语音 API   |
| `packages/backend/src/features/voice/`                                           | 语音流水线 |
| `packages/backend/src/infrastructure/repositories/ChatMessageAudioRepository.ts` | 状态持久化 |

## 关键实现链路

ownership/配置 → pending → 写稿或自定义文本 → TTS → Storage → ready/failed。

## 数据、契约与外部依赖

依赖 experience.chat_message_audio、Storage、DeepSeek、MiniMax 和 shared voice 契约。

## 关键节点与约束

上游调用必须超时；重生成与并发受唯一约束；计费状态以当前代码/migration 为准。

## 验证方式

Voice feature、route、repository tests。

## 已知缺口与待核验项

真实上游时序和移动端音频播放需人工验证。

## 关联模块

`frontend.business.conversation-ui`、`shared.business.conversation-contracts`。
