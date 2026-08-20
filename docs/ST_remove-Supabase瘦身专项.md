# Supabase 瘦身专项

> 状态：**本轮粗粒度删除已完成。** 2026-08-20 完成 test 与 production 两库的实测盘点，
> 停用两个坏掉的 pg_cron job，执行 086–091，并删掉 Prisma 里 11 个 `public.*` model。
> 上游文档：`docs/ST_remove.md` §6（专项起点盘点）、`docs/ST_remove-混用清理清单.md`、`docs/ST_remove-整包清理清单.md`
> 前置事实：代码侧 ST 清理已于 2026-08-19 收口，残留全在数据库与控制台。
>
> **本文档的盘点结论全部来自两库实测**（`information_schema` / `pg_class` / `pg_proc` / `pg_stat_user_tables` / `cron.job`），
> 不是对迁移文件的推断——迁移文件与库的实际状态存在多处漂移，见 §2。

---

## 一、专项目标与判定标准

**目标**：删掉不再使用的 schema / 表 / 字段 / 函数，并对库内所有 schema 做一次归属划分，
降低日后的维护成本。

**判定标准**（三条全阴才进删除清单，任一条阳性就先写清消费方再决定）：

| #   | 判据               | 取证方式                                                                                                       |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| 1   | 应用代码是否引用   | 全仓库检索 `.from()` / `.rpc()` / `.schema()` / raw SQL / Prisma model，排除 `migrations/`、`docs/`、`legacy/` |
| 2   | 库内是否被引用     | `pg_proc.prosrc` 正则、`pg_get_viewdef`、`pg_trigger`、`pg_constraint`（FK）、`cron.job.command`               |
| 3   | 生产最后写入与读取 | 表内时间戳列的 `max()`，加 `pg_stat_user_tables` 的 `seq_scan` / `idx_scan` / `n_tup_ins`                      |

**迁移编号**：085 之前为历史；本专项从 **086** 起。

---

## 二、两库结构漂移（盘点的首要产出）

test（`zoqelpfhurwehlvypryl`）与 production（`wbtsfzozlmurljvglhpn`）**不是同构的**。
凡是要写迁移的地方，都必须以生产为准，并检查 test 是否需要补齐。

| 对象                                 | test   | production              | 说明                                                                     |
| ------------------------------------ | ------ | ----------------------- | ------------------------------------------------------------------------ |
| `miniapp.wish_roles` + 2 个 wish RPC | 有     | **无**（已由 086 补齐） | 021 / 023 从未在生产执行，而许愿池是已上线功能，见 §3                    |
| `growth`（3 表 + 1 视图）            | **无** | 有                      | 029 从未在 test 执行，导致渠道归因链路在 test 必挂                       |
| `miniapp_analytics`                  | 1 视图 | 1 表 + 9 视图（12 MB）  | 生产侧是库内手工建的分析层，**不在任何 migration 里**                    |
| `aiero`（7 表 / 108 MB）             | 有     | 无                      | 只存在于 test 库的第三方项目，schema 注释自述「与 miniapp / admin 隔离」 |
| `cron`（pg_cron）                    | 无     | 3 个 job                | 同样不在任何 migration 里，见 §4                                         |
| `public` 函数数量                    | 42     | 13                      | bot 侧历史差异，本专项不介入                                             |

> 结论：`db-migrate` workflow 至今无成功记录（见混用清单 §9.3），历史上迁移靠手工执行，
> 漏执行是常态。本专项每写一个迁移，都要在**两库分别执行并核对结果形态**。

---

## 三、已执行的动作（2026-08-20）

### 3.1 migration 086：修复生产许愿池

**问题**：生产库全库搜不到任何名为 `wish_roles` 的表或 `%wish%` 的函数，但许愿池是已上线功能
（`app.ts` 注册 `wishRoutes`、前端有 `(main)/create/wish/page.tsx` 与 `lib/api/wishes.ts`）。
`MiniappWishRoleRepository` 的每一次调用在生产都会失败。

**为什么不能直接补跑 021 / 023**：021 第 16 行是
`db_user_id UUID REFERENCES public.users(id)`，指向的是**旧 bot 的用户表**；028 才把它改指
`miniapp.users`，而 028 在生产早已执行过、不会重跑。补跑 021 只会建出一张 FK 接错人的表，
插入时照样违反外键。023 则是纯 no-op（只 DROP 一张两库都不存在的 `wish_role_sessions`）。

**做法**：新建 `086_miniapp_wish_roles_repair.sql`，直接落 021 + 028 的合并终态。
两个 RPC 的函数体与 021 逐字相同（test 库跑的就是这份，已知可用），只改 FK 指向与幂等性。
`wallet_ledger` 的 `entry_type` 约束从 5 种放宽到 6 种（补 `wish_reward`）——生产实际用到的
只有 4 种，属纯放宽，不会卡住存量行。

**执行中的一个坑（已解决）**：首次在生产执行时**撞了死锁**并整体回滚。原因是那段"防御性
重指 FK"无条件执行 `DROP CONSTRAINT + ADD CONSTRAINT`，而建 FK 需要 `ShareRowExclusive`
锁住持续写入的 `miniapp.users`。改为**先查 `pg_constraint` 确认指向、已正确则整段跳过**，
并加 `SET LOCAL lock_timeout = '5s'` 让抢不到锁时快速失败而不是死等成环。

**结果**：test 与 production 均执行成功，两库的列、索引、FK、ledger 约束、两个 RPC 完全一致。

生产真机验证已通过（2026-08-20）。

### 3.2 停用两个坏掉的 pg_cron job

`daily_metrics_noon`（jobid 2）与 `daily_metrics_midnight`（jobid 3）自 2026-07-22 起
**连续失败 28 / 29 次**，报错均为 `relation "miniapp_analytics.session_metrics_daily" does not exist`。

已用 `cron.alter_job(job_id, active := false)` 停用（**可逆**，保留 job 定义与命令原文；
`UPDATE cron.job` 会被 Supabase 拒绝，权限只开放给 `cron.alter_job` / `cron.unschedule`）。
`card_position_hourly_snapshot`（jobid 5）保持运行。

被停用的 job 定义备份：

| jobid | schedule (UTC) | 北京时间 | command                                                                                                                                                      |
| ----- | -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2     | `0 4 * * *`    | 12:00    | `SELECT compute_daily_metrics(COALESCE((SELECT MIN(stat_date) FROM miniapp_analytics.session_metrics_daily), '2026-07-05')::DATE, CURRENT_DATE)`             |
| 3     | `0 16 * * *`   | 00:00    | `SELECT compute_daily_metrics(COALESCE((SELECT MIN(stat_date) FROM miniapp_analytics.session_metrics_daily), '2026-07-05')::DATE, (CURRENT_DATE - 1)::DATE)` |

---

## 四、生产 pg_cron 全量（库内隐形消费方）

三个 job 都**不在任何 migration 里**，是直接在库里建的。这类对象删表时最容易被忽略，
因此单列一节。**三个 job 的产出都没有任何下游消费方**——`miniapp_analytics` 的 9 个视图
逐个查过，没有一个引用它们写的表。

| jobid | 名称                            | 频率     | 作用                                                                                                      | 现状                                     | 删除影响                                         |
| ----- | ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| 5     | `card_position_hourly_snapshot` | 每小时   | 从 `miniapp.characters` 抽 `id/name/sort_order/enabled` 快照进 `miniapp_analytics.card_position_snapshot` | 正常，成功 696 次，已攒 5.7 万行 / 12 MB | 卡位历史停止累积；现有数据不受影响。**只写不读** |
| 2 / 3 | `daily_metrics_*`               | 每天两次 | 调 `public.compute_daily_metrics()`，按 30 分钟间隔把 `miniapp.chat_history` 切 session 算轮次与时长      | 已停用（§3.2）                           | 零影响，已一个月无产出                           |

两个必须记账的风险：

- `compute_daily_metrics` 的数据源是 **`miniapp.chat_history` 全表扫描**（现 10 GB）。它目前
  因第一行 DELETE 就报错所以扫不到，但一旦有人把 `session_metrics_daily` 建回来，就会每天
  两次全扫 10 GB。
- `public.compute_daily_metrics` 与 `public.show_dashboard` 是 **`public` → `miniapp` 的反向依赖**：
  bot 的 schema 里有函数在读 miniapp 的核心表。bot schema 日后迁出 project 时，这是待断点。
- jobid 5 依赖 `miniapp.characters` 的 `is_test` / `archived_at` / `sort_order` / `enabled` 四列。
  **列级瘦身阶段动这些列会打挂它**，尤其 `is_test`——它是 062 为 simulation 加的，
  但 simulation schema 删除后这一列仍被此 job 使用，不能顺手删。

---

## 五、Schema 归属划分（边界规则）

这是本专项除删除之外的另一半产出。**A 类之外的 schema，miniapp 的迁移不得引用、不得修改。**

### A 类 · 本专项治理

`miniapp`、`admin`、`cs_platform`、`growth`、`miniapp_traffic`、`miniapp_analytics`、
待删的 `st_platform` / `st_users` / `st_infra` / `miniapp_simulation`，以及生产的 3 个 pg_cron job。

其中 `miniapp_analytics` / `miniapp_traffic` / `cs_platform` **本轮不做删除动作**（与业务链路不直接相关），
但纳入盘点与文档，不划到边界之外——它们读 miniapp 的表、有 cron 在写，划出去等于把坑永久留在库里。

### B 类 · 只划归属，代码与迁移都不得触碰

| Schema      | 体积   | 理由                                                                                                           |
| ----------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `public`    | 4.5 GB | 旧 bot 的活数据，生产库与 bot 共用同一个 project。另有事件触发器 `protect_tables_trigger` 护着 8 张表不被 DROP |
| `analytics` | 8 视图 | 全部读 `bot_users` / `messages` / `public.payment_orders`，属 bot 分析层                                       |

这两个 schema 日后会随 bot 整体迁出当前 project。为此提前做一件**不动库**的事：
删掉 `prisma/schema.prisma` 里 11 个零运行时引用的 `public.*` model 声明
（`User` / `Message` / `bot_user_settings` / `bot_users` / `botlinks` / `chat_snapshots` /
`checkin_logs` / `payment_orders` / `role_data` / `runtime_config` / `traffic_clicks`），
让 miniapp 的代码在类型层面就够不到 bot 的表。**已完成**（顺手去掉已不存在的 `wish_role_sessions` model；`schemas` 现只含 `miniapp`）。

### C 类 · 库外资产

`aiero`（7 表 / 108 MB，**仅存在于 test 库**）：schema 注释自述「AI风月角色卡提示词抓取平台，
与 miniapp / admin 隔离」。不属于本项目，需确认归属方后决定是否从 test 库清除。

---

## 六、删除清单

### 6.1 ST 遗留：整 schema 下线

生产侧最后写入均在 2026-07-22 ~ 07-24，统计窗口内**零读取**（唯一的 seq_scan 是盘点时的
count 查询本身）。

| Schema        | 表                                                                                                                                                                                             | 生产行数              | test 行数                | 备注                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `st_platform` | `platform_settings` / `platform_presets` / `platform_api_configs` / `platform_preset_model_assignments` / `platform_preset_model_assignment_events` / `platform_preset_model_assignment_state` | 9 / 5 / 1 / 0 / 0 / 1 | 12 / 10 / 1 / 2 / 19 / 1 | **实测是 6 张表，不是 `ST_remove.md` §6 记的 3 张**；044 / 053 / 068 陆续加了 3 张 assignment 相关表 |
| `st_users`    | `user_st_settings` / `user_st_chats`                                                                                                                                                           | 136 / 0               | 29 / 0                   | FK 指向 `miniapp.users`、`miniapp.characters`（子表在 st_users 侧，drop 方向安全）                   |
| `st_infra`    | `sync_tasks`                                                                                                                                                                                   | 2984                  | 3694                     | FK 指向 `miniapp.users`                                                                              |

同时下线 `st_platform` 自带的 3 个函数：`canonical_jsonb`、`promote_default_preset`
（触发器 `trg_preset_auto_promote` 挂在 `platform_presets` 上）、`resolve_effective_preset_for_model`（零调用）。

> **拆除顺序硬约束**：`admin` schema 里有 **10 个 RPC 的函数体直接引用 `st_platform.*`**，
> 必须先删这些 RPC，再 drop schema，否则会留下一堆一调就报错的函数。

### 6.2 admin schema：21 个死 RPC（表保留）

运营台的数据分析与审计日志模块已在 commit `62b4767` 删除（`components/analytics/` 现为空目录），
ST 预设管理页已在第一批清理中归档。对应 RPC 全部零调用方：

| 组             | 函数                                                                                                                                                                                                                                                                                                                     | 依据                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| ST 预设（9）   | `create_platform_preset` / `list_platform_presets` / `list_platform_preset_versions` / `list_platform_preset_model_assignments` / `publish_platform_preset` / `set_platform_preset_enabled` / `update_platform_preset_metadata` / `update_platform_preset_model_assignment` / `update_platform_preset_model_assignments` | 引用 `st_platform.*`；admin 前端对应页面已删                                     |
| 数据分析（10） | `get_analytics_dashboard` / `analytics_bucket` / `analytics_require_access` / `get_analytics_chat_detail` / `get_analytics_user_detail` / `list_analytics_chats` / `list_analytics_users` / `list_analytics_outreach_messages` / `list_llm_usage_charges` / `get_llm_usage_charge_detail`                                | 运营台分析模块已删；`get_analytics_dashboard` 同时引用 `st_platform` 与 `growth` |
| 其他（2）      | `list_character_favorite_leaderboard` / `rewrite_model_catalog_is_free`                                                                                                                                                                                                                                                  | 零调用方（后者是 085 的一次性迁移工具）                                          |

> 执行时从 22 个名单里摘掉了 `is_registered_admin`：它被 `admin.admin_users` 上的 RLS policy
> `admin_users_read_self` 使用。`can_access_environment` / `current_environment` /
> `is_managed_config_key` / `snapshot_operator_name` 也是其他 RPC 的内部依赖，不得删。
> 21 个函数的线上定义归档在 `packages/shared/migrations/archive/087_dropped_admin_rpcs.sql`。

**`admin.audit_logs`（生产 20 MB / 532 行）仍被各写操作 RPC 持续写入，但已无任何读取入口。**
本轮保留写入，读取入口作为运营台待办排期。

### 6.3 miniapp 内部死对象

| 对象                                                                                                                                                        | 依据                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `miniapp.chat_message_charges` + 4 个 RPC（`charge_chat_message` / `reserve_chat_message` / `finalize_chat_message_charge` / `refund_chat_message_charge`） | 两库均 0 行且 `n_tup_ins = 0`（从未插入过）。4 个 RPC 在 `MiniappWalletRepository` 有封装但**全仓库无调用方**，这套 016 / 019 时代的旧扣费链路已被 `llm_usage_charges` 取代 |
| `miniapp.character_engagement_stats`（视图）                                                                                                                | 060 建的转化率视图，074 已换成 `character_ranking_scores`；代码与库内均零引用                                                                                               |

### 6.4 growth：整条归因链路下线

生产三张表**全为 0 行**，依赖面干净：`link_clicks` / `miniapp_entries` 的 FK 都在 growth 侧，
唯一的外部引用 `admin.get_analytics_dashboard` 本就在死 RPC 名单里。

关键事实：**前端每次启动打的 `POST /api/growth/miniapp-entry` 一行 `growth.*` 都没用到**，
它走的是 `miniapp_traffic.botlinks` + `miniapp.users.source_id` + `miniapp_traffic.increment_click`。
所以 `routes/growth.ts` 是个混用文件，**要拆不要整删**：

| 接口                                        | 依赖                                          | 处置                                          |
| ------------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| `GET` · `POST /api/cs/growth/channel-links` | `growth.channel_links` / `channel_link_stats` | **删**（CS 前端没有渠道链接管理页，零消费方） |
| `GET /api/growth/click/:sourceId`           | `growth.link_clicks` + 302 重定向             | **删**                                        |
| `POST /api/growth/miniapp-entry`            | `miniapp_traffic.*` + `miniapp.users`         | **留**，一行不动                              |

`shared/src/api/growth.ts` 与 `frontend/src/lib/api/growth.ts` 只保留 miniapp-entry 部分的契约。

> 佐证这套东西从未接完：`growth.miniapp_entries` 全仓库**没有任何 INSERT**，
> 因此 `channel_link_stats` 视图的 `enter_count` / `activated_user_count` 恒为 0。

### 6.5 miniapp_simulation：整 schema 删除

Railway 上的 simulation 独立 project 已停用（2026-08-20 确认），可以删。

生产 2 张表（`chat_log` 3483 行 / 104 MB、`conversations` 831 行）+ 1 个触发器函数
`tf_set_round_index`，两条 FK 指向 `miniapp.characters`（子表都在 simulation 侧，drop 方向安全），
最后写入 2026-08-05，统计窗口内零读写。

> **不要顺手删 `miniapp.characters.is_test`**：这一列虽是 062 为 simulation 加的，
> 但现在被 pg_cron job 5 使用（§4）。

---

## 七、执行序列

| 编号 | 内容                                                                             | 前置                      | 状态                                                   |
| ---- | -------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------ |
| 086  | 建 `miniapp.wish_roles`（021 + 028 修正终态，幂等）                              | 无                        | ✅ test + 生产已执行；真机验证通过                     |
| —    | 停用 pg_cron job 2 / 3                                                           | 无                        | ✅ 生产已执行                                          |
| 087  | 删 `admin` 的 21 个死 RPC（`is_registered_admin` 因 RLS 保留）                   | 无                        | ✅ test + 生产已执行                                   |
| 088  | 导出留档后 `DROP SCHEMA st_platform / st_users / st_infra CASCADE`               | **必须在 087 之后**       | ✅ test + 生产已执行；CSV 在 `/tmp/st-schema-archive/` |
| 089  | `DROP SCHEMA growth CASCADE` + 代码摘掉两条 CS 路由与 click 重定向               | 代码与迁移同批上线        | ✅ test + 生产已执行；代码已改，待部署                 |
| 090  | `DROP SCHEMA miniapp_simulation CASCADE`                                         | Railway project 已停用 ✅ | ✅ test + 生产已执行                                   |
| 091  | 删 `miniapp.chat_message_charges` + 4 个 RPC + `character_engagement_stats` 视图 | 无                        | ✅ test + 生产已执行；Prisma model 与仓库封装已删      |
| —    | Prisma 删 11 个 `public.*` model 声明（只改代码不动库）                          | 无                        | ✅                                                     |

每个迁移单独一个文件、单独执行、**先 test 后 production 并核对结果形态**。
数据留档用 `psql COPY` 落到 `/tmp/st-schema-archive/`（含用户镜像，不进 git）；本地 pg_dump 14 打不开生产 17。

---

## 八、下一阶段：列级瘦身（不在本轮）

`miniapp.chat_history` 是项目核心资产，**本轮不碰**，留待字段粒度阶段。已实测到的输入：

- 体积构成：heap 302 MB + **TOAST 9888 MB** + 索引 100 MB，**97% 集中在 `history` 一列**
  （每轮完整 prompt 快照，平均约 55 KB/行）
- 行构成：18.3 万行 = **12.36 万行 ST 存量**（`session_id IS NULL`，07-06 至 08-12）
  - 5.9 万行自研链路（08-12 至今）
- 死字段：最近 5000 行里 `preset_id` 与 `llm_usage_cache` 的非空数**都是 0**。
  `preset_id` 的处置要连 `GenerationRequest.presetId` 参数一起定（见 `ST_remove.md` §6）

其他列级待办：

- `miniapp.users.st_handle`（**NOT NULL UNIQUE**）/ `public.users.st_handle` / `st_initialized_at`：
  唯一写入方是 `backend/src/lib/user.ts`。顺序是**先改代码停写 → 去 NOT NULL/UNIQUE → 删列
  → `shared/src/st-bridge/handle.ts` 及其测试退场**，中间要留观察窗口
- `miniapp.characters.is_test`：受 pg_cron job 5 依赖，动之前先处理 job

---

## 九、盘点数据附录（2026-08-20 实测）

### 9.1 生产库 schema 全景

| Schema               | 表  | 视图 | 体积   | 归属                       |
| -------------------- | --- | ---- | ------ | -------------------------- |
| `miniapp`            | 23  | 2    | 10 GB  | A · 主体                   |
| `public`             | 12  | 0    | 4.5 GB | B · 旧 bot                 |
| `miniapp_simulation` | 2   | 0    | 104 MB | A · 待删                   |
| `admin`              | 8   | 0    | 21 MB  | A                          |
| `cs_platform`        | 8   | 2    | 16 MB  | A · 本轮不动               |
| `miniapp_analytics`  | 1   | 9    | 12 MB  | A · 本轮不动               |
| `st_users`           | 2   | 0    | 4.3 MB | A · 待删                   |
| `st_platform`        | 6   | 0    | 1.5 MB | A · 待删                   |
| `st_infra`           | 1   | 0    | 768 kB | A · 待删                   |
| `miniapp_traffic`    | 2   | 1    | 176 kB | A · 本轮不动（归因主链路） |
| `growth`             | 3   | 1    | 80 kB  | A · 待删                   |
| `analytics`          | 0   | 8    | —      | B · 旧 bot                 |
| `cron`               | 2   | 0    | 416 kB | A · 见 §4                  |

Supabase 系统 schema（`auth` / `storage` / `realtime` / `vault` / `extensions` /
`supabase_migrations`）不在盘点范围。

### 9.2 生产 miniapp 表体积 Top 8

| 表                                    | 行数    | 体积      |
| ------------------------------------- | ------- | --------- |
| `chat_history`                        | 181,972 | **10 GB** |
| `llm_usage_charges`                   | 71,886  | 111 MB    |
| `llm_usage_charge_dedup`              | 130,370 | 51 MB     |
| `characters`                          | 292     | 28 MB     |
| `wallet_ledger`                       | 27,003  | 26 MB     |
| `character_free_chat_quota_decisions` | 90,499  | 23 MB     |
| `chat_sessions`                       | 4,211   | 3.7 MB    |
| `users`                               | 4,701   | 1.3 MB    |

其余 15 张表合计不到 5 MB。

### 9.3 Storage buckets（代码引用）

`character-assets`（可由 `CHARACTER_STORAGE_BUCKET` 覆盖）、`miniapp-user-avatars`、
`miniapp-chat-voice`。本专项未盘点桶内对象，如需清理另开。
