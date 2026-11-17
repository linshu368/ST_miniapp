# 阶段 1：地基与清理

父任务：`11-17-db-reorg`。规则见 `docs/db/CONTRACT.md`，每张表的去向见 `docs/db/registry.yaml`（phase: 1）。

本阶段不搬业务数据，只做三件事：

1. 建立后续阶段要用的地基：`ops`、`cs_feed`；
2. 收窄外部读者的权限；
3. 删除已确认没用的东西。

全部不涉及资金数据，按最简路径执行。

## 事实（2026-11-17 生产只读核对）

- 客服仓库 ST_cs_platform 有三个数据库账号：
  - `cs_runtime_v1`：运行时账号，有活跃连接。读 `app_core.users`、`miniapp_user_settings`、`billing.user_wallets` / `vip_memberships` / `payment_orders`、`experience.chat_sessions`（见 `packages/server/src/domain/{users,conversations,outreach,alerts}.ts`）。
  - `cs_persona_reader`：**在用**。客服"画像簇"功能执行产品同学手写的圈人 SQL，这个账号对业务 schema 有全表 SELECT（客服仓库 `db/migrations/009_product_outreach.sql`、`packages/server/src/personaDb.ts`）。已保存的画像 SQL 直接写主库内部表名，后续拆表会让它失效。
  - `cs_outreach_reader_v1`：两个仓库零引用、无连接，属遗留账号。
- `analytics_grafana` 有 11 个物化视图、35 个视图。只有 `v_user_ecosystem_daily` 与 `miniapp_analytics` 重名。`miniapp_analytics.refresh_grafana_core_day` 引用它。
- `public` 只剩 `compute_daily_metrics`、`show_dashboard` 两个函数。调用它们的两个定时任务 `daily_metrics_midnight` / `daily_metrics_noon` 已停用，最后一次运行报"relation does not exist"。
- `admin.is_managed_config_key` / `validate_managed_config_value` 是包装链，每加一个托管 key 就把旧函数改名为 `*_before_<feature>` 再包一层，共 24 个旧版本。
- 顺带发现（不在本阶段修）：`grafana_core_recent_30m` 近 7 天 336 次中失败 121 次，原因是扫 `chat_history` 超过 5 秒语句超时。阶段 5 瘦身后复查。

## 拆成 5 个 PR，按顺序执行

### 1a 地基（主仓库，只新增）

一个 migration：

- `create schema ops`：只授权 service_role，不给任何外部读者；附 default privileges。
- `create schema cs_feed`，建两个视图：
  - `cs_feed.user_profiles`：输出列与客服仓库 `profileSelect` 一一对应：
    - user_id、tg_id、display_name、username、source_id、registered_at；
    - vip_valid_until、total_paid_amount、paid_count、first_paid_at、last_paid_at；
    - credits_balance、total_rounds、last_chat_at。
    - 以后内部拆表只改这个视图的定义，输出列不变。
  - `cs_feed.user_identities`：user_id、tg_id、display_name、username。供对话列表和告警使用，不带聚合，避免对每一行都算付费统计。
- 授权：
  - `cs_runtime_v1`：两个视图的 SELECT；
  - `cs_persona_reader`：`cs_feed`、`miniapp_analytics` 的 USAGE 和 SELECT。旧授权暂不收回。
- registry：`ops`、`cs_feed` 改为 active，登记视图。

### 1b 客服仓库切换（ST_cs_platform，随便改、可直接上线）

- 4 个 domain 文件改读 `cs_feed.user_profiles` / `cs_feed.user_identities`。
  - 发起回访时"只收主库真实存在的用户"那条 SQL 改用 `cs_feed.user_identities`。
- 画像簇：页面提示和 README 写明可读范围是 `cs_feed.*`、`miniapp_analytics.*`。
  - 现存画像 SQL 由客服同学按新视图改写；我不读 `cs.personas` 的内容。
  - 1c 收权前在客服后台逐个试跑一遍。
- 上线后观察一天：客服工作台的用户资料、对话列表、回访、告警均正常。

### 1c 收权（主仓库）

- 收回 `cs_runtime_v1` 对 `app_core` / `billing` / `experience` 业务表的直接 SELECT 和 schema USAGE。
- `cs_persona_reader` 只保留 `cs_feed`、`miniapp_analytics`。
- `DROP ROLE cs_outreach_reader_v1`。
- 验收：
  - 两个账号直接读业务表报 permission denied；
  - 客服工作台冒烟；
  - 画像试跑通过。

### 1d 清理（主仓库）— `20261117_db_reorg_cleanup.sql`

实际范围（核对依赖后调整）：

- 删列 `app_core.users.st_handle`：代码、函数、视图零引用；可由 tg_id 确定性推导。
  - **`st_initialized_at` 保留**：`miniapp_traffic.record_app_entry` 经 `to_jsonb(u)` 读它作幕间资格依据，阶段 3 随归因字段迁到 `miniapp_traffic.user_attributions`，同步改函数。
- 改名 `miniapp_traffic.botlinks` 两个大写列。依赖视图 `traffic_daily_stats` 按列号引用，输出不变。
- 删表 `miniapp_features.wish_roles` 及 `create_wish_role` / `complete_wish_role` 两个函数。
- 先从 PostgREST 暴露列表（authenticator 的 `pgrst.db_schemas`、`pgrst.db_extra_search_path`，099 起 GUC 接管）去掉 `miniapp`、`cs_platform`，保持原顺序；再删两个 schema；提交时 NOTIFY 先 reload config 再 reload schema。
- 删除 `public.compute_daily_metrics` / `show_dashboard` 与两个停用 cron。`public` schema 本身保留，Supabase 需要它。
- **不迁 `drama_survey_responses`**：问卷仍在线，迁表要改线上发奖函数 `billing.submit_drama_survey`。它是一次性问卷，结束后整表删除，registry 标为 drop。
- 后端：`DOMAIN_SCHEMAS` 去掉 `cs_platform`；legacy guard 的 dropped-schema 规则加入 `cs_platform`。
- 归档：以 Supabase 每日备份为准。删除内容要么可推导（st_handle），要么所有者已确认可丢弃（cs_platform、wish_roles）。
- 验证：`bash scripts/test-db-reorg-p1d-migration.sh`（有 GUC、无 GUC 两种环境）；后端 typecheck 与单测；legacy guard。
- 上线后核对：
  - 生产 `pgrst.db_schemas` 新值；
  - 后端 `/health` 与一次真实对话请求正常；
  - 运营台读写配置正常（admin schema 经 PostgREST）。

### 1e 托管配置包装链改登记表（主仓库加 admin-client）

- 新表 `admin.managed_config_keys(key text PK, value_kind text CHECK, created_at)`。
- `is_managed_config_key` 改为查表；`validate_managed_config_value` 合并为一个函数：
  - 通用部分按 `value_kind` 校验；
  - 个别 key 的结构校验保留为同一函数里的分支。
  - 逐个读 24 个旧函数，把校验原样搬过来，不放宽也不收紧。
- 删除 24 个 `*_before_*`。
- runtime_config 死 key 逐个复核：后端、shared、admin-client、CLI coverage、前端通用配置接口。确认没人读的，在同一 PR 删除 key 行和注册表项。
  - 散装 key 合并成对象 key 放到阶段 3 以后，因为会改动运营台页面。
- 验收：
  - `pnpm -s admin config describe` 列出的 key 与登记表一致；
  - 对每类 key 各发一次草稿，确认校验结果与改造前一致（测试库）。

### 1f 分析 schema 合并（主仓库加 Grafana）

- `analytics_grafana` 的 46 个对象 `ALTER ... SET SCHEMA miniapp_analytics`；重名的 `v_user_ecosystem_daily` 改名为 `v_user_ecosystem_daily_grafana`。
- 改 `miniapp_analytics.refresh_grafana_core_day`；`grafana_reader` / `grafana_cloud` 的授权迁到同名对象上。
- 用 Grafana MCP 找出所有引用 `analytics_grafana.` 的面板，批量替换 SQL。替换前后用同一时间范围对比每个面板的查询结果。
- 删除空的 `analytics_grafana` schema。

## 执行纪律

- 每个 migration 先在测试库通过 `Database Migration` workflow 执行验证，再计划生产。
- **生产执行逐个 PR 先向所有者说明影响，确认后执行。**
- 顺序约束：1b 上线并观察通过后才做 1c；1d 的删表在归档完成后执行。
- 回滚：
  - 1a、1e、1f 可以原样反向（删视图、恢复函数、`SET SCHEMA` 回去）；
  - 1c 可以重新授权；
  - 1d 删表只能从 Supabase 每日备份恢复，所以必须在备份保留期内发现问题。

## 已定

- **归档方式**（所有者 2026-11-17 选定）：不另外导出，以 Supabase 自带的每日备份作为归档。每日备份只保留有限天数，所以：
  - 1d 的删表放在当天备份完成之后执行；
  - 执行前在 Supabase 控制台确认最近一次备份时间；
  - 删除后发现问题，必须在备份保留期内恢复。
