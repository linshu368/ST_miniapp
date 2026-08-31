# 批次 A · 双库基线与差异报告

> 日期：2026-08-25  
> 上游文档：`docs/schema划分-一阶段执行计划.md`（执行剧本）、`docs/schema归属地图.md`（归属权威）、`docs/schema划分专项.md`（依赖底账）  
> 盘点方式：纯 SELECT。脚本 `ops/schema-split/inventory.sql`、`ops/schema-split/dump-functions.sql`，
> 执行器 `ops/schema-split/run-inventory.sh`。**未对任何库执行写动作。**

## 一、盘点范围与产物

| 库         | project ref            | 版本    | 连接                        |
| ---------- | ---------------------- | ------- | --------------------------- |
| test       | `zoqelpfhurwehlvypryl` | PG 17.x | pooler 5432（session mode） |
| production | `wbtsfzozlmurljvglhpn` | 17.6    | pooler 5432（session mode） |

产物（`ops/schema-split/snapshots/2026-08-25/{test,prod}/`）：

- `inventory.txt` — 24 节全量输出；`sections/*.txt` — 按节切分，供逐节 diff
- `functions.sql` — `miniapp` / `admin` / `cs_platform` / `miniapp_traffic` / `miniapp_analytics` / `public` 全部函数的 `pg_get_functiondef`
- `inventory.err` — test 仅 2 条错误，均为 `cron.job` / `cron.job_run_details` 不存在（test 无 pg_cron，预期内）

覆盖：schema / 表 / 视图 / 列 / 函数（含函数体 md5 与 `miniapp.*` 文本引用）/ 触发器 / 约束 /
跨 schema FK / 视图定义 / 索引 / RLS / 表授权 / default ACL / 角色 GUC / publication /
自定义类型 / 扩展 / 注释 / owned sequence / cron job 与运行历史 / 精确行数 / 对象体积 / 活动事务。
另用 REST 探针实测了两库 PostgREST 实际暴露的 schema 列表。

## 二、两库一致的部分（可作为 093 的稳定基线）

1. **`miniapp` 的 22 表 + 1 视图（`current_chat_history`）在两库完全同名同集合**，与归属地图一致。
2. **表级约束**除 `miniapp_traffic.botlinks` 唯一约束命名外逐条一致（176 行）。
3. **跨 schema FK 8 条完全一致**：
   - `cs_platform.audit_logs` / `outreach_messages` / `outreach_sessions` /
     `persona_member_snapshots` / `persona_member_state` → `miniapp.users`（5 条）
   - `miniapp.notifications.created_by`、`miniapp.support_messages.agent_user_id` → `admin.admin_users`（2 条）
   - `admin.admin_users` → `auth.users`（1 条）
4. **RLS policy 仅 4 条，全在 `admin`**，两库一致；`miniapp` 无 policy（表上 `relrowsecurity=t` 但无 policy，靠 service_role 绕过）。
5. **函数数量**：`admin` 48、`cs_platform` 3、`miniapp_traffic` 1，两库一致。
   **`admin` 中函数体含 `miniapp.*` 的恰好 20 个**，与执行计划基线吻合。
6. **`miniapp` 表授权两库逐条一致**：
   - 9 个对象授 `anon`/`authenticated` 的 `SELECT,INSERT,UPDATE,DELETE`：
     `users`、`miniapp_user_settings`、`characters`、`runtime_config`、`chat_history`、
     `daily_checkins`、`payment_orders`、`user_wallets`、`wallet_ledger`
   - `service_role`：21 个对象全权；`character_ranking_scores` 仅 4 权；`current_chat_history` 仅 `SELECT`
   - 所有对象 owner 均为 `postgres`
7. **无自定义类型 / 枚举 / 域**；**`miniapp` 内无 owned sequence**（仅 `miniapp_traffic` 有 2 个，本阶段不动）。
8. **无 publication 包含 `miniapp` 表** → 迁移不涉及 realtime 复制集。
9. **`analytics` schema 在两库均已不存在，`public` 在两库均无任何表/视图** → bot 迁出的表级里程碑确认完成。
10. 盘点时两库均无活动事务（`active_backends=0`），无长事务阻塞 DDL 的迹象。

## 三、差异清单（不擅自抹平，逐项待决）

### A 类 · 阻断级：不解决就无法写出一份通用的 093

#### A1. migration 092 在生产尚未执行

| 证据                        | test | production                                                             |
| --------------------------- | ---- | ---------------------------------------------------------------------- |
| `chat_history` 列数         | 29   | **32**（多 `preset_id` / `user_character_round` / `llm_model_markup`） |
| `current_chat_history` 列数 | 29   | **32**                                                                 |
| `miniapp` 函数数            | 24   | **25**（多 `tf_set_user_character_round`）                             |
| 函数体含 `miniapp.*`        | 23   | **24**                                                                 |
| `chat_history` 触发器       | 2    | **3**（多 `trg_set_user_character_round`）                             |
| 索引                        | —    | **多 `idx_chat_history_character_user_round`**                         |

影响：执行计划 §3.2 的「24 个函数 / 23 个硬编码」基线只对 test 成立。093 的 preflight
如果按 test 形态断言，在生产会直接被自己的断言挡下；如果按生产形态断言，则 test 演练失效。

#### A2. PostgREST 暴露列表两库不同，且生产不是靠数据库 GUC 配置的

REST 探针实测（用不存在的 `Accept-Profile` 触发 PGRST106 hint）：

| 库   | 实际暴露                                                                          | 配置来源                                       |
| ---- | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| test | `public, graphql_public, miniapp, miniapp_traffic, admin`                         | `authenticator` 角色 GUC `pgrst.db_schemas`    |
| prod | `graphql_public, miniapp, miniapp_analytics, miniapp_traffic, cs_platform, admin` | **平台层（Dashboard/Management API），无 GUC** |

生产 `authenticator` 的 `setconfig` 里**只有 `pgrst.db_extra_search_path`，没有 `pgrst.db_schemas`**。
按 `docs/fix-postgrest-schema-exposure.md` 的做法在生产 `ALTER ROLE authenticator SET pgrst.db_schemas`
会**接管并覆盖**平台层配置——一旦漏写 `miniapp_analytics` 或 `cs_platform`，看数与 CS 平台立刻掉线。

顺带记录 `authenticator` 超时差异：test `statement_timeout=8s` / `lock_timeout=8s`；
prod `statement_timeout=120s` / `lock_timeout=30s`。生产也未暴露 `public`。

#### A3. 13 个函数的函数体在两库不一致

不能用一份统一的 `CREATE OR REPLACE` 收口，必须按各库实测源码分别改写限定名。

| schema                 | 函数                                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `miniapp`（7）         | `claim_daily_checkin`、`complete_payment_order`、`expire_payment_orders`、`grant_new_user_signup_bonus`、`grant_wallet_on_user_insert`、`list_character_favorites`、`set_character_favorite` |
| `admin`（2）           | `validate_free_quota_exhausted_dialog_config`、`validate_managed_config_value_before_payment_prompt`                                                                                         |
| `cs_platform`（3）     | `normalize_persona_sql`、`refresh_persona_members`、`validate_persona_sql`                                                                                                                   |
| `miniapp_traffic`（1） | `increment_click`——除函数体外，**属性也不同**：test 为 `SECURITY INVOKER` 无 `search_path`，prod 为 `SECURITY DEFINER` + `search_path=miniapp_traffic, public`                               |

举例：`miniapp.complete_payment_order` 在 test 引用 `miniapp.user_wallets` 4 次，在 prod 引用 6 次。

### B 类 · 需要拍板：形态差异，本阶段可选择对齐或原样迁移

#### B1. `miniapp.characters` 列集合不同（test 多 3 列）

test 31 列 / prod 28 列。test 独有：

| 列             | 类型                             |
| -------------- | -------------------------------- |
| `is_default`   | `boolean NOT NULL DEFAULT false` |
| `is_published` | `boolean NOT NULL DEFAULT true`  |
| `is_active`    | `boolean NOT NULL DEFAULT true`  |

来源是 ST 同步期的 `004_characters_add_sync_fields.sql`；生产侧已被后续 Prisma 迁移摘掉。
**全仓库检索与两库函数体/视图定义均无任何一处引用 `characters` 的这三列**
（代码里的 `is_published` / `is_active` 命中全部属于 `notifications`、`chat_message_audio`、
`admin` 公告表），即 test 上的纯死列。

#### B2. 函数 EXECUTE 授权两库不同（test 更宽松）

test 额外给 `anon` / `authenticated` 授了 EXECUTE，prod 没有，涉及：
`miniapp.claim_daily_checkin`、`complete_payment_order`、`complete_wish_role`、
`create_wish_role`、`expire_payment_orders`、`increment_user_total_round`、
`cs_platform.normalize_persona_sql` / `refresh_persona_members` / `validate_persona_sql`。
另 `miniapp.apply_context_window_flood` 在 test 有 `service_role=X`，prod 只有 `postgres=X`。

093 在新 schema 上重建函数权限时，必须明确按哪一侧为准。

#### B3. 生产 `public` 残留旧 bot 函数 + 两个已停用 cron job

- `public.compute_daily_metrics(date, date)`：读 `miniapp.chat_history`，写
  **`miniapp_analytics.session_metrics_daily`——该表在生产不存在**。
- `public.show_dashboard()`。
- cron job 2（`0 4 * * *`）、job 3（`0 16 * * *`）调用它，两者 `active=f`，
  最后一次运行 2026-08-20 均为 `failed: relation "miniapp_analytics.session_metrics_daily" does not exist`。

也就是说这条链路**在迁移前就已经是坏的**。需要决定：093 一并改限定名、一并清理、还是明确接受它继续坏。

#### B3b. 数据层存的 SQL 文本引用 `miniapp.*`（schema 搬迁不会跟随）

这类引用既不在 `pg_proc.prosrc` 也不在 `pg_get_viewdef` 里，**OID 跟随机制完全帮不上忙**，
搬完就是运行时报「关系不存在」。探测脚本 `ops/schema-split/probe-data-level-refs.sql`。

| 位置                                               | test            | prod             | 处理                                                                                   |
| -------------------------------------------------- | --------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `cs_platform.personas.sql_text`                    | 7 / 8           | **14 / 18**      | **必须在 099 里改写**。运营手工维护的人群规则，`refresh_persona_members` 会 EXECUTE 它 |
| `cs_platform.persona_refresh_runs.sql_text`        | 8               | 273              | **不改写**。历史执行日志，改了就等于篡改审计                                           |
| `admin.audit_logs.schema_name`                     | 99 行 `miniapp` | 271 行 `miniapp` | **不改写**。历史审计记录的是当时的真实位置                                             |
| `miniapp.runtime_config`（`value` / `text_value`） | 0               | 0                | 无需处理                                                                               |
| `admin.config_drafts` / `config_releases`          | 0               | 0                | 无需处理                                                                               |
| `cs_platform.personas.opening_script` / `sop`      | 0               | 0                | 无需处理                                                                               |

生产受影响的人群规则引用了 `miniapp.users`、`miniapp.miniapp_user_settings`、
`miniapp.user_wallets`、`miniapp.payment_orders`、`miniapp.chat_message_audio` 五张表，
跨 `app_core` / `billing` / `experience` 三个新域。另有 4 条已经只读 `cs_platform.user_metrics`
视图（无需改写）。代码侧 `packages/cs-platform/src/constants.ts` 里给运营看的默认 SQL 模板
也要同步改。

#### B4. 生产 PostgREST 暴露 `miniapp_analytics` / `cs_platform`，test 不暴露

与 A2 相关但是独立决策：一阶段完成后，八个物理域里究竟哪些需要经 REST 暴露？
`miniapp_analytics` 若继续暴露，与归属地图「analytics 不得成为任何运行时依赖」的红线需要对齐说明。

### C 类 · 无害但影响 preflight 断言写法

| #   | 差异                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **`miniapp_analytics` 内容完全不同**：test 仅 1 视图 `funnel_stats`；prod 为 1 表 `card_position_snapshot`（16 MB）+ 9 视图，其中 8 个引用 `miniapp.*`                                                                                       |
| C2  | **prod 独有索引**：`idx_miniapp_cohort_chat_user_created`（chat_history）、`idx_miniapp_cohort_paid_orders`（payment_orders）、`card_position_snapshot` 的 2 个索引                                                                          |
| C3  | **prod 有 pg_cron（`pg_catalog`, 1.6.4），test 完全没有**；jobid 1 已被删除但保留运行历史                                                                                                                                                    |
| C4  | **test 有 `pg_trgm`（装在 `public`），prod 没有**                                                                                                                                                                                            |
| C5  | **命名差异**：`miniapp_traffic.botlinks` 唯一约束/索引 test `botlinks_source_id_key` vs prod `botlinks_short_code_key`；`traffic_clicks` 索引 test `idx_tc_source_date` vs prod `idx_miniapp_traffic_clicks_source_date`（定义相同）         |
| C6  | **`miniapp_traffic` 权限差异**：schema ACL test 授 `anon`/`authenticated` USAGE，prod 只授 `service_role`；表授权 test 为全权（含 TRUNCATE/TRIGGER/REFERENCES），prod 仅 4 权                                                                |
| C7  | **列序（ordinal_position）差异**：`characters`、`chat_history`、`current_chat_history`、`miniapp_user_settings`、`user_wallets` 列集合相同但顺序不同。`current_chat_history` 是 `SELECT *`，若 093 需 DROP/CREATE 该视图，两库产物列序会不同 |
| C8  | **test 独有 `aiero` schema**（7 表 + 2 序列 + 26 索引），schema 注释写明「AI风月角色卡提示词抓取平台，与 miniapp / admin 隔离」，且是 test 把 `pg_trgm` 装在 `public` 的原因。不在归属地图内，其中无任何函数，也无跨 schema FK               |
| C9  | prod `default ACL` 多 3 条 `cron` schema 的条目（pg_cron 自带）                                                                                                                                                                              |

## 四、迁移体量与锁风险（production）

| 对象                                  | 行数    | 体积      |
| ------------------------------------- | ------- | --------- |
| `chat_history`                        | 217,807 | **11 GB** |
| `llm_usage_charge_dedup`              | 216,158 | 64 MB     |
| `character_free_chat_quota_decisions` | 124,604 | 31 MB     |
| `llm_usage_charges`                   | 84,837  | 116 MB    |
| `wallet_ledger`                       | 45,762  | 33 MB     |
| `characters`                          | 336     | 30 MB     |
| `users`                               | 5,313   | —         |

`ALTER TABLE ... SET SCHEMA` 只改元数据，11 GB 不会被重写；但仍需 `ACCESS EXCLUSIVE` 锁。
盘点时无长事务。cron job 5 每小时整点读 `miniapp.characters`，**维护窗口应避开整点或先停 job**。

## 五、代码侧基线

| 项                         | 实测                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.schema('miniapp')`       | **22 个文件、42 处**（执行计划记 23 个文件，差异来自 `scripts/import-character.ts` 的归类）                                                                                                                                                                                     |
| `.schema('admin')`         | 29 处（本阶段只需保持可用）                                                                                                                                                                                                                                                     |
| miniapp RPC 调用           | **16 处**，与执行计划一致                                                                                                                                                                                                                                                       |
| Prisma                     | `schemas = ["miniapp"]`，**11 个 model 全部 `@@schema("miniapp")`**；按归属拆分后横跨 `app_core`(4)、`miniapp_features`(2)、`billing`(5)。Prisma 6.19.3，multiSchema 已 GA                                                                                                      |
| raw SQL 硬编码 `miniapp.*` | `routes/cs-platform.ts`(13)、`features/lobby/ranking-stats.ts`(8)、`CsPlatformRepository.ts`(5)、`routes/growth.ts`(1)、`packages/cs-platform/src/constants.ts`(2)、`lib/lobby-latest-badge.ts`、`features/engine/*`、`scripts/seed-config.ts`、`lib/chat-history-logger.ts` 等 |
| `supabase/config.toml`     | `schemas` 仍含已删除的 `miniapp_simulation` / `st_platform` / `st_users` / `st_infra`；缺 `admin` / `cs_platform` / `miniapp_traffic` / `miniapp_analytics`                                                                                                                     |
| Supabase 客户端            | `packages/backend/src/lib/supabase.ts` 只导出单例 `getSupabaseClient()`，无按域绑定入口——执行计划 §4.1 要新增的就是这里                                                                                                                                                         |
| 零消费方 RPC               | **`miniapp.get_character_favorite_counts`** 在代码和数据库内均无任何调用方。本阶段按归属迁入 `miniapp_features` 原样保留，登记为后续清理候选                                                                                                                                    |

库内函数间调用（093 改写函数体时必须一起改）：
`start_chat_history_turn` / `start_chat_history_regeneration` → `guard_chat_session_idle`、`apply_context_window_flood`。

## 五之二、分支与迁移编号基线（批次 A 追加发现）

盘点 092 生产补执行的前提时发现，问题不在数据库，而在分支拓扑。

### 生产实际运行的是 `origin/main`，不是本分支

| 项                               | 实测                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------- |
| 当前工作分支                     | `dev_ST_remove` @ `2ab2df8`                                                       |
| `origin/main`（生产发布分支）    | `bb92844`                                                                         |
| `dev_ST_remove` 落后 main        | **48 个提交**                                                                     |
| `dev_ST_remove` 领先 main        | **2 个提交**：`8ecee42`（chat_history 字段瘦身 = 092）、`2ab2df8`（本轮三份文档） |
| 086–091 是否在 main 上           | 是（随 `9296925` 已并入）                                                         |
| main 的 `chat-history-logger.ts` | 第 141 行写 `llm_model_markup`、第 300 行写 `preset_id`                           |

这与生产库 18:30 最新一行仍写 `llm_model_markup` 的观测完全吻合：
**生产跑的是 main，main 还在写这三列**。所以「先部署当前代码再执行 092」实际含义是
「把 ST_remove 并入 main 并发布一次」，不是一次简单重新部署。

### 代码适配面已经过期

main 的 48 个提交带来了本分支没有的 `miniapp.*` 消费方：

- `packages/backend/src/features/lobby/pinned-characters.ts`（新增）
- `packages/backend/src/features/lobby/ranking-params.ts`（新增）
- `packages/shared/src/api/lobby-ranking-params.ts`（新增）
- `packages/backend/src/features/payment/domain/rechargeRules.ts`：`.schema('miniapp')` 从 3 处变 4 处

| 指标                 | `dev_ST_remove` | `origin/main`   |
| -------------------- | --------------- | --------------- |
| `.schema('miniapp')` | 22 文件 / 42 处 | 21 文件 / 40 处 |
| `.rpc(` 总处数       | —               | 41              |

两侧文件集合不同，**§五的代码基线只对本分支成立，不能直接用于排期**。

### 迁移编号已经三重碰撞

| 序号 | main                                                                                   | dev                                                               | dev_ST_remove                            |
| ---- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| 092  | `092_payment_prompt_dialog_config.sql`                                                 | 同上 + `092_free_quota_exhausted_notice_text.sql`                 | `092_chat_history_drop_dead_columns.sql` |
| 093  | `093_lobby_pinned_characters_config.sql` + `093_payment_prompt_dialog_footer_note.sql` | 同 main                                                           | —                                        |
| 094  | `094_cs_outreach_efficiency.sql`                                                       | 同 main                                                           | —                                        |
| 095  | `095_reconcile_managed_config_keys.sql`                                                | `095_revert_free_quota_exhausted_notice_text.sql`（**不同含义**） | —                                        |
| 096  | —                                                                                      | `096_reapply_free_quota_exhausted_notice_text.sql`                | —                                        |

- **执行计划里的「migration 093」这个编号已被 main 占用两次，不可用。**
- 全部远程分支上的最大序号是 **096**（`origin/dev`、`origin/dev_chatUI_fix_reapply`、`origin/merge-dev-to-main`），
  下一个安全序号是 **097**。
- 两库都已应用 main 的 092–095（证据：`admin.validate_managed_config_value_before_payment_prompt`
  在两库都存在，该函数来自 main 的 092）。也就是说数据库同时承载了两条编号冲突的迁移流。

### 由此产生的排期前置条件

在动手写 schema 划分迁移和代码适配之前，本分支必须先跟上 `origin/main`，否则：

1. 代码适配会漏掉 main 新增的 lobby pinned/ranking-params 三个文件；
2. 后续合并 main 时，冲突面正好落在本次被大规模改写的 repository / 路由文件上；
3. 迁移编号会继续碰撞。

按仓库的 `upstream-merge-protection` 规则，合并时 main 的改动一律按只读处理，
只调整本分支的内容。

## 六、preflight 结论

1. **不能写一份通用 preflight。** A1 决定了两库的对象集合、列集合、触发器和索引都不同。
   要么先把 092 补到生产做形态对齐，要么 093 的 preflight 必须显式分支处理两种形态。
   **建议前者**：092 已在 test 验证过（29 列、单测 213 全绿、MVP 回归 7/7），补执行成本远低于让 093 长出双形态分支。
2. **preflight 不得断言 schema 全集**，否则 test 的 `aiero` 与 prod 的 `cron` 会互相把对方挡下。
   应改为断言「本次要动的对象存在且唯一」+「目标 schema 尚不存在」。
3. **preflight 不得断言索引集合与 `miniapp_analytics` 内容**（C1/C2）。
4. **函数体改写不能靠统一脚本**（A3）。093 应对每个函数按「先 `ALTER FUNCTION SET SCHEMA`
   保 OID，再基于该库实测源码 `CREATE OR REPLACE`」处理，且 postflight 断言
   `pg_proc.prosrc` 中运行时 `miniapp.*` 引用为零。
5. **PostgREST 与 grants 不进事务**（A2/B2）。生产改 GUC 前必须先把当前平台层暴露列表原样抄下来再追加新域。
6. cron 变更无法在 test 演练（C3），生产窗口需单独验证 job 5 的下一次执行结果。

## 七、待拍板事项

| #   | 问题                                                                               | 我的建议                                                                                |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Q1  | 是否先在生产执行 092，把两库形态对齐后再做 093？                                   | **先执行 092**。否则 093 要长出双形态分支，风险和工作量都更高                           |
| Q2  | test 上 `characters` 的 `is_default` / `is_published` / `is_active` 三列怎么办？   | 单独一条小迁移在 test 删掉、对齐生产；不塞进 093                                        |
| Q3  | 新 schema 的函数 EXECUTE 权限按 test（含 anon/authenticated）还是按 prod（不含）？ | **按 prod 收敛**。业务全部走后端 service_role，anon/authenticated 直连 RPC 不是设计意图 |
| Q4  | 生产 `public.compute_daily_metrics` / `show_dashboard` 与 cron job 2/3 怎么处理？  | 本阶段不改行为，只在 093 里同步改限定名；是否删除另开评审                               |
| Q5  | 生产 PostgREST 改用 GUC 接管，还是继续走平台配置？                                 | 用 GUC（可热重载、可版本化），但列表必须包含现有 `miniapp_analytics` / `cs_platform`    |
| Q6  | `miniapp_traffic` 的 grants / schema ACL / 索引命名差异要不要在本阶段对齐？        | **不动**。按仓库的上游保护规则，只做限定名适配                                          |
| Q7  | test 的 `aiero` schema 是否确认与本项目无关、可永久排除在盘点与迁移之外？          | 需你确认一句                                                                            |
