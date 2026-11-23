# 数据库重组阶段 7：schema 与表命名统一

父任务：`.trellis/tasks/11-17-db-reorg`。规则见 `docs/db/CONTRACT.md`，落位见 `docs/db/registry.yaml`。

## 目标

schema 名去掉 `miniapp_` 前缀，表名去掉多余的修饰词并和所属功能对齐，让人和 AI 看名字就能找到对象。用户决定分三批（2026-11-23）：

| 批次   | 时机           | 改名                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第一批 | 现在           | schema：`miniapp_analytics`→`analytics`、`miniapp_features`→`features`、`miniapp_traffic`→`traffic`；表：`analytics.grafana_core_daily`→`core_daily`、`analytics.v_card_quality_session`→`card_quality_sessions`、`features.telegram_community_update_receipts`→`community_update_receipts`、`features.user_lobby_recommendations`→`lobby_recommendations`、`features.character_ranking_scores`→`lobby_ranking_scores`、`features.user_character_exposures`→`lobby_exposures` |
| 第二批 | 随 6b-4        | `billing.character_creator_rewards`→`creator_rewards`、`character_creator_reward_balances`→`creator_reward_balances`、`media_plaza.image_plaza_*`→`image_*`                                                                                                                                                                                                                                                                                                                   |
| 第三批 | 文本计费收缩后 | `experience.chat_history`→`chat_turns`（配 3 个展示视图）、`admin.admin_users`→`admin.operators`                                                                                                                                                                                                                                                                                                                                                                              |

## 约束

- 安全更新：改名走"扩展（改名 + 旧名兼容层）→ 后端与 Grafana 切新名 → 观察旧名停用 → 收缩（删兼容层、PostgREST 去掉旧名）"。任何时刻旧后端都能照常读写。
- 迁移文件执行过就不再修改；生产不能 abandon_claim，失败只能同 checksum 重跑。
- 迁移经 Supavisor 事务池，单文件不依赖会话状态；热路径表的排他锁 lock_timeout 1 秒。
- 不读业务行；生产只看结构与聚合。

## 验收

- 第一批扩展后：旧名字（直接 SQL、Prisma、PostgREST、RPC、Grafana）与新名字的读写结果、权限、RLS 逐条相同；定时任务照常运行。
- 后端发布后：pg_stat_statements 里旧名字的调用停涨（按角色两次采样）。
- 收缩后：三个旧 schema 不存在，PostgREST 暴露列表只有新名字；遗留引用守卫阻止代码再引用旧名字。
