---
module_id: backend.business.conversation-generation
title: 会话与生成
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/09-11-chat-image-generation-plan/
last_verified_at: 2026-09-14
---

# 会话与生成

## 职责与边界

负责会话、消息、Prompt、SSE、LLM 生成计费及角色回复图片生成，不承载前端展示。

## 当前状态

自研会话链路已上线。图片生成代码已落地但 runtime 开关默认关闭：默认路径由 DeepSeek 写中文分镜，自定义路径保留用户中文稿，两路均在 worker 中直译英文后调用 Grok/Liaobots，成功转存 Storage 后才原子结算。真实上游与生产开放仍待环境验收。

## 入口与调用者

Frontend 调用 `/api/v1/conversations*`、generation config，以及 `/api/v1/images/config`、会话图片查询、描述和图片创建端点。

## 涉及文件

| 路径                                           | 职责           |
| ---------------------------------------------- | -------------- |
| `packages/backend/src/routes/conversations.ts` | HTTP/SSE 入口  |
| `packages/backend/src/features/conversations/` | 轮次编排       |
| `packages/backend/src/features/generation/`    | 生成与计费出口 |
| `packages/backend/src/features/image/`         | 图片任务编排   |
| `packages/backend/src/routes/images.ts`        | 图片 HTTP 入口 |

## 关键实现链路

聊天链路保持“鉴权 → 原子开轮 → SSE → history/计费收口”。图片链路为“ownership/回复资格 → 中文稿 → pending attempt → DB 租约 → DeepSeek 直译 → provider dispatch 边界 → Grok → Storage → `settle_image_generation` 原子扣费与 current ready”；provider 模糊超时不自动重投。

## 数据、契约与外部依赖

消费 shared conversations/images 契约、experience 会话与图片 attempt、OpenRouter、DeepSeek、Grok/Liaobots 和 Supabase Storage。

## 关键节点与约束

流前错误使用 HTTP；响应头发出后使用流内 error。聊天与图片上游适配不得旁路 `features/generation`。图片 provider 前租约可恢复，dispatch 后结果未知必须失败关闭；结算明确余额不足删除对象，结算响应未知则保留对象和 storing 状态待幂等对账。

## 验证方式

`pnpm --filter @miniapp/backend typecheck && pnpm --filter @miniapp/backend test`；真实上游与 SSE 缓冲使用可重复人工回归，已删除的 `mvp:regression` 不再使用。

## 已知缺口与待核验项

角色卡更多人设字段和自建预设格式仍待后续任务；图片真实 DeepSeek/Grok、Storage、重启/并发与发布观测仍待 test 环境验收。

## 关联模块

`frontend.business.conversation-ui`、`shared.business.conversation-contracts`、`database.business.conversation-storage`。
