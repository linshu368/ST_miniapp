---
module_id: shared.business.conversation-contracts
title: 会话、语音与图片共享契约
scope: shared
category: business
status: active
owners: [shared]
last_verified_task: .trellis/tasks/09-17-image-generation-posthog-plan/
last_verified_at: 2026-09-18
---

# 会话、语音与图片共享契约

## 职责与边界

定义会话、SSE、生成配置、语音、图片 attempt 和图片生成 telemetry 的跨进程数据形状，不包含业务执行。

## 当前状态

Backend 与 Frontend 已共同消费统一契约；图片契约包含中文稿上限、配置、描述、创建、会话聚合状态与稳定错误码，不暴露英文/provider prompt。`api/telemetry.ts` 扩展图片生成事件 union 与 `chat_image` 付费墙来源，覆盖前端用户操作、描述展示/失败、提交/受理、终态观察、预览、保存，以及后端描述/worker 终态事件。

## 入口与调用者

由 shared 根出口导出，供两个消费者编译期与运行时校验。前后端 PostHog 事件都必须先通过 `parseReplayTelemetryEvent`。

## 涉及文件

| 路径 | 职责 |
| --- | --- |
| `packages/shared/src/api/conversations.ts` | 会话与 SSE DTO |
| `packages/shared/src/api/voice.ts` | 语音 DTO |
| `packages/shared/src/api/images.ts` | 图片 DTO 与校验 |
| `packages/shared/src/api/telemetry.ts` | replay context、支付与图片生成事件契约 |
| `packages/shared/src/api/models.ts` | 模型 catalog DTO |
| `packages/shared/src/index.ts` | 公共出口 |

## 关键实现链路

Zod/schema 与类型 → Backend 校验/响应/observer → Frontend client、状态处理与 telemetry helper。事件属性只允许 ID、枚举、耗时、状态、计数和价格/尺寸摘要。

## 数据、契约与外部依赖

仅依赖 Zod；不得暴露数据库 row。`TELEMETRY_FORBIDDEN_PROPERTY_KEYS` 拒绝正文、`pay_url`、initData、token、图片 prompt、图片 URL、Storage path 和 provider request id 的 snake_case/camelCase 变体。

## 关键节点与约束

流事件 start/delta/done/error 语义必须保持消费者兼容；图片内部 leased/storing 不进入公开状态，中文稿由 shared schema 与后端共同执行。新增 telemetry 事件必须保持 browser-safe，不能把 provider 成功等同业务成功。

## 验证方式

`pnpm --filter @miniapp/shared test` 与消费者 typecheck。

## 已知缺口与待核验项

自建预设契约尚未定义；PostHog Preview 中 forbidden 字段为空仍需人工验收。

## 关联模块

`backend.business.conversation-generation`、`frontend.business.conversation-ui`、`frontend.infrastructure.client-ui-foundation`。

## 变更记录

- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）写入图片生成 telemetry 事件契约与禁止字段；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
