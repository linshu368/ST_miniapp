---
module_id: frontend.business.conversation-ui
title: 用户会话与语音界面
scope: frontend
category: business
status: active
owners: [frontend]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 用户会话与语音界面

## 职责与边界

负责会话列表、流式聊天、重生成、模型/生成偏好和语音交互展示。

## 当前状态

自研聊天 UI、SSE、工具箱和语音播放/自定义台词已落地。

## 入口与调用者

用户从 `/chats` 和 `/chat/[characterId]` 进入。

## 涉及文件

| 路径                                                    | 职责       |
| ------------------------------------------------------- | ---------- |
| `packages/frontend/src/app/chat/[characterId]/page.tsx` | 会话页     |
| `packages/frontend/src/components/chat/`                | 聊天组件   |
| `packages/frontend/src/lib/api/conversation-stream.ts`  | SSE client |

## 关键实现链路

页面/query → 会话 API → SSE start/delta/done/error → 气泡状态与缓存收敛。

## 数据、契约与外部依赖

消费 shared conversations/voice 契约和 Backend HTTP/SSE。

## 关键节点与约束

服务端状态走 React Query；组件不直接 fetch；流事件按 request/session 关联。

## 验证方式

`pnpm --filter @miniapp/frontend test && pnpm --filter @miniapp/frontend build`。

## 已知缺口与待核验项

图片设置仍为占位能力。

## 关联模块

`backend.business.conversation-generation`、`shared.business.conversation-contracts`。
