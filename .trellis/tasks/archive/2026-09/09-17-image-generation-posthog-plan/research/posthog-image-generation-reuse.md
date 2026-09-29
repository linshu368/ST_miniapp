# PostHog 图片生成接入复用调研

## 已读规范

- `README.md` 与 `docs/ARCHITECTURE.md`：确认 Frontend/Backend/Shared 边界、PostHog 环境变量、图片生成当前入口和默认关闭状态。
- `.trellis/spec/frontend/app/index.md`、`api-dataflow-and-state.md`、`testing-quality-and-deployment.md`：确认前端 PostHog 公开变量、静态读取、replay lifecycle、敏感字段禁止项和测试要求。
- `.trellis/spec/backend/app/index.md`、`routes-and-features.md`、`data-reliability-and-security.md`：确认 route 只做编排、PostHog 服务端 capture 是非关键观测、缺配置 no-op。
- `.trellis/spec/shared/contracts/index.md`、`api-contracts.md`：确认所有对外 telemetry 事件必须先扩展 shared schema。
- 模块文件：`frontend.business.conversation-ui`、`backend.business.conversation-generation`、`shared.business.conversation-contracts`、`backend.infrastructure.runtime-data-security`。

## 已检索源码与复用结论

### Shared telemetry

- `packages/shared/src/api/telemetry.ts` 是当前 PostHog/replay 自定义事件唯一契约入口，`parseReplayTelemetryEvent` 被前后端共同使用。
- `TELEMETRY_FORBIDDEN_PROPERTY_KEYS` 已禁止正文、支付 URL、initData、token/secret、`user_cohort` 等字段。
- 图片事件应扩展此文件，不应在 frontend/backend 私定义事件对象。需要补充禁止键：`prompt`、`prompt_cn`、`prompt_en`、`provider_prompt`、`description_user_prompt`、`image_url`、`storage_path`、`provider_request_id`。

### Frontend PostHog

- `packages/frontend/src/lib/telemetry/adapter.ts` 动态加载 `posthog-js`，缺 KEY/HOST、host 非 HTTPS、SDK 超时均 no-op；事件必须通过 shared schema。
- `packages/frontend/src/lib/telemetry/lifecycle.ts` 负责注入 `telegram_user_id`、`replay_context_id`、`occurred_at`、用户标签和 replay session 属性。
- `packages/frontend/src/lib/payment/flow-telemetry.ts` 是支付侧的本地 helper 模式：业务组件调用 helper，helper 做活跃 context 判断、去重、字段收敛。
- 图片 UI 目前在 `packages/frontend/src/components/chat/chat-message-image.tsx`，API hooks 在 `packages/frontend/src/lib/api/images.ts`，会话页在 `packages/frontend/src/app/chat/[characterId]/page.tsx` 组装 message/session/character/model。
- 结论：图片前端埋点新增 `lib/image/telemetry.ts` 或 `lib/image-generation/telemetry.ts` helper，由会话页传入 `character_id`、`conversation_session_id`、`selected_model_id`、`message_id` 和 mutation 结果；组件不直接构造散落事件。

### Backend PostHog

- `packages/backend/src/infrastructure/telemetry/posthog-capture.ts` 用 Node 22 原生 `fetch`，配置来自 `platform/config.ts` 的 `POSTHOG_API_KEY`、`POSTHOG_HOST`、`POSTHOG_TIMEOUT_MS`；未配置时返回 `skipped`。
- 当前支付侧 `PaymentOrderTelemetry.ts` 先调用 `isPosthogCaptureConfigured()`，未配置时不反查用户；配置后用 `findTelegramIdByUserId` 查 Telegram identity，再 `parseReplayTelemetryEvent` 和 `captureReplayTelemetryEvent`。
- 结论：图片后端新增 `features/image/ImageGenerationTelemetry.ts`，复用支付 observer 模式；`posthog-capture.ts` 可保留通用函数，但需把注释/去重命名从 payment-only 泛化。

### 图片生成链路

- `packages/backend/src/routes/images.ts`
  - `POST /image-description`：校验开关、ownership、visual anchor，创建 draft，调用写稿，`markDescriptionDraftReady/Failed`。
  - `POST /image`：校验开关、body、余额，确认 draft 或新建 pending，返回 202。
- `packages/backend/src/features/image/generate.ts`
  - worker claim 后执行翻译、provider dispatch、Grok，失败时可降级 Replicate Z，转存 Storage，调用 `settleReady`。
  - `settle_image_generation` 返回 `charged | already_charged | insufficient_balance`；`insufficient_balance` 会把 attempt 标为 failed 并补偿删除对象。
  - 结算响应未知时保留 storing，不应发送成功/失败终态事件。
- `packages/shared/src/api/images.ts` 定义公开 attempt 状态和错误码；内部 `leased/storing/draft_*` 不进入前端公开契约。

## 不复用/不新增

- 不新增 PostHog SDK、队列或数据库表；服务端继续用现有 capture helper。
- 不在 runtime_config 增加 PostHog 开关；环境变量留空即关闭。
- 不把 prompt、图片 URL、Storage 路径、provider request id 或完整错误 body 放入事件属性。
- 不在组件内直接调用 `posthog-js`，不绕过 `getReplayLifecycle().capture`。
