# 图片生成 PostHog 接入执行计划

## 前置状态

- 当前任务保持 `planning`，本轮只产出规划，不执行 `task.py start`，不改产品代码。
- 若后续进入实现，先由人工审核 `prd.md`、`design.md`、`implement.md`、`task.md`。

## 执行顺序

1. Shared telemetry contract
   - 在 `packages/shared/src/api/telemetry.ts` 增加图片事件 schema、图片相关枚举、`chat_image` paywall source。
   - 扩展 forbidden keys，禁止 prompt/图片 URL/Storage/provider 敏感字段。
   - 更新 `packages/shared/src/__tests__/telemetry-contract.test.ts`。

2. Backend telemetry observer
   - 新增 `packages/backend/src/features/image/ImageGenerationTelemetry.ts`。
   - 复用 `PaymentOrderTelemetry.ts` 的配置检查、Telegram identity 反查、parse + capture 模式。
   - 泛化 `packages/backend/src/infrastructure/telemetry/posthog-capture.ts` 注释与终态去重。
   - 增加 observer/capture 单元测试。

3. Backend image route and worker integration
   - `routes/images.ts`：
     - 描述成功/失败后 fire-and-forget 图片描述事件。
     - 创建/确认 pending 成功后 fire-and-forget `image_generation_accepted`。
   - `features/image/generate.ts`：
     - `settleReady` charged/already_charged 后发送 completed。
     - insufficient_balance 补偿后发送 failed。
     - `markFailed/markFailedUnknown` 成功后发送 failed。
     - settlement unknown 不发送终态事件。

4. Frontend image telemetry helper
   - 新增图片 telemetry helper，复用 `payment/flow-telemetry.ts` 的活跃 context 判断、去重和 capture 草稿模式。
   - 新增测试覆盖字段、no-op、去重和 forbidden 字段不出现。

5. Frontend UI integration
   - `chat/[characterId]/page.tsx` 给图片 footer 传入 telemetry context。
   - `chat-message-image.tsx` 在入口、描述、确认生成、终态观察、预览、保存节点调用 helper。
   - 图片余额不足跳充值时传 `triggerSource: 'chat_image'`。

6. 验证
   - `pnpm --filter @miniapp/shared test`
   - `pnpm --filter @miniapp/backend typecheck`
   - `pnpm --filter @miniapp/backend test`
   - `pnpm --filter @miniapp/frontend typecheck`
   - `pnpm --filter @miniapp/frontend test`
   - `pnpm --filter @miniapp/frontend lint`
   - `pnpm --filter @miniapp/frontend build`
   - 如 shared contract 影响消费者，追加 `pnpm -r typecheck`。

## 风险与回滚点

- Shared schema 改错会导致前后端事件被 adapter 拒绝：先跑 shared test 和消费者 typecheck。
- 前端事件缺 chat identity 会静默 no-op：helper 测试覆盖无 active replay/context 缺失场景。
- 后端 capture 不能阻断 worker：observer 必须 fire-and-forget 并吞掉异常，测试覆盖 hanging/throwing capture。
- 若 Preview 发现敏感字段，立即清空 PostHog 环境变量关闭采集，并回滚前后端接入代码。
