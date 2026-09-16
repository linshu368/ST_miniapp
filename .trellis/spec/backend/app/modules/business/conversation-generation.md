---
module_id: backend.business.conversation-generation
title: 会话与生成
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/09-11-batch-lab-backend-execution/
last_verified_at: 2026-09-16
---

# 会话与生成

## 职责与边界

负责会话、消息、Prompt、SSE 与 LLM 生成计费，不承载前端展示。Batch Lab 可使用内部 research policy 复用 generation 上游出口，但该策略不进入 public/shared API，也不能被普通会话选择。

## 当前状态

自研会话链路已上线。即时结算与 fixed-tier 回捞共用 `applyLlmCharge`；模型目录只读取 `llm_model_catalog`。`features/generation/execute.ts` 新增 `policy.kind = internal_research`：它仍复用 OpenRouter 转发、SSE/non-stream 解析、timeout 与结果归一化，但跳过免费额度预留、钱包余额预检、扣费和 `settleGeneration`/`chat_history` 写入。

## 入口与调用者

Frontend 调用 `/api/v1/conversations*` 与 generation config；Batch Lab backend execution 通过后端内部 service 调用 generation executor，不暴露给浏览器自由选择。

## 涉及文件

| 路径                                                           | 职责                                      |
| -------------------------------------------------------------- | ----------------------------------------- |
| `packages/backend/src/routes/conversations.ts`                 | HTTP/SSE 入口                             |
| `packages/backend/src/features/conversations/`                 | 轮次编排                                  |
| `packages/backend/src/features/generation/`                    | 生成与计费出口                            |
| `packages/backend/src/features/batch-lab/execution-service.ts` | Batch Lab 内部 research generation 调用方 |

## 关键实现链路

普通会话：鉴权与 ownership -> 原子开轮 -> 上下文 Prompt -> 上游 SSE -> history 终态 -> `applyLlmCharge` 幂等结算，历史 usage 对账仍走独立 reconciliation。Batch Lab：冻结样本/variant -> generation `internal_research` -> attempt raw output -> 可选 display processor；不创建真实会话 turn，不写 `experience.chat_history`，不查/扣钱包。

## 数据、契约与外部依赖

消费 shared conversations 与 Batch Lab 契约、experience 会话数据、OpenRouter。Batch Lab 只传冻结快照内容和变体模型/采样参数，结果落 `batch_lab` 域。

## 关键节点与约束

流前错误使用 HTTP；响应头发出后使用流内 error。聊天生成计费不得旁路 `features/generation`，语音计费是已记录的独立例外。`internal_research` 只能在 backend 内部构造，不能从 shared/browser 请求体传入；其输出不能作为普通对话历史或计费依据。

## 验证方式

`pnpm --filter @miniapp/backend typecheck && pnpm --filter @miniapp/backend test`；Batch Lab execution 另跑 `execute execution-service BatchLabExecutionRepository batch-lab` targeted tests。

## 已知缺口与待核验项

真实 OpenRouter 上游 smoke、长任务 worker drain 和生产迁移需要 integration-spec 阶段统筹。角色卡更多人设字段和自建预设格式仍待后续任务。

## 关联模块

`frontend.business.conversation-ui`、`shared.business.conversation-contracts`、`database.business.conversation-storage`、`backend.infrastructure.runtime-data-security`。

## 变更记录

- 2026-09-16：任务 `Batch Lab Backend 实验与生成执行`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-backend-execution/`）更新模块知识文档；commit：`1316d11e29cd120e61be456cb93f4795d489af9b`。
