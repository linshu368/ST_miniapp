---
module_id: database.business.conversation-storage
title: 会话与语音存储
scope: database
category: business
status: active
owners: [database]
last_verified_task: .trellis/tasks/09-11-batch-lab-data-samples/
last_verified_at: 2026-09-16
---

# 会话与语音存储

## 职责与边界

维护 experience 域会话、轮次、Prompt 快照和语音元数据。

## 当前状态

多会话、revision、软删、上下文水位与原子开轮 RPC 已落地。Batch Lab 样本 preview 可通过专用只读角色读取 `experience.chat_history` 与 `experience.chat_sessions` 作为冻结样本来源；该读取不改变 conversation 真相源，也不允许写入 experience 域。

## 入口与调用者

Backend conversation/voice repositories 通过按域 client/RPC 使用。Batch Lab 只读来源连接用于内部调试样本冻结，平台写入落在独立 `batch_lab` 域。

## 涉及文件

| 路径                                                       | 职责                   |
| ---------------------------------------------------------- | ---------------------- |
| `packages/shared/migrations/069_miniapp_chat_sessions.sql` | 会话基线               |
| `packages/shared/migrations/077_context_window.sql`        | 上下文水位             |
| `packages/shared/migrations/080_chat_message_voice.sql`    | 语音元数据             |
| `packages/shared/migrations/110_batch_lab_samples.sql`     | Batch Lab 来源只读授权 |

## 关键实现链路

会话行锁 → 分配 turn/revision → 写 streaming → 收口终态/语音状态。Batch Lab preview 使用锚点 ID 回读当前已落库的历史、session 和角色快照，再冻结副本；后续实验不得重新查询线上会话补事实。

## 数据、契约与外部依赖

权威表位于 experience，音频正文位于 Supabase Storage。Batch Lab 样本保存的是调试副本，不反向服务线上会话。

## 关键节点与约束

并发以会话行为串行点；不删除历史轮次，仅调整窗口起点。Batch Lab 来源角色只有必要 SELECT，无 INSERT/UPDATE/DELETE/TRUNCATE/DDL；缺失 session/history/character 必须显式排除或统计，不能静默构造样本。

## 验证方式

Backend repository integration 与 MVP regression；Batch Lab 相关 preview/freeze 通过 `packages/backend/src/features/batch-lab/*.test.ts` 与 migration/runbook 证据验证。

## 已知缺口与待核验项

`chat_history.history` 容量治理仍待专项处理。真实来源 LOGIN/secret 验证需单独人工授权执行，当前离线测试不代表来源连通。

## 关联模块

`backend.business.conversation-generation`。

## 变更记录

- 2026-09-16：任务 `Batch Lab 数据库域、环境与样本集`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-data-samples/`）更新模块知识文档；commit：`14124a5b9df62627bb9fddfd722194206a0aa83b`。
