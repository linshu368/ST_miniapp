---
module_id: frontend.infrastructure.client-ui-foundation
title: API、Telegram 与 UI 基建
scope: frontend
category: infrastructure
status: active
owners: [frontend]
last_verified_task: .trellis/tasks/09-17-image-generation-posthog-plan/
last_verified_at: 2026-09-18
---

# API、Telegram 与 UI 基建

## 职责与边界

提供统一 REST client、Query provider、Telegram runtime、Zustand 状态、通用 UI，以及受控 PostHog Session Replay adapter。不拥有业务生成或支付结算。

## 当前状态

API 与 server state 已集中，Tailwind/shadcn 作为 UI 基础。业务侧 PostHog 事件复用 `getReplayLifecycle().capture` 与 shared telemetry schema；缺 PostHog 公开配置、host 非 HTTPS 或 SDK 失败时前端 telemetry no-op。

## 入口与调用者

所有 Frontend 页面和业务组件使用。聊天、支付、图片生成 helper 通过 replay lifecycle capture 发送安全事件。

## 涉及文件

| 路径 | 职责 |
| --- | --- |
| `packages/frontend/src/lib/api/client.ts` | REST client |
| `packages/frontend/src/lib/api/` | Query hooks |
| `packages/frontend/src/lib/telemetry/` | PostHog adapter、lifecycle、masking 与 owner |
| `packages/frontend/src/lib/payment/flow-telemetry.ts` | 支付/回流事件 helper |
| `packages/frontend/src/lib/image-generation/telemetry.ts` | 图片生成事件 helper |
| `packages/frontend/src/components/ui/` | 公共 UI |
| `packages/frontend/src/stores/` | 跨组件客户端状态 |

## 关键实现链路

Provider 初始化 → Telegram 上下文 → query/client → 通用 loading/error/UI。业务 helper 先判断 active replay context，再通过 lifecycle capture，由 adapter 对 shared schema 和 forbidden keys 做运行时校验。

## 数据、契约与外部依赖

依赖 Telegram SDK、React Query、Zustand、shared DTO 和 `posthog-js`。浏览器公开变量不存 secret。

## 关键节点与约束

浏览器公开变量必须静态读取 `NEXT_PUBLIC_*`。server state 不复制到 Zustand。事件属性禁止 initData、token、支付 URL、聊天正文、图片 prompt、图片 URL、Storage path 和 provider request id。

## 验证方式

Frontend typecheck、test、lint、build 与真机检查。

## 已知缺口与待核验项

Telegram WebView 差异需持续人工回归；打开 Production PostHog 是独立运维步骤。

## 关联模块

`frontend.business.conversation-ui`、`frontend.business.wallet-payment`、`backend.infrastructure.runtime-data-security`。

## 变更记录

- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）记录图片业务事件复用现有 replay lifecycle 与 shared schema；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
