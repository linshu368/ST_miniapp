---
module_id: backend.business.conversation-generation
title: 会话与生成
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/09-17-image-generation-posthog-plan/
last_verified_at: 2026-09-18
---

# 会话与生成

## 职责与边界

## 当前状态

自研会话链路已上线。图片生成代码已落地但 runtime 开关默认关闭：默认路径由 DeepSeek 写中文分镜，自定义路径保留用户中文稿，两路均在 worker 中直译英文后优先调用 Grok/Liaobots；主通道失败时以相同内容降级到 Replicate Z 模型，成功转存 Storage 后才原子结算。图片描述完成/失败、出图受理、worker 成功/失败终态经 `ImageGenerationTelemetry` 异步发送安全事件；结算响应未知不发送成功或失败事件。真实上游与生产开放仍待环境验收。

## 入口与调用者

## 涉及文件

| 路径                                                              | 职责                              |
| ----------------------------------------------------------------- | --------------------------------- |
| `packages/backend/src/routes/conversations.ts`                    | HTTP/SSE 入口                     |
| `packages/backend/src/features/conversations/`                    | 轮次编排                          |
| `packages/backend/src/features/generation/`                       | 生成与计费出口                    |
| `packages/backend/src/features/image/`                            | 图片任务编排与 telemetry observer |
| `packages/backend/src/features/image/ImageGenerationTelemetry.ts` | 图片生成安全事件 observer         |
| `packages/backend/src/routes/images.ts`                           | 图片 HTTP 入口                    |

## 关键实现链路

聊天链路保持“鉴权 → 原子开轮 → SSE → history/计费收口”。图片链路为“ownership/回复资格 → 中文稿 → pending attempt → DB 租约 → DeepSeek 直译 → provider dispatch 边界 → Grok（失败则 Z 降级）→ Storage → `settle_image_generation` 原子扣费与 current ready”；同一 provider 写请求不重试，Replicate 只轮询已创建 prediction。PostHog observer 只在状态写入成功后 fire-and-forget。

## 数据、契约与外部依赖

消费 shared conversations/images/telemetry 契约、experience 会话与图片 attempt、OpenRouter、DeepSeek、Grok/Liaobots、Replicate Z、Supabase Storage 和服务端 PostHog capture。

## 关键节点与约束

流前错误使用 HTTP；响应头发出后使用流内 error。聊天与图片上游适配不得旁路 `features/generation`。图片 provider 前租约可恢复；Grok 失败只允许切换一次 Z，Z dispatch 后结果未知必须失败关闭。结算明确余额不足删除对象，结算响应未知则保留对象和 storing 状态待幂等对账，且不发送 PostHog 终态事件。事件不得包含 prompt 正文、图片 URL、Storage path、provider request id 或错误 body。

## 验证方式

`pnpm --filter @miniapp/backend typecheck && pnpm --filter @miniapp/backend test`；真实上游、PostHog Preview 和 SSE 缓冲使用可重复人工回归，已删除的 `mvp:regression` 不再使用。

## 已知缺口与待核验项

角色卡更多人设字段和自建预设格式仍待后续任务；图片真实 DeepSeek/Grok、Storage、重启/并发、PostHog Preview 事件与发布观测仍待 test 环境验收。

## 关联模块

`frontend.business.conversation-ui`、`backend.infrastructure.runtime-data-security`、`shared.business.conversation-contracts`、`database.business.conversation-storage`。

## 变更记录

- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）写入图片描述/受理/worker 终态 PostHog observer；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
- 2026-09-23：任务 `Fix live free quota refresh in chat`（`.trellis/tasks/archive/2026-09/09-23-fix-chat-free-quota-refresh/`）??????????????????????????????????；commit：`5413afeaae67e9ef168831ec050d3b8514df33dd`。
