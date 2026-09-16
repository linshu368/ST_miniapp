---
module_id: shared.business.conversation-contracts
title: 会话与语音共享契约
scope: shared
category: business
status: active
owners: [shared]
last_verified_task: .trellis/tasks/09-11-batch-lab-postprocessing/
last_verified_at: 2026-09-16
---

# 会话与语音共享契约

## 职责与边界

定义会话、SSE、生成配置、语音消息以及 Batch Lab 调试平台公开 DTO 的跨进程数据形状；不包含业务执行，也不暴露数据库 row、连接配置或 secret。

## 当前状态

Backend 与 Frontend 已共同消费统一契约；模型仅保留 catalog 契约。Batch Lab 契约新增 sample preview/sample set、SQL template、processor version、regex-json/v1 config、display result、renderer protocol、错误码和容量上限。Processor config 显式限定 `none_v1` 与 `regex_json_v1`，regex 规则、flags、timeout、输入/输出长度均由 Zod 校验；display result 标明展示状态、match count、sanitized HTML 和 renderer 版本。

## 入口与调用者

由 shared 根出口导出，供 backend 路由/service、batch-lab client、后续 workbench UI 在编译期和运行时校验。

## 涉及文件

| 路径                                       | 职责                                     |
| ------------------------------------------ | ---------------------------------------- |
| `packages/shared/src/api/conversations.ts` | 会话与 SSE DTO                           |
| `packages/shared/src/api/voice.ts`         | 语音 DTO                                 |
| `packages/shared/src/api/models.ts`        | 模型 catalog DTO                         |
| `packages/shared/src/api/batch-lab.ts`     | Batch Lab 样本、processor 与 display DTO |
| `packages/shared/src/index.ts`             | 公共出口                                 |
| `packages/batch-lab/src/api/client.ts`     | Batch Lab 浏览器消费者                   |

## 关键实现链路

Zod/schema 与类型 -> Backend 校验/响应 -> batch-lab client schema parse -> UI/React Query 状态处理。Batch Lab processor preview 必须恰好引用一个来源：已有 processor_version_id 或 inline config；inline config 会在后端创建/复用不可变版本后再执行。

## 数据、契约与外部依赖

仅依赖 Zod。Shared 只定义浏览器可见 DTO、错误码、容量上限和 runtime validation schema，不包含数据库 row、连接串、service-role key、供应商 secret 或原始错误。

## 关键节点与约束

流事件 start/delta/done/error 语义必须保持消费者兼容。Batch Lab 后处理产物是 display-only，不得作为生成上下文；失败路径必须保留原文并带稳定错误码，零匹配是 success+0。

## 验证方式

`pnpm --filter @miniapp/shared test`、`pnpm --filter @miniapp/shared typecheck`，并运行 backend 与 batch-lab consumer typecheck。

## 已知缺口与待核验项

自建预设契约仍未定义。Batch Lab 后续 execution/history-export 子任务会继续扩展实验运行与导出 DTO，需保持当前 processor/display 语义兼容。

## 关联模块

`backend.infrastructure.runtime-data-security`、`database.infrastructure.schema-security`。

## 变更记录

- 2026-09-16：任务 `Batch Lab 后处理与富文本渲染`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-postprocessing/`）更新模块知识文档；commit：`1f41de3952d8b4bad42ea59fb4a439d08d2cab26`。
