# 图片生成 PostHog 接入设计

## 范围

本任务只规划图片生成功能的 PostHog 事件契约和接入点，覆盖 `packages/frontend` 与 `packages/backend`，并因事件 schema 需要同步触及 `packages/shared`。不实现产品代码，不变更数据库 schema，不开启生产采集。

跨层流：

```text
ChatMessageImageFooter
→ frontend image telemetry helper
→ shared telemetry schema
→ getReplayLifecycle().capture
→ PostHog browser SDK

Backend routes/images.ts + features/image/generate.ts
→ features/image/ImageGenerationTelemetry
→ shared telemetry schema
→ infrastructure/telemetry/posthog-capture.ts
→ PostHog capture API
```

## 复用决策

| 对象                                                  | 结论                                 | 理由                                                                       |
| ----------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `shared/src/api/telemetry.ts`                         | 扩展                                 | 现有 adapter/capture 只接受 shared schema 事件，安全边界集中。             |
| `getReplayLifecycle().capture`                        | 复用                                 | 自动补 `telegram_user_id`、`replay_context_id`、`occurred_at` 和用户标签。 |
| `frontend/lib/payment/flow-telemetry.ts` 模式         | 复用为图片 helper                    | 业务组件只调用语义函数，helper 负责活跃 context、去重、字段收敛。          |
| `backend/infrastructure/telemetry/posthog-capture.ts` | 复用并泛化注释/去重                  | 已有 HTTPS host 校验、短超时、no-op、敏感字段防护。                        |
| `PaymentOrderTelemetry.ts` 模式                       | 复用为 `ImageGenerationTelemetry.ts` | 未配置时不查用户；配置后反查 Telegram identity，fire-and-forget。          |
| 新 DB 表/队列                                         | 不采用                               | PostHog 是非关键观测，现有 helper 已足够；增加持久队列超出需求。           |

## 事件契约

所有事件继续放入 `ReplayTelemetryEventSchema` discriminated union。事件属性只允许 ID、枚举、耗时、状态、计数和价格快照；禁止正文、prompt、URL、Storage 路径、provider request id、token、完整错误体。

### 新增基础 schema

- `ImagePromptSourceSchema`: 复用 `images.ts` 的 `generated | custom`。
- `ImageAttemptStatusSchema`: `pending | generating | ready | failed | failed_unknown`。
- `ImageTerminalStatusSchema`: `ready | failed | failed_unknown`。
- `ImageChargeStatusSchema`: `charged | already_charged | insufficient_balance`。
- `ImageFailureKindSchema`: `business | network | timeout | provider | storage | settlement | unknown`。
- `ImageEntrySourceSchema`: `default | retry | regenerate_ready | custom_edit`。
- `ImageBaseFields`: `character_id`、`conversation_session_id`、`selected_model_id`、`message_id`。
- `ImageAttemptFields`: `attempt_id`、`attempt_no` 可选/必选按事件定义。

### Frontend 事件

| 事件名                             | 触发点                                              | 关键字段                                                                                                                            | 去重/说明                                             |
| ---------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `image_entry_selected`             | 用户点击 `看看TA`、`重试出图`、ready 后重新生成入口 | `ImageBaseFields`、`entry_source`、`latest_status?`、`has_ready_image`                                                              | 不记录 impression，只记录点击。                       |
| `image_description_requested`      | 默认流程开始调用 `image.describe()` 前              | `ImageBaseFields`                                                                                                                   | 只表示用户开始免费写稿。                              |
| `image_description_presented`      | `describeImage.mutateAsync` 成功并展示中文描述      | `ImageBaseFields`、`attempt_id`、`attempt_no?`、`prompt_chars`                                                                      | `prompt_chars` 只记录长度。                           |
| `image_description_failed`         | 默认描述请求失败                                    | `ImageBaseFields`、`failure_kind`、`error_code?`、`duration_ms`                                                                     | 不记录错误 body。                                     |
| `image_custom_prompt_opened`       | 用户点击“我来改改”或进入自定义描述                  | `ImageBaseFields`、`entry_source`                                                                                                   | 不记录输入内容。                                      |
| `image_generation_submitted`       | 用户确认生成，调用 `image.create()` 前              | `ImageBaseFields`、`prompt_source`、`prompt_chars`、`required_credits?`                                                             | 记录用户意图；允许后续失败。                          |
| `image_generation_submit_failed`   | `image.create()` 受理前失败，如 402/409/503/400     | `ImageBaseFields`、`prompt_source`、`prompt_chars`、`failure_kind`、`error_code?`、`required_credits?`、`duration_ms`               | 402 还应走 paywall。                                  |
| `image_generation_status_observed` | session image query/poll 首次观察到 attempt 终态    | `ImageBaseFields`、`attempt_id`、`attempt_no`、`terminal_status`、`error_code?`、`credits_charged`、`duration_ms?`、`prompt_source` | 按 `attempt_id:status` 内存去重，表示用户端看见终态。 |
| `image_preview_opened`             | 用户打开 ready 图片预览 Dialog                      | `ImageBaseFields`、`attempt_id`、`attempt_no`                                                                                       | 不带 `image_url`。                                    |
| `image_save_requested`             | 用户点击保存图片                                    | `ImageBaseFields`、`attempt_id`、`attempt_no`                                                                                       | 不带文件名或 URL。                                    |
| `image_save_completed`             | Telegram download API 返回 true                     | `ImageBaseFields`、`attempt_id`、`attempt_no`、`duration_ms`                                                                        | 仅客户端结果。                                        |
| `image_save_failed`                | download API 返回 false 或抛错                      | `ImageBaseFields`、`attempt_id`、`attempt_no`、`failure_kind`、`duration_ms`                                                        | 不记录 Telegram 细节。                                |

### Backend 事件

| 事件名                        | 触发点                                                                                              | 关键字段                                                                                                                                   | 接入方式                                                                                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `image_description_completed` | `markDescriptionDraftReady` 成功之后                                                                | `ImageBaseFields`、`attempt_id`、`attempt_no`、`prompt_chars`、`duration_ms`                                                               | route 中 fire-and-forget observer；使用 request user 或 user_id 反查 identity。                                                                                            |
| `image_description_failed`    | `markDescriptionDraftFailed` 成功或描述阶段确定失败后                                               | `ImageBaseFields`、`attempt_id?`、`error_code`、`duration_ms`、`failure_kind`                                                              | 只在有足够身份/上下文时发送；无 draft id 也可跳过。                                                                                                                        |
| `image_generation_accepted`   | `confirmDescriptionDraft/createPending` 成功并返回 202 前后                                         | `ImageBaseFields`、`attempt_id`、`attempt_no`、`prompt_source`、`prompt_chars`、`price_credits`、`width`、`height`                         | route 中 fire-and-forget；不影响 202。                                                                                                                                     |
| `image_generation_completed`  | worker `settleReady` 成功且 `charge_status` 为 `charged                                             | already_charged` 后                                                                                                                        | `ImageBaseFields`、`attempt_id`、`attempt_no`、`charge_status`、`credits_charged`、`provider`、`fallback_used`、`width`、`height`、`mime_type`、`byte_size`、`duration_ms` | worker 终态 observer；未配置 PostHog 时不反查用户。 |
| `image_generation_failed`     | worker `markFailed/markFailedUnknown` 成功后，或 `settleReady` 返回 `insufficient_balance` 并补偿后 | `ImageBaseFields`、`attempt_id`、`attempt_no`、`terminal_status`、`error_code`、`failure_kind`、`provider`、`fallback_used`、`duration_ms` | 结算响应未知不发送，避免误判。                                                                                                                                             |

说明：

- `image_description_failed` 前后端同名但语义不同会造成分析混淆，实施时应采用命名区分：前端用 `image_description_ui_failed`，后端用 `image_description_failed`；或增加 `source_layer` 字段。推荐使用不同事件名。
- 如果保留所有事件在一个 union，`REPLAY_TELEMETRY_EVENT_NAMES` 测试必须覆盖代表性图片事件。

## Frontend 接入点

### `packages/frontend/src/app/chat/[characterId]/page.tsx`

- 给 `ChatMessageImageFooter` 的 `image` prop 增加最小 telemetry context：
  - `characterId`
  - `conversationSessionId`
  - `selectedModelId`
  - `messageId`
  - `requiredCredits`
- 图片余额不足跳充值时传入 `triggerSource: 'chat_image'`，同时 shared `PaywallTriggerSourceSchema` 增加 `chat_image`。这样图片 402 能复用现有 paywall/recharge/payment 回流事件。

### `packages/frontend/src/components/chat/chat-message-image.tsx`

- 在以下函数节点调用图片 telemetry helper：
  - `openDefaultFlow`: `image_entry_selected`、`image_description_requested`、成功后 `image_description_presented`、catch 后 `image_description_ui_failed`。
  - `openRetryFlow`: `image_entry_selected(entry_source=retry)`。
  - ready 后重新生成按钮：`image_entry_selected(entry_source=regenerate_ready)`。
  - `openCustomFlow`: `image_custom_prompt_opened`。
  - `submit`: 调用前 `image_generation_submitted`；catch 后 `image_generation_submit_failed`。
  - `viewerOpen` 打开：`image_preview_opened`。
  - `saveImage`: 点击时 `image_save_requested`；结束后 completed/failed。
- 所有调用包在 `try/catch` 或 helper 内吞掉异常，PostHog 不得影响 UI。

### `packages/frontend/src/lib/api/images.ts`

- mutation 成功后可以不直接 capture，仍交给组件 helper，避免 API 层不知道 character/model。
- `useSessionImagesQuery` 的 terminal 状态观察建议在新 helper hook 中处理，接收 `sessionImagesQuery.data` 和 chat identity，按 `attempt_id:status` 去重发送 `image_generation_status_observed`。

### `packages/frontend/src/lib/image-generation/telemetry.ts`

- 新增 helper，类似 `payment/flow-telemetry.ts`：
  - `captureImageEntrySelected`
  - `captureImageDescriptionRequested/Presented/Failed`
  - `captureImageGenerationSubmitted/SubmitFailed`
  - `useImageStatusTelemetry` 或纯函数 `captureImageStatusObserved`
  - `captureImagePreviewOpened`
  - `captureImageSaveRequested/Completed/Failed`
- 内部统一：
  - 检查 active replay context。
  - 调用 `getReplayLifecycle().capture`。
  - 对 terminal/status/save 事件做内存去重。
  - 只传 schema 白名单字段。

## Backend 接入点

### `packages/backend/src/features/image/ImageGenerationTelemetry.ts`

新增图片 telemetry observer：

- `observeImageDescriptionCompleted(input, log)`
- `observeImageDescriptionFailed(input, log)`
- `observeImageGenerationAccepted(input, log)`
- `observeImageGenerationCompleted(input, log)`
- `observeImageGenerationFailed(input, log)`

实现要求：

- 与支付一致：先 `isPosthogCaptureConfigured()`，未配置直接 return，不查用户。
- 配置后通过 `findTelegramIdByUserId(input.userId)` 获取 `telegram_user_id`。
- 构造对象后用 `parseReplayTelemetryEvent` 校验，再 `captureReplayTelemetryEvent(parsed, log)`。
- observer 自己 catch 并记录 `{ event: 'image.telemetry.failed', err, attemptId }`，调用方也用 `void` fire-and-forget。
- 不传 `prompt_cn`、`prompt_en`、`provider_prompt`、`image_url`、`storage_path`、`provider_request_id`。

### `packages/backend/src/routes/images.ts`

- `POST /image-description`
  - `markDescriptionDraftReady` 成功后发送 `image_description_completed`。
  - catch 中若 draft 已创建并成功标记失败，发送 `image_description_failed`。
- `POST /image`
  - `confirmDescriptionDraft/createPending` 成功后发送 `image_generation_accepted`。
  - 402/409/503 受理前失败不建议服务端发终态；前端已有 `image_generation_submit_failed`，后端日志继续记录 HTTP 摘要。

### `packages/backend/src/features/image/generate.ts`

- `settleReady` 返回 `charged | already_charged` 后发送 `image_generation_completed`。
- `settleReady` 返回 `insufficient_balance` 并补偿对象后发送 `image_generation_failed`，`error_code=image_settlement_insufficient_balance`、`failure_kind=settlement`。
- catch 中 `markFailed/markFailedUnknown` 成功后发送 `image_generation_failed`。
- `ImageSettlementUnknownError` 分支不发送 PostHog 终态，只保留现有 `{ event: 'image.settlement.unknown' }` 日志，避免状态未知时制造错误事实。

### `packages/backend/src/infrastructure/telemetry/posthog-capture.ts`

- 保持现有配置、host 校验、短超时和 forbidden-key 校验。
- 把 payment-only 注释改为通用“服务端终态/非关键事件 capture”。
- 去重函数从 `paymentTerminalDedupe` 泛化为 `terminalDedupe`：
  - 支付继续按 `order_id:status:settled_by`。
  - 图片后端终态按 `attempt_id:event:terminal_status|charge_status`。
- 不为前端 UI 事件做服务端去重。

## 正确配置要求

- Frontend 继续使用 `NEXT_PUBLIC_POSTHOG_KEY`、`NEXT_PUBLIC_POSTHOG_HOST`，必须由 `readPostHogBrowserEnv` 静态读取 `process.env.NEXT_PUBLIC_*`。缺任一、host 非 HTTPS 或 SDK 加载失败时 no-op。
- Backend 继续使用 `POSTHOG_API_KEY`、`POSTHOG_HOST`、`POSTHOG_TIMEOUT_MS`，由 `platform/config.ts` 读取。缺 key 或 host 非法时 no-op，且不反查 Telegram identity。
- 不新增 runtime_config 中的 PostHog 开关。`image_generation_enabled` 只控制图片业务入口，不控制已写入的 telemetry helper。
- Preview/test 可配置 PostHog 验收；Production 留空即关闭，开启生产采集是独立运维动作。

## 可靠性设计

| 维度      | 设计                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------ |
| 超时      | 前端沿用 SDK load timeout；后端 capture 沿用 `POSTHOG_TIMEOUT_MS`，默认短超时。                        |
| 重试      | 不新增重试。图片业务 provider/worker 重试策略不因 PostHog 改变。                                       |
| 幂等/去重 | 前端按 `attempt_id:status`、save result 去重；后端按图片 attempt 终态去重。                            |
| 并发      | PostHog 事件不参与图片业务并发控制；attempt 状态仍由 DB/RPC 控制。                                     |
| 事务      | 仅在终态落库成功后发后端事件；不把 capture 纳入事务。                                                  |
| 降级      | PostHog 未配置/失败/超时只记录安全摘要，不阻断描述、受理、worker、结算或充值跳转。                     |
| 容量      | 不采集轮询中的非终态状态，不采集 prompt 正文，避免事件量和敏感数据膨胀。                               |
| 恢复      | worker 崩溃由现有租约/状态收敛；PostHog 事件不补偿重放。终态观察可由前端再次看到时补一条用户可见事件。 |

## 发布与回滚

- 发布顺序：shared telemetry schema → backend observer/capture 泛化 → frontend helper/UI 接入。
- 向后兼容：新增事件和枚举，旧客户端可继续运行；Backend capture 对未配置环境 no-op。
- 停止条件：发现事件含 prompt/URL/secret、图片 UI 被 telemetry 异常阻断、后端 capture 影响 worker 延迟时停止发布。
- 回滚：回滚前后端代码即可停止新事件；PostHog 配置留空可立即关闭采集；shared 新增事件保留兼容，不需要 DB rollback。

## 验证方案

- Shared：`pnpm --filter @miniapp/shared test`，新增 telemetry contract 测试覆盖图片事件、`chat_image` paywall source 和 forbidden keys。
- Frontend：`pnpm --filter @miniapp/frontend test`、`typecheck`、`lint`、`build`；新增 helper/组件测试覆盖事件字段、去重、无 active replay context no-op、402 触发 `chat_image` paywall。
- Backend：`pnpm --filter @miniapp/backend test`、`typecheck`；新增 observer/capture 测试覆盖未配置不查用户、终态落库后发送、capture 失败不影响业务、图片终态去重。
- 人工：Preview 配置 PostHog，走默认描述→确认出图→预览→保存、余额不足→充值、provider 失败/settlement insufficient 的可重复场景；在 PostHog 检索 forbidden 字段应为空。
