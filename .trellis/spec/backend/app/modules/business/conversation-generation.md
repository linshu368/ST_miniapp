---
module_id: backend.business.conversation-generation
title: 会话与生成
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/09-28-rich-text-process/
last_verified_at: 2026-09-30
---

# 会话与生成

## 职责与边界

## 当前状态

文字回复新增基于数据库标记的显式取消；生成计费前抢占没有取消标记的 streaming 终态。取消先释放免费额度，再确认 interrupted；上下文/上游异常统一恢复，详情读取回收过期生成。执行副本未确认时取消返回可重试待确认。无需 migration，真实 TEST/Preview SSE、钱包/额度及真机验收仍未执行。

AI 回复后处理版本在 Backend 监听前预热，开轮只读进程缓存并绑定明确版本；后台刷新失败时沿用最近有效版本，无缓存时静默绑定 `NULL` 并保留原 Markdown。富文本配置故障不阻断生成、计费或流式输出。

自研会话链路已上线。图片生成代码已落地但 runtime 开关默认关闭：当前只保留单一普通图片路径，由 DeepSeek 写中文分镜或保留用户中文稿，在 worker 中直译英文后优先调用 Grok/Liaobots，主通道失败时以相同内容降级到 Replicate Z。普通图片继续使用 `basic_image` 免费次数，耗尽后按普通价格结算；高级图片入口、provider 分流、VIP 门禁与高级价格已退场。图片 telemetry 与结算未知语义保持不变。

## 入口与调用者

## 涉及文件

| 路径                                                              | 职责                              |
| ----------------------------------------------------------------- | --------------------------------- |
| `packages/backend/src/routes/conversations.ts`                    | HTTP/SSE 入口                     |
| `packages/backend/src/features/conversations/`                    | 轮次编排                          |
| `packages/backend/src/features/generation/`                       | 生成与计费出口                    |
| `packages/backend/src/features/text-postprocess/config.ts`        | 回复后处理版本预热与后台刷新      |
| `packages/backend/src/features/image/`                            | 图片任务编排与 telemetry observer |
| `packages/backend/src/features/image/ImageGenerationTelemetry.ts` | 图片生成安全事件 observer         |
| `packages/backend/src/routes/images.ts`                           | 图片 HTTP 入口                    |

## 关键实现链路

图片链路为“ownership/回复资格 → 普通图片免费名额预留或付费预检 → 中文稿 → pending attempt → DB 租约 → DeepSeek 直译 → Grok（失败则 Z 降级）→ Storage → `settle_image_generation` 原子消费免费次数或扣费并置 current ready”。旧客户端的 tier 输入被兼容忽略，新 attempt 固定为 basic。

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
