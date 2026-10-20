---
module_id: shared.business.conversation-contracts
title: 会话、语音与图片共享契约
scope: shared
category: business
status: active
owners: [shared]
last_verified_task: .trellis/tasks/10-10-image-plaza-v2/
last_verified_at: 2026-10-13
---

# 会话与语音共享契约

## 职责与边界

## 当前状态

取消契约 CancelConversationTurnRequest {assistant_message_id:string} 与 CancelConversationTurnData {message:ChatMessage}；新 POST /api/v1/conversations/:id/cancel 采用既有 envelope，返回实际终态，待确认以错误表示。原 SSE 字段和消息状态兼容保留，producer-first 发布。

## 入口与调用者

## 涉及文件

| 路径                                       | 职责                                   |
| ------------------------------------------ | -------------------------------------- |
| `packages/shared/src/api/conversations.ts` | 会话与 SSE DTO                         |
| `packages/shared/src/api/voice.ts`         | 语音 DTO                               |
| `packages/shared/src/api/models.ts`        | 模型 catalog DTO                       |
| `packages/shared/src/api/images.ts`        | 图片 DTO 与校验                        |
| `packages/shared/src/api/telemetry.ts`     | replay context、支付与图片生成事件契约 |
| `packages/shared/src/index.ts`             | 公共出口                               |

## 关键实现链路

## 数据、契约与外部依赖

仅依赖 Zod；不得暴露数据库 row。`TELEMETRY_FORBIDDEN_PROPERTY_KEYS` 拒绝正文、`pay_url`、initData、token、图片 prompt、图片 URL、Storage path 和 provider request id 的 snake_case/camelCase 变体。
Shared 只定义浏览器可见 DTO、错误码、容量上限和 runtime validation schema，不包含数据库 row、连接串、service-role key、供应商 secret 或原始错误。
图片契约只公开普通图片配置与 `basic_image` 免费次数/结算预览；旧客户端携带的 tier 输入会被兼容剥离。历史 attempt 的 tier 字段暂留只读兼容，不再公开高级图片 capability、门禁错误或双档位配置。

## 关键节点与约束

## 验证方式

## 已知缺口与待核验项

## 关联模块

`backend.infrastructure.runtime-data-security`、`database.infrastructure.schema-security`、`backend.business.conversation-generation`、`frontend.business.conversation-ui`、`frontend.infrastructure.client-ui-foundation`。

## 图片创作广场 V2（2026-10-12）

`api/image-plaza.ts` 定义模型目录、配置、瀑布流、作品、会话、报价、attempt、参考图、点赞与分享 DTO/Zod schema。公开模型不暴露 provider model id/internal tags，参考图请求只接受当前用户 artifact id，不接受任意远端 URL。

图片广场提示词长度统一为最多 2000 字，快照、生成提交和前端输入共享同一常量。Civitai Image ID、源 URL 与源热度属于内部导入元数据，不进入公开 feed/detail DTO；对外热度仍使用站内 `like_count`。

## 变更记录

- 2026-10-13：任务 `10-10-image-plaza-v2` 将提示词上限统一为 2000 字，并明确种子来源字段不公开。

- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）写入图片生成 telemetry 事件契约与禁止字段；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）删除无法恢复的乱码变更记录；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。
