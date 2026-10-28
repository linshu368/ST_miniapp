# T1：环境、依赖与兼容边界审计

日期：2026-10-15。范围：`dev_openrouter_migrate`、正式 TEST `zoqelpfhurwehlvypryl` 与 Production `wbtsfzozlmurljvglhpn` 的只读 catalog/迁移账本，及仓库静态检索。未读取或导出任何 `chat_history` 业务行，未执行 DDL/DML。

## 环境与结构事实

两环境的 `experience.chat_history` 都有同一组 13 个可空列，顺序为第 14 至 26 列：`llm_provider_name`、`llm_finish_reason`、`llm_usage`、`llm_usage_cache`、`llm_native_tokens_cached`、`llm_native_tokens_reasoning`、`llm_native_tokens_completion`、`llm_native_tokens_prompt`、`llm_latency`、`llm_generation_time`、`llm_model`、`llm_generation_id`、`llm_generation_data`。两环境已有 `experience.venice_chat_history`，其权限为仅 `postgres` 与 `service_role`；`chat_history` 当前未启用 RLS，且存在 `anon`/`authenticated` 表级权限，不能把它的 ACL 直接复制到新表。

`experience.current_chat_history` 在两环境均显式投影 13 列，且只授权 `service_role` / `postgres` SELECT。Production 额外存在 `miniapp_analytics.base_chat_bj`，直接投影 `experience.chat_history.llm_latency`；TEST 不存在该视图。新表迁移不能在任何环境直接 DROP 旧列。

`supabase_migrations.repo_migrations` 在两环境都记录了迁移账本和 events 基础迁移，但均未记录 `20260929_venice_chat_history.sql` 或 `20260929_llm_model_catalog_multi_provider.sql`，同时 Venice 表实际存在。这是既有 shape 与账本漂移，不影响读取，但不能将 Venice 文件账本状态当作新 OpenRouter 表的发布前置或回滚依据。新 migration 必须走现有 Database Migration workflow，由其单文件记账。

部署核验：Railway `stminiapp` 在 development 的当前 deployment 为 `218cdef9-d9da-4654-b3f8-372bd918d20b`、Production 为 `c88cda5f-c91d-40da-9577-34ead06b1a36`，两者均为 `SUCCESS` 且运行中。这个结果只证明当前服务可用，不证明其 commit 已包含本任务后续变更；T3/T4 发布前需要重新记录对应 commit 与 migration 前置条件。

## 消费者与历史归属

| 证据                                                                         | 结论                                                                                                                                            |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `031_chat_history_llm_metadata.sql`                                          | 13 列最初作为 OpenRouter metadata 加入，历史注释可说明字段语义。                                                                                |
| `ConversationHistoryRepository`、`generate.ts`                               | `llm_finish_reason` 是持久化终态竞争锁，控制取消、超时恢复、SSE 终态及公开 `finish_reason`；必须留在主表。                                      |
| `ConversationHistoryRepository.listRowsMissingGenerationData`、`sync-job.ts` | `llm_generation_id` 是 OpenRouter 24 小时回捞的定位键；扫描完成条件还读取 usage、latency、generation time、generation data 和主表业务结束原因。 |
| `050_llm_spending_details.sql` 与 `082_spending_reply_outcomes.sql`          | 历史账单 backfill 按 `llm_generation_id` 去重，账单结果用 `llm_finish_reason` 判定；旧行回填不能仅按非空字段猜测供应商。                        |
| `072_chat_history_conversation_source.sql`                                   | 会话迁移按 generation ID 或 charge ID 对齐；该 ID 是历史关联证据的一部分。                                                                      |
| `current_chat_history`                                                       | 两环境均直接依赖 13 列；改列先替换视图/消费者。                                                                                                 |
| `miniapp_analytics.base_chat_bj`（Production）                               | 直接依赖 `llm_latency`；迁移必须一并更新或明确保留该列。                                                                                        |

数据库 catalog 未发现自定义函数体直接引用这 13 列。这个结果不等于无动态 SQL；T2 改动前仍需复核目标环境的函数/视图和管理查询。

## 历史归属规则与兼容结论

`llm_provider_name` 是 OpenRouter 路由的底层厂商，不能作为“是否 OpenRouter 调用”的可靠条件。历史回填只允许迁入能由明确调用来源、generation ID 与现有账单/会话关联共同证明的记录；不能证明的行保留在主表并单独计数，直到形成已审阅的处理规则。

新 Backend 上线前后的兼容窗口必须保留主表 13 列：当前和旧 Backend 都会从主表写入或读取 `llm_generation_id`、`llm_finish_reason` 与元数据。目标新表、兼容读写、回填与视图消费者切换完成并经 TEST 验证后，才可停止旧写入。主表 `llm_finish_reason` 不迁移；它保留为业务终态。新表如保留同名字段，仅表达上游原始结束原因，且不得覆盖取消或超时。

## T1 决定与停止条件

T1 完成，允许进入 T2 的设计与实现准备，但不授权直接删除任何旧列。T2 的 migration 必须：

1. 建立 `experience.openrouter_chat_history` 一对一 parent FK、唯一键和仅服务端权限；
2. 明确以何种非内容证据识别 OpenRouter 历史行，并将未知行排除；
3. 先让 Backend 在新表保存 generation ID/元数据并改回捞查询，再处理视图及 Production `base_chat_bj`；
4. 将旧列清理延后到 T3，并以两环境无应用、视图、函数、分析查询和部署版本引用为停止门槛；
5. 对 Venice 账本漂移只记录并隔离，不重跑或改写既有 Venice migration。
