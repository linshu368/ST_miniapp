# Supabase 测试库结构参考

> **证据：TEST-DB（用户指定的 MCP 项目）**。采集时间：2026-09-07 07:54–07:58 UTC（Asia/Shanghai 15:54–15:58）；项目名 `linshu368's Project`，ref `lhcyrmigpqeloxjrfwmn`，区域 `ap-southeast-1`，PostgreSQL `17.4.1.064`。仅通过 Supabase MCP 的项目元数据、`list_tables`、migration/security advisor 与 catalog 只读 SQL 采集；未读取业务行。
>
> **重要 GAP**：仓库 `package.json`、backend example、migration README、架构文档和 GitHub Actions 均把 `zoqelpfhurwehlvypryl` 定义为正式 test ref。当前 ref 由用户在本次会话明确指定为“测试库”，但与仓库部署门禁不一致。因此本文只代表**本次指定参考库**，不能用于执行仓库 migration、替代正式 test 验收，更不代表生产库。

## 1. 范围与总览

| Schema           |  表 | 视图 | 序列 | 说明                                                                     |
| ---------------- | --: | ---: | ---: | ------------------------------------------------------------------------ |
| `public`         |   4 |    0 |    1 | 旧式聊天/角色数据；PostgREST 暴露面，当前四表均关闭 RLS                  |
| `st_telegrambot` |  12 |    0 |    5 | bot 侧用户、消息、角色、支付、流量和运行时配置；包含 Prisma migration 表 |
| `auth`           |  23 |    0 |    1 | Supabase 系统 schema，只计数，不展开                                     |
| `storage`        |   8 |    0 |    0 | Supabase 系统 schema，只计数，不展开                                     |
| `realtime`       |   3 |    0 |    1 | Supabase 系统 schema，只计数，不展开                                     |

仓库目标业务 schemas `app_core`、`miniapp_features`、`experience`、`billing`、`admin`、`cs_platform`、`miniapp_traffic`、`miniapp_analytics` 在本库均不存在。未发现业务 view/materialized view、enum/custom type 或 `cron` schema。

Supabase migration history 仅有三条：`create_st_telegrambot_schemas`、`create_st_telegrambot_tables`、`create_st_telegrambot_indexes_and_clone_test`（版本分别为 `20260820132248`、`20260820132331`、`20260820132616`）。

## 2. `public` schema

### `public.snapshots` — 历史聊天快照

- 主键：`snapshot_id`；无 FK/unique/check；无额外索引；无 policy。
- 字段：`snapshot_id text NOT NULL`；`user_id text?`；`role_id text?`；`name text?`；`model text?`；`system_prompt text?`；`messages jsonb?`；`created_at timestamptz?`。

### `public.users`

- 主键：`user_id`；无 FK/unique/check、额外索引、trigger 或 policy。
- 字段：`user_id text NOT NULL`；`snapshot_ids text[]?`；`created_at timestamptz?`。

### `public.role_library` — AI 角色库

- 主键：`role_id`；索引：`name`、`created_at`、`role_id` btree，`tags` GIN；无 policy。
- 字段：`role_id text NOT NULL`；`name text NOT NULL`；`avatar text?`；`tags text[]? DEFAULT {}`；`summary text?`；`system_prompt text?`；`history jsonb? DEFAULT []`；`model text?`；`deeplink text?`；`created_at timestamptz?`；`post_link text?`。

### `public.messages` — 用户与机器人聊天消息

- 主键：`id`；索引：`user_id`、`session_id`、`timestamp`；trigger `set_messages_timestamps_trigger` 在 insert/update 前调用 `public.set_messages_timestamps()`；无 policy。
- 字段：`id int NOT NULL DEFAULT sequence`；`user_id text NOT NULL`；`role_id text?`；`session_id text?`；`timestamp timestamp?`；`instructions text?`；`bot_reply text?`；`history text?`；`model_name text?`；`user_input text?`；`round int?`；`full_response int?`；`attempt_count int?`；`first_response_latency float8?`；`model text?`；`generation_time float8?`；`latency float8?`；`native_tokens_prompt int?`；`native_tokens_completion int?`；`native_tokens_reasoning int?`；`native_tokens_cached int?`；`cache_discount float8?`；`usage jsonb?`；`finish_reason text?`；`provider_name text?`。

## 3. `st_telegrambot` schema

`?` 表示 nullable；未写 `?` 的字段为 NOT NULL。除特别说明外，无 trigger/policy。所有业务表均关闭 RLS；MCP privilege 结果显示该 schema 的表授权给 `postgres`/`service_role`，未显示 `anon`/`authenticated` 表授权。

### 用户与设置

- **`users`**：PK `id`；unique `tg_id`、`st_handle`；按 `source_id, created_at` 的部分覆盖索引。字段：`id uuid DEFAULT gen_random_uuid()`、`tg_id text`、`bonus_credits int DEFAULT 660`、`main_credits int? DEFAULT 0`、`total_credits int? GENERATED ALWAYS`、`first_paid_at timestamptz?`、`last_paid_at timestamptz?`、`total_paid_amount numeric DEFAULT 0`、`source_id text?`、`last_checkin_at timestamptz?`、`created_at timestamptz DEFAULT now()`、`updated_at timestamptz DEFAULT now()`、`st_handle text?`、`st_initialized_at timestamptz?`。
- **`bot_users`**：PK `id`；unique `user_id`；按 `source_id, created_at` 的部分覆盖索引。字段：`id uuid DEFAULT gen_random_uuid()`、`user_id text`、`tg_username text?`、`tg_first_name text?`、`tg_last_name text?`、`created_at/updated_at timestamptz DEFAULT now()`、`bonus_credits int DEFAULT 660`、`main_credits int? DEFAULT 0`、`total_credits int? GENERATED ALWAYS`、`first_paid_at/last_paid_at timestamptz?`、`total_paid_amount numeric DEFAULT 0`、`source_id text?`、`total_round bigint? DEFAULT 0`、`last_checkin_at timestamptz?`、`pref_word_count text DEFAULT '300-500'`、`pref_show_options boolean DEFAULT true`、`pref_custom_instructions text?`。
- **`bot_user_settings`**：PK/FK `user_id uuid → st_telegrambot.users(id)`；`tg_username/tg_first_name/tg_last_name text?`、`total_round bigint DEFAULT 0`、`pref_word_count text DEFAULT '300-500'`、`pref_show_options boolean DEFAULT true`、`pref_custom_instructions text?`、`created_at/updated_at timestamptz DEFAULT now()`。
- **`checkin_logs`**：PK `id bigint IDENTITY`；索引 `user_id, checked_in_at DESC`。字段：`user_id text`、`reward int`、`checked_in_at timestamptz DEFAULT now()`。

### 对话、角色与配置

- **`messages`**：PK `id int IDENTITY`；索引 `user_id`、`session_id`、`accept_at`、`user_id + accept_at`。字段：`user_id text`；`role_id text?`；`accept_at timestamptz?`；`instructions/bot_reply/history/model_name/user_input text?`；`round/full_response/attempt_count int?`；`first_response_latency float8?`；`meta_model text?`；`meta_generation_time/meta_latency float8?`；四个 `meta_native_tokens_* int?`；`meta_cache_discount float8?`；`meta_usage jsonb?`；`meta_finish_reason/meta_provider_name/type/trace_id/session_id text?`；`created_at timestamptz?`；`credits_deducted int?`；`credits_account text?`；`user_preferences jsonb?`。
- **`chat_snapshots`**：PK `id uuid DEFAULT gen_random_uuid()`；索引 `user_id`。字段：`user_id text`、`role_id text?`、`snapshot_name text?`、`history jsonb DEFAULT []`、`created_at timestamptz? DEFAULT now()`、`round int? DEFAULT 0`。
- **`role_data`**：PK `id bigint IDENTITY`；unique `role_id`。字段：`role_id text`；`spec text? DEFAULT 'chara_card_v2'`；`spec_version text? DEFAULT '2.0'`；`name/description/personality/scenario/first_mes/mes_example/creator/character_version/creator_notes/system_prompt/post_history_instructions text?`；`alternate_greetings jsonb? DEFAULT []`；`character_book jsonb?`；`tags jsonb? DEFAULT []`；`title/summary/deeplink text?`；`created_at/updated_at timestamptz DEFAULT UTC now()`；`avatar/post_link text?`；`published_at timestamp?`。
- **`runtime_config`**：PK `key text`。字段：`value jsonb?`、`description text?`、`version int? DEFAULT 1`、`updated_at timestamptz? DEFAULT now()`、`text_value text?`。本文未读取任何配置值。

### 支付与流量

- **`payment_orders`**：PK `transaction_id text`；索引 `user_id`、`payment_status`、`created_at`，以及 completed 订单的部分覆盖索引。字段：`user_id text`、`amount numeric`、`credits_amount int DEFAULT 0`、`payment_status text DEFAULT 'pending'`（check：`pending/completed/failed/expired`）、`payment_provider text`（check：`alipay/wxpay`）、`provider_transaction_id text?`、`credits_added boolean DEFAULT false`、`created_at timestamptz DEFAULT now()`。
- **`botlinks`**：PK `id bigint IDENTITY`；`source_id text?` 有 unique constraint，另存在多个重复语义 unique index。字段：`bot_link text?`、`created_at timestamptz? DEFAULT now()`、`source_name text?`、`start_time/end_time date?`、`Purchase_amount/Procurement_days int?`。两个字段使用非标准大写命名，是当前实况，不应在文档中静默改名。
- **`traffic_clicks`**：PK `id bigint IDENTITY`；unique `(stat_date, source_id)`；另有 `(source_id, stat_date)` 索引。字段：`stat_date date DEFAULT current_date`、`source_id text`、`clicks int DEFAULT 0`、`created_at/updated_at timestamptz DEFAULT now()`。
- **`_prisma_migrations`**：Prisma 内部 migration tracking 表，8 个标准字段；不作为业务契约使用。

## 4. 函数、类型、触发器与安全

| 函数                                | 返回      | 语言      | 安全/波动性                           | 使用点                                  |
| ----------------------------------- | --------- | --------- | ------------------------------------- | --------------------------------------- |
| `public.set_messages_timestamps()`  | `trigger` | `plpgsql` | invoker；volatile；未固定 search_path | `public.messages` insert/update trigger |
| `public.update_updated_at_column()` | `trigger` | `plpgsql` | invoker；volatile；未固定 search_path | 当前未发现业务 trigger                  |

`public` 还包含 `postgres_fdw` 扩展带来的 5 个 C 函数，不应当作应用 RPC。未发现业务 enum/custom type、materialized view 或 cron。

### 必须显式暴露的安全问题

1. **严重：`public` 四表全部关闭 RLS**，且 catalog 显示 `anon` 和 `authenticated` 对四表均拥有 `SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER`。在 PostgREST 暴露配置下，可导致匿名/登录客户端读写全部行。不得直接只执行 `ENABLE RLS`：没有 policy 会立即阻断现有访问，必须先盘点消费者并设计最小权限策略。[Supabase RLS 修复说明](https://supabase.com/docs/guides/database/postgres/row-level-security)
2. 两个 PL/pgSQL trigger 函数未固定 `search_path`。[Database linter 0011](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable)
3. `postgres_fdw` 安装在 `public` schema。[Database linter 0014](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public)
4. 当前 PostgreSQL 构建有可用安全补丁。[升级说明](https://supabase.com/docs/guides/platform/upgrading)

以上仅记录 advisor/目录实况，本任务不自动执行修复 SQL。

## 5. 与仓库声明的差异（GAP）

| 证据对比                                                                                                           | 差异                                 | 影响/结论                                                                    |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------- |
| 仓库 test ref `zoqelpfhurwehlvypryl` vs 本次 MCP ref `lhcyrmigpqeloxjrfwmn`                                        | 项目身份不同                         | 本文不能替代正式 test 环境参考；GitHub migration workflow 也不会接受当前 ref |
| `packages/shared/migrations/` 119 个 SQL（`001_*` 至 `109_*`，存在编号分支/重复前缀）vs MCP migration history 3 条 | 迁移链完全不同                       | 当前库没有应用 migration 链的可审计执行记录                                  |
| migrations/schema 文档声明的 8 个目标业务 schema vs 当前只有 `public`/`st_telegrambot` 业务表                      | 当前库缺失全部目标 schema            | Admin、CS、MiniApp、billing 等新契约不能依据本库验证                         |
| 仓库迁移大量声明 `public`/目标 schema 对象 vs 本库仅 16 个业务/跟踪表                                              | 对象集合和定义显著漂移               | 不应尝试通过补写本文“对齐”；需连接正式 test ref 后重新采集                   |
| `supabase/config.toml` 的 `schema_paths=[]`                                                                        | CLI 不会自然重放 shared migration 链 | 继续采用仓库单文件 GitHub workflow；当前参考库不可作为执行目标               |
| 仓库 RLS/grant 安全规范 vs 当前 `public` 全权限且 RLS off                                                          | 权限模型不满足目标规范               | 应创建独立安全整改任务，先调查消费者和发布顺序                               |

## 6. 维护规则与下一步

- 若后续 MCP 可访问正式 test ref `zoqelpfhurwehlvypryl`，必须重新采集并以新时间戳替换/并列本文，而不是假设两个项目同构。
- 任何数据库变更后都应重跑 relations/columns/constraints/indexes/RLS/functions/grants/advisors，并保留 GAP。
- 禁止将本文作为生产结构、业务行数、容量或数据质量证据；本次仅使用表计数辅助结构检查，未导出数据。
- 优先后续任务：确认测试项目治理；修复 `public` 暴露/RLS；固定函数 `search_path`；核对 PostgreSQL 升级；清理重复索引前先验证写流量和依赖。
