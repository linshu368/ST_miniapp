---
module_id: shared.business.conversation-contracts
title: 会话、语音与图片共享契约
scope: shared
category: business
status: active
owners: [shared]
last_verified_task: .trellis/tasks/09-11-batch-lab-integration-spec/
last_verified_at: 2026-09-17
---

# 会话与语音共享契约

## 职责与边界

定义会话、SSE、生成配置、语音、图片 attempt 和图片生成 telemetry 的跨进程数据形状，不包含业务执行.以及 Batch Lab 调试平台公开 DTO 的跨进程数据形状；不包含业务执行，也不暴露数据库 row、连接配置或 secret。

## 当前状态

Backend 与 Frontend 已共同消费统一契约；图片契约包含中文稿上限、配置、描述、创建、会话聚合状态与稳定错误码，不暴露英文/provider prompt。`api/telemetry.ts` 扩展图片生成事件 union 与 `chat_image` 付费墙来源，覆盖前端用户操作、描述展示/失败、提交/受理、终态观察、预览、保存，以及后端描述/worker 终态事件。模型仅保留 catalog 契约。Batch Lab 契约包含 sample preview/sample set、SQL template、processor version、regex-json/v1 config、display result、renderer protocol、experiment execution、history lineage、copy/reuse-display、annotation 和 JSONL export schema/version。Processor config 显式限定 `none_v1` 与 `regex_json_v1`；JSONL 一行一个冻结样本，包含实验血缘、样本快照、attempt 状态/错误、原文输出和备注，不要求导出时重新查询源库。

## 入口与调用者

由 shared 根出口导出，供 backend 路由/service、batch-lab client、workbench UI 在编译期和运行时校验。前后端 PostHog 事件都必须先通过 `parseReplayTelemetryEvent`。

## 涉及文件

| 路径                                       | 职责                                                      |
| ------------------------------------------ | --------------------------------------------------------- |
| `packages/shared/src/api/conversations.ts` | 会话与 SSE DTO                                            |
| `packages/shared/src/api/voice.ts`         | 语音 DTO                                                  |
| `packages/shared/src/api/models.ts`        | 模型 catalog DTO                                          |
| `packages/shared/src/api/images.ts`        | 图片 DTO 与校验                                           |
| `packages/shared/src/api/telemetry.ts`     | replay context、支付与图片生成事件契约                    |
| `packages/shared/src/api/batch-lab.ts`     | Batch Lab 样本、processor、experiment、history/export DTO |
| `packages/shared/src/index.ts`             | 公共出口                                                  |
| `packages/batch-lab/src/api/client.ts`     | Batch Lab 浏览器消费者                                    |

## 关键实现链路

Zod/schema 与类型 -> Backend 校验/响应/observer → Frontend client、状态处理与 telemetry helpe -> batch-lab client schema parse -> UI/React Query 状态处理。Batch Lab processor preview 必须恰好引用一个来源：已有 processor_version_id 或 inline config；history/export 契约把复制、reuse-display 和 JSONL 行都绑定 `source_environment` 与稳定 idempotency key，防止跨环境串用。telemetry helper。事件属性只允许 ID、枚举、耗时、状态、计数和价格/尺寸摘要。

## 数据、契约与外部依赖

仅依赖 Zod；不得暴露数据库 row。`TELEMETRY_FORBIDDEN_PROPERTY_KEYS` 拒绝正文、`pay_url`、initData、token、图片 prompt、图片 URL、Storage path 和 provider request id 的 snake_case/camelCase 变体。
Shared 只定义浏览器可见 DTO、错误码、容量上限和 runtime validation schema，不包含数据库 row、连接串、service-role key、供应商 secret 或原始错误。

## 关键节点与约束

流事件 start/delta/done/error 语义必须保持消费者兼容。图片内部 leased/storing 不进入公开状态，中文稿由 shared schema 与后端共同执行。新增 telemetry 事件必须保持 browser-safe，不能把 provider 成功等同业务成功。Batch Lab 后处理产物是 display-only，不得作为生成上下文；reuse-display 实验必须显式标记血缘且计划模型调用数为零；JSONL 必须包含失败/blocked/unknown attempt，而不是静默丢项。

## 验证方式

`pnpm --filter @miniapp/shared test`、`pnpm --filter @miniapp/shared typecheck`，并运行 backend 与 batch-lab consumer typecheck。

## 已知缺口与待核验项

自建预设契约仍未定义。PostHog Preview 中 forbidden 字段为空仍需人工验收。Batch Lab 最终 `.trellis/spec/batch-lab/app/`、发布顺序、故障恢复与 JSONL 验收矩阵已由 integration-spec 收口；目标环境 smoke 与生产迁移执行仍需人工记录。

## 关联模块

`backend.infrastructure.runtime-data-security`、`database.infrastructure.schema-security`、`backend.business.conversation-generation`、`frontend.business.conversation-ui`、`frontend.infrastructure.client-ui-foundation`。

## 变更记录

- 2026-09-16：任务 `Batch Lab 后处理与富文本渲染`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-postprocessing/`）更新模块知识文档；commit：`1f41de3952d8b4bad42ea59fb4a439d08d2cab26`。
- 2026-09-16：任务 `Batch Lab 历史、复用原文与导出`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-history-export/`）更新模块知识文档；提交前归档，见本任务后续 Git 提交。
- 2026-09-17：任务 `Batch Lab 集成验收、发布与 Spec 收口`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-integration-spec/`）收口 Batch Lab integration/spec、发布回滚、环境与剩余人工核验事实；提交前归档，见本任务后续 Git 提交。
- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）写入图片生成 telemetry 事件契约与禁止字段；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
- 2026-09-23：任务 `Fix live free quota refresh in chat`（`.trellis/tasks/archive/2026-09/09-23-fix-chat-free-quota-refresh/`）??????????????????????????????????；commit：`5413afeaae67e9ef168831ec050d3b8514df33dd`。
- 2026-09-23：任务 `Admin VIP media configuration`（`.trellis/tasks/archive/2026-09/09-23-admin-vip-media-config/`）Admin ?? VIP ??????????????????/????????????；commit：`5413afeaae67e9ef168831ec050d3b8514df33dd`。
