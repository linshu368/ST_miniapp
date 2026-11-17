# 设计：阶段 2 观测外迁

总计划见 `../11-17-db-reorg/design.md` 阶段 2；规则见 `docs/db/CONTRACT.md`。

## 2a 经营看板日汇总刷新

### 现状（2026-11-17 生产实测，只读）

- 定时任务 `grafana_core_recent_30m`（`7,37 * * * *`，GMT）在同一条命令里刷新今天和昨天，每条语句 5s 超时。pg_cron 把整条命令放在一个事务里，任一条超时会连另一条一起回滚。
- 函数对当天每条聊天记录逐行查 `openrouter_chat_history`、`venice_chat_history`（按 `chat_history_id`）和 `billing.llm_usage_charges`（按 `charge_key`）。
- 当天 4533 行的执行计划（EXPLAIN ANALYZE）：总 5.8s。其中 openrouter 逐行查 3.1s（读盘 1950 块），计费表逐行查 1.7s（读盘 1004 块），venice 全表扫 0.6s（读盘 613 块）。磁盘读约 1ms/块。
- 11-17 10:00–13:40（北京时间）8 次跑了 6 次失败，看板停更 2 小时。
- 供应商明细行写入比聊天记录晚 0–111 秒（openrouter 近 14 天 16934 行，venice 近 30 天 3284 行），从不更早。

### 改法

1. 函数同签名、同输出、同权限。两张供应商明细表先按 `created_at` 取窗口 `[当天 00:00 - 5 分钟, 次日 01:00)`（走已有的 created_at 索引），物化后与当天聊天记录哈希配对。`chat_history_id` 在两张表都唯一，窗口覆盖全部实测延迟，结果与逐行查一致。
2. 计费表仍按 `charge_key` 逐行查（没有 created_at 索引；它在阶段 6 被 `billing.usage_charges` 取代）。
3. 定时任务拆两个：
   - `grafana_core_recent_30m`：只刷新今天，20s 上限；
   - `grafana_core_yesterday_close`：`17 16-22 * * *`（GMT，即北京时间 00:17–06:17 每小时），只刷新昨天，30s 上限，收尾跨零点的结算。
   - 两者仍共用函数里的 advisory lock，重叠时后到的直接返回。
4. 预计：今天全天约 8000 行时，刷新约 3 秒（计费表 2.5s + 聊天记录 0.4s），供应商部分降到可忽略。

### 验证

- 本地：`bash scripts/test-db-reorg-p2a-migration.sh`。PG17 非超级用户执行；保存旧函数副本，在 3 天随机合成数据（含跨零点、空串型号、非数值 usage、缺计费、余额不足、退款状态）上逐天比较新旧输出，逐行一致；两次执行幂等；cron 命令与时间；权限不扩大；无 pg_cron 时只装函数。
- 生产执行前：只读跑一次新旧两种写法对昨天的聚合，比较一致。
- 生产执行后：看 `cron.job_run_details` 连续几次成功和耗时；看板「最近两日数据更新时间」恢复到 30 分钟内。

### 回滚

重新执行 `20261026_grafana_light_core.sql` 中的函数与 cron 段。汇总表是派生缓存，随时可重算。

## 2b 整表迁入 ops，删除短剧旧 SQL 链路

### 迁入 ops（`20261117_db_reorg_ops_alerts_free_zone_events.sql`）

| 原位置                              | 新位置                                      | 读写方                                                                                            |
| ----------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `app_core.alert_incidents`          | `ops.alert_incidents`                       | `backend/src/features/alerting/repository.ts`                                                     |
| `app_core.alert_delivery_attempts`  | `ops.alert_delivery_jobs`（J，投递 outbox） | `repository.ts`、`delivery-worker.ts`                                                             |
| `miniapp_features.free_zone_events` | `ops.free_zone_events`                      | `free-zone/repository.ts`、`admin-status.ts`；分析视图 `miniapp_analytics.free_zone_model_events` |

- `ALTER TABLE ... SET SCHEMA` 原样搬，数据、索引、约束、序列、RLS、授权随表走；分析视图按 OID 引用自动跟随。生产上这三张表没有函数或 cron 引用。
- 后端只用 Prisma 原生 SQL（写死 schema 名），不经 PostgREST，`ops` 不需要加入暴露列表。
- 旧位置留同名兼容视图（`security_invoker`，授权同原表），让迁移之后、后端发布之前的旧后端照常工作。后端上线生产后，由阶段 2 下一个 migration 删除。
- 本地测试用后端真实 SQL 打兼容视图和 `ops` 两边：`FOR UPDATE`、`INSERT ... RETURNING`、`ON CONFLICT DO NOTHING`、`UPDATE ... FROM`（`FOR UPDATE SKIP LOCKED`）。

`billing.payment_operation_events` 不在本步：它的写入函数 `billing.record_checkout_confirmation` 在结账链路上，且发现快速对账每 30 秒反复查询已过期订单（单日 24,591 次，13 笔订单），表一天涨约 2.5 万行。与阶段 4 支付对账一起处理，进生产前先问所有者。

### 删除短剧旧 SQL 链路（`20261117_db_reorg_drop_drama_playback_sql.sql`）

- 10-29 起不再写库，11-04 已删写库代码与开关；表中只剩 10-27~10-29 的 1307 行，旧看板只看 14 天，11-12 起为空。短剧诊断已改走 Loki（`st-engineering-drama`）。
- 删除表（含策略）、视图 `drama_playback_facts`、两个函数、停用的 cron `drama_metrics_cleanup_daily`、组角色 `drama_metrics_reader`（`grafana_cloud` 仍经 `first_token_metrics_reader` 读其他分析视图）。
- 迁移内守卫：11-01 之后有写入、或有其他函数/视图依赖时拒绝执行。
- Grafana：删除看板 `st-drama-playback`，移除 `st-engineering-backend`、`st-engineering-drama` 指向它的链接；仓库 JSON 同步。

### 发布顺序

1. TEST 执行两个 migration；dev 后端（TEST 环境）切到 `ops`。
2. 生产执行两个 migration（兼容视图让旧后端照常工作），删 Grafana 看板与链接。
3. 后端发布：从最新 main 拉发布分支，只带本步后端改动。
4. 生产后端上线后核对告警写入与畅聊事件写入落在 `ops`，再在下一个 migration 删兼容视图。

## 2c 及之后（待逐个设计）

- 上游调用合并：`ops.llm_calls` 收 3 张供应商表与 `free_zone_calls` 的明细和成本；畅聊多路调用身份进 `chat_generation_attempts`。改 `select_chat_generation_delivery`、`conversation-history-billing`、`surplus-billing-recovery`、`free-zone/call-costs` 的读取。2a 的函数随之改读 `ops.llm_calls`。
- `chat_generation_requests` 纯测速列外迁到 `ops.chat_generation_timings`，逐列对照三个读取函数确认。
- 其余 O 表进 `ops`（支付事件随阶段 4、媒体生成调用）。
- `miniapp_analytics` 视图改读 `ops`，收回 `first_token_metrics_reader` 对 `experience` 的直接授权；前后对比看板数字。
