# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                                     | Files / Scope                                                                                                                                                                                                                     | Depends On | Verification                                                                                            |
| --- | ------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| T1  | Done   | 完成现有 PostHog/支付/图片链路调研并记录复用结论                         | `research/posthog-image-generation-reuse.md`                                                                                                                                                                                      | -          | 已检索 shared telemetry、frontend lifecycle/payment helper、backend payment observer、图片 route/worker |
| T2  | Done   | 定义图片生成 PostHog 事件清单和安全字段边界                              | `design.md`                                                                                                                                                                                                                       | T1         | 事件表覆盖 Frontend/Backend，列出禁止字段和去重策略                                                     |
| T3  | Done   | 规划 Frontend 接入节点与方式                                             | `design.md`                                                                                                                                                                                                                       | T2         | 覆盖 chat page、image footer、image API/query 终态观察、recharge trigger                                |
| T4  | Done   | 规划 Backend 接入节点与方式                                              | `design.md`                                                                                                                                                                                                                       | T2         | 覆盖 images route、worker terminal、PostHog capture 泛化、observer                                      |
| T5  | Done   | 规划配置、可靠性、发布回滚和验证                                         | `design.md`、`implement.md`                                                                                                                                                                                                       | T2-T4      | 覆盖 no-op、超时、幂等/去重、人工验收和命令                                                             |
| T6  | Done   | 配置后续实现所需上下文清单                                               | `implement.jsonl`、`check.jsonl`                                                                                                                                                                                                  | T1-T5      | 文件包含真实 spec/research 条目，无 seed-only 上下文                                                    |
| T7  | Done   | 实现 shared 图片生成 PostHog 事件契约                                    | `packages/shared/src/api/telemetry.ts`、`packages/shared/src/__tests__/telemetry-contract.test.ts`                                                                                                                                | T6         | `pnpm --filter @miniapp/shared test`、`pnpm -r typecheck`                                               |
| T8  | Done   | 实现 backend 图片生成 PostHog observer、capture 去重和 route/worker 接入 | `packages/backend/src/features/image/ImageGenerationTelemetry.ts`、`packages/backend/src/routes/images.ts`、`packages/backend/src/features/image/generate.ts`、`packages/backend/src/infrastructure/telemetry/posthog-capture.ts` | T7         | `pnpm --filter @miniapp/backend test`、`pnpm -r typecheck`                                              |
| T9  | Done   | 实现 frontend 图片生成 telemetry helper 与聊天图片 UI 接入               | `packages/frontend/src/lib/image-generation/telemetry.ts`、`packages/frontend/src/components/chat/chat-message-image.tsx`、`packages/frontend/src/app/chat/[characterId]/page.tsx`                                                | T7         | `pnpm --filter @miniapp/frontend test`、`typecheck`、`lint`、`build`                                    |

## Execution Log

- 2026-09-17：创建 Trellis planning task。
- 2026-09-17：读取入口文档、frontend/backend/shared 规范、模块索引和现有 PostHog/支付/图片源码。
- 2026-09-17：完成规划 artifacts；未执行 `task.py start`，未改产品代码。
- 2026-09-18：用户确认开始实现，执行 `task.py start` 将任务切到 `in_progress`。
- 2026-09-18：完成 shared/backend/frontend 图片生成 PostHog 接入；事件属性只包含 ID、状态、长度、耗时、价格/尺寸摘要和错误码，不包含 prompt 正文、图片 URL、Storage path 或 provider request id。
- 2026-09-18：验证通过：`pnpm --filter @miniapp/shared test`、`pnpm --filter @miniapp/backend test`、`pnpm --filter @miniapp/frontend test`、`pnpm -r typecheck`、`pnpm --filter @miniapp/frontend lint`、`pnpm --filter @miniapp/frontend build`。
