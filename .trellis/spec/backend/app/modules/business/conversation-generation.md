---
module_id: backend.business.conversation-generation
title: 会话与生成
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 会话与生成

## 职责与边界

负责会话、消息、Prompt、SSE 与 LLM 生成计费，不承载前端展示。

## 当前状态

自研会话链路已上线，生成与计费统一走 generation。

## 入口与调用者

Frontend 调用 `/api/v1/conversations*` 与 generation config。

## 涉及文件

| 路径                                           | 职责           |
| ---------------------------------------------- | -------------- |
| `packages/backend/src/routes/conversations.ts` | HTTP/SSE 入口  |
| `packages/backend/src/features/conversations/` | 轮次编排       |
| `packages/backend/src/features/generation/`    | 生成与计费出口 |

## 关键实现链路

鉴权与 ownership → 原子开轮 → 上下文/Prompt → 上游 SSE → history 与计费终态。

## 数据、契约与外部依赖

消费 shared conversations 契约、experience 会话数据和 OpenRouter。

## 关键节点与约束

流前错误使用 HTTP；响应头发出后使用流内 error；生成计费不得旁路。

## 验证方式

`pnpm --filter @miniapp/backend test`；按需运行 `mvp:regression`。

## 已知缺口与待核验项

角色卡更多人设字段和自建预设格式仍待后续任务。

## 关联模块

`frontend.business.conversation-ui`、`shared.business.conversation-contracts`、`database.business.conversation-storage`。
