---
module_id: database.business.conversation-storage
title: 会话与语音存储
scope: database
category: business
status: active
owners: [database]
last_verified_task: .trellis/tasks/09-11-batch-lab-integration-spec/
last_verified_at: 2026-09-17
---

# 会话与语音存储

## 职责与边界

维护 experience 域会话、轮次、Prompt 快照和语音元数据。Batch Lab 可以读取冻结样本副本用于内部调试，但不得把实验输出写回真实会话存储。

## 当前状态

多会话、revision、软删、上下文水位与原子开轮 RPC 已落地。Batch Lab 样本 preview 可通过专用只读角色读取 `experience.chat_history` 与 `experience.chat_sessions` 作为冻结样本来源；该读取不改变 conversation 真相源，也不允许写入 experience 域。Backend execution 使用冻结后的 `batch_lab.sample_snapshots` 和 `batch_lab.experiment_attempts`，不重新查询线上会话补事实。History/export migration 为 `batch_lab.experiments` 增加 copy/reuse 血缘列，并新增 `batch_lab.annotations` 保存轻量备注；JSONL 导出只读取 `batch_lab` 冻结事实。

## 入口与调用者

Backend conversation/voice repositories 通过按域 client/RPC 使用。Batch Lab 只读来源连接用于内部调试样本冻结，平台写入落在独立 `batch_lab` 域。

## 涉及文件

| 路径                                                               | 职责                               |
| ------------------------------------------------------------------ | ---------------------------------- |
| `packages/shared/migrations/069_miniapp_chat_sessions.sql`         | 会话基线                           |
| `packages/shared/migrations/077_context_window.sql`                | 上下文水位                         |
| `packages/shared/migrations/080_chat_message_voice.sql`            | 语音元数据                         |
| `packages/shared/migrations/110_batch_lab_samples.sql`             | Batch Lab 来源只读授权与样本冻结   |
| `packages/shared/migrations/20260916_batch_lab_execution.sql`      | Batch Lab 实验/attempt 状态机      |
| `packages/shared/migrations/20260916_batch_lab_history_export.sql` | Batch Lab 历史血缘、备注与导出支持 |

## 关键实现链路

会话行锁 -> 分配 turn/revision -> 写 streaming -> 收口终态/语音状态。Batch Lab preview 使用锚点 ID 回读当前已落库的历史、session 和角色快照，再冻结副本；后续实验只消费冻结副本和同分支前序输出，不重新查询线上会话表补事实。JSONL 行由冻结样本、实验血缘、attempt raw output/display result id 和 annotations 组成，部分失败和 blocked/unknown 也保留。

## 数据、契约与外部依赖

权威表位于 experience，音频正文位于 Supabase Storage。Batch Lab 样本、实验、备注与展示结果保存的是调试副本，不反向服务线上会话。实验 raw output/display result 仅用于分析，不进入真实会话上下文。

## 关键节点与约束

并发以会话行为串行点；不删除历史轮次，仅调整窗口起点。Batch Lab 来源角色只有必要 SELECT，无 INSERT/UPDATE/DELETE/TRUNCATE/DDL；缺失 session/history/character 必须显式排除或统计，不能静默构造样本。Batch Lab execution/history/export 不得写 `experience.chat_history`、不创建 session turn、不修改冻结样本。

## 验证方式

Backend repository integration 与 MVP regression；Batch Lab 相关 preview/freeze/execution/history 通过 `packages/backend/src/features/batch-lab/*.test.ts`、repository tests、route tests 和 migration/runbook 证据验证。

## 已知缺口与待核验项

`chat_history.history` 容量治理仍待专项处理。Batch Lab spec 已收口来源只读、冻结样本、history/export 和 JSONL 导出边界；真实来源 LOGIN/secret 验证、production migration 执行和 worker 常驻调度仍需目标环境人工授权执行，离线测试不代表生产连通。

## 关联模块

`backend.business.conversation-generation`、`backend.infrastructure.runtime-data-security`。

## 变更记录

- 2026-09-16：任务 `Batch Lab Backend 实验与生成执行`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-backend-execution/`）更新模块知识文档；commit：`1316d11e29cd120e61be456cb93f4795d489af9b`。
- 2026-09-16：任务 `Batch Lab 历史、复用原文与导出`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-history-export/`）更新模块知识文档；提交前归档，见本任务后续 Git 提交。
- 2026-09-17：任务 `Batch Lab 集成验收、发布与 Spec 收口`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-integration-spec/`）收口 Batch Lab integration/spec、发布回滚、环境与剩余人工核验事实；提交前归档，见本任务后续 Git 提交。
