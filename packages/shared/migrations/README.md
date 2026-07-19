# SQL 迁移文件

> **权威源**：本目录的 schema 设计**完全遵循** [`/DECISIONS.md`](../../../DECISIONS.md) 中的"分区与形态总览"章节、D001-D014 决策，以及 [`/Schema划分设计.md`](../../../Schema划分设计.md) 的两维方案。本 README 仅作为执行索引，决策依据请查阅 DECISIONS.md。

## Schema 架构（D014 三 schema 切分）

| Schema        | 性质                          | 阶段一表                                                               |
| ------------- | ----------------------------- | ---------------------------------------------------------------------- |
| `public`      | 共用基础                      | `users`（扩展 `st_handle` / `st_initialized_at`）                      |
| `miniapp`     | 运营业务                      | `characters`（D003 复用，D011 新增同步字段）+ 现有运营表（不参与同步） |
| `st_platform` | 分区 A：平台管控（D014 新增） | `platform_settings` / `platform_presets` / `platform_api_configs`      |
| `st_users`    | 分区 B：用户镜像（D014 新增） | `user_st_settings` / `user_st_chats`                                   |
| `st_infra`    | 同步引擎运维基建（D014 新增） | `sync_tasks`（未来 audit / metrics / locks 也进此 schema）             |

跨 schema FK：`st_users.user_st_chats.character_id` FK 到 `miniapp.characters`（PG 原生支持）；`st_infra.sync_tasks.user_id` FK 到 `public.users`。

> 早期版本（D010-D013）所有 ST 同步层表都在统一的 `st` schema 下，D014 后拆分为三个语义角色 schema。决策依据见 DECISIONS.md D014。

## 使用方式

阶段一采用原生 SQL 迁移（详见 D004），Schema 稳定后切换到 Prisma migrate。当前仓库提供三种执行方式：

- **GitHub Actions**：使用 `.github/workflows/db-migrate.yml` 手动触发执行指定 SQL 文件，推荐用于测试分支和受控生产变更。
- **本地 Supabase CLI**：使用根目录 `pnpm supabase:*` 脚本执行本地服务、项目链接或指定 SQL 文件。
- **Supabase Studio**：在 SQL Editor 中按文件名数字前缀逐个执行，作为 CLI/CI 无法连接数据库时的备用方式。

### 本地 Supabase CLI

仓库根目录已安装 `supabase` CLI，并保留 `packages/shared/migrations/*.sql` 作为 SQL 迁移源；不要把迁移文件复制到 `supabase/migrations` 形成两套来源。

```bash
pnpm supabase --version
pnpm supabase:status
pnpm supabase:start
pnpm supabase:stop
```

链接远程项目时需要先登录 Supabase CLI（或设置 `SUPABASE_ACCESS_TOKEN`）：

```bash
pnpm supabase login
pnpm supabase:link:test
pnpm supabase:link:prod
```

本地或远程执行单个 SQL 文件时，沿用 CI 的 `db query --file` 方式：

```bash
pnpm supabase:db:query -- --db-url "$DATABASE_URL" --file packages/shared/migrations/025_preset_auto_promote.sql
```

### GitHub Actions 执行

在仓库 Secrets 中配置：

| Secret                  | 用途                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN` | Supabase Management API token，供 Supabase CLI 使用                |
| `TEST_DATABASE_URL`     | `test` 分支 Postgres 连接串，必须包含 `zoqelpfhurwehlvypryl`       |
| `PROD_DATABASE_URL`     | `production` 主库 Postgres 连接串，必须包含 `wbtsfzozlmurljvglhpn` |

执行路径：

1. GitHub → Actions → `Database Migration`
2. 点击 `Run workflow`
3. 选择 `environment`
4. 填写 `migration_file`，例如：
   - `packages/shared/migrations/014_miniapp_payment_wallet.sql`
   - `packages/shared/migrations/015_miniapp_settings_wallet_ops.sql`
   - `packages/shared/migrations/016_miniapp_wallet_ledger_chat_idempotency.sql`
   - `packages/shared/migrations/017_miniapp_wallet_payment_summary.sql`
   - `packages/shared/migrations/018_miniapp_free_chat_idempotency.sql`
   - `packages/shared/migrations/019_miniapp_billing_checkin.sql`
   - `packages/shared/migrations/020_drop_legacy_app_chat_tables.sql`
   - `packages/shared/migrations/021_miniapp_wish_roles.sql`
   - `packages/shared/migrations/023_move_wishes_to_miniapp.sql`
   - `packages/shared/migrations/024_cs_platform.sql`
5. 如选择 `production`，必须在 `confirm_production` 填入 `RUN_PRODUCTION_MIGRATION`

Workflow 会在执行前校验连接串中的 project ref。`test` 只能连接 `zoqelpfhurwehlvypryl`，`production` 只能连接 `wbtsfzozlmurljvglhpn`。

> 当前部署流程不会在应用启动时自动执行 SQL migration；`packages/backend` 的 `start` 仅执行 `prisma generate` 后启动服务。上线数据库变更时必须手动触发上述 `Database Migration` workflow，逐个指定 `packages/shared/migrations/*.sql` 文件。

### 全新部署（首次跑）

```bash
# 里程碑 A（D1）：身份扩展
001_users_add_st_fields.sql        # 扩展 public.users.st_handle / st_initialized_at
002_users_backfill_st_handle.sql   # 回填 tg_<tg_id>，依赖 001

# 里程碑 A（D2 + D014）：建三个 schema + 6 张同步表
003_create_st_schemas.sql          # CREATE SCHEMA st_platform / st_users / st_infra（D014）
004_characters_add_sync_fields.sql # ALTER miniapp.characters 加 is_default/is_published/is_active/sort_order
005_platform_settings.sql          # CREATE st_platform.platform_settings（A 类配置型，append-only）
006_platform_presets.sql           # CREATE st_platform.platform_presets（A 类资产型）
007_platform_api_configs.sql       # CREATE st_platform.platform_api_configs（A 类资产型 + 凭证）
008_user_st_settings.sql           # CREATE st_users.user_st_settings（B 类配置型，append-only）
009_user_st_chats.sql              # CREATE st_users.user_st_chats（B 类资产型，占位）

# 里程碑 A（D2）：RLS 和种子
010_rls_policies.sql               # 6 张表 minimal RLS（3 st_platform.* + 2 st_users.* + miniapp.characters）
011_seed_data.sql                  # 3 角色卡 + 1 预设 + 1 API 配置 + 1 settings 全量快照

# 里程碑 B（D6）：任务队列
012_sync_tasks.sql                 # CREATE st_infra.sync_tasks（含独立 RLS）

# MiniApp 支付/钱包/设置
014_miniapp_payment_wallet.sql     # MiniApp 独立支付订单与钱包
015_miniapp_settings_wallet_ops.sql # MiniApp 独立设置与订单过期函数
016_miniapp_wallet_ledger_chat_idempotency.sql # 钱包流水、聊天扣费幂等与失败补偿
017_miniapp_wallet_payment_summary.sql # 钱包首次/最近付费、累计金额和总积分汇总字段
018_miniapp_free_chat_idempotency.sql # 免费聊天模式下保留请求幂等
019_miniapp_billing_checkin.sql # 模型档次扣费配置、预留/确认扣费与每日签到 bonus
020_drop_legacy_app_chat_tables.sql # 删除阶段一遗留 miniapp.app_sessions / app_messages
021_miniapp_wish_roles.sql # MiniApp 角色许愿、24h 限流、许愿奖励
023_move_wishes_to_miniapp.sql # 删除旧 Bot 许愿会话表，许愿池改为 MiniApp 页面
024_cs_platform.sql # 内部 CS Platform：SQL 用户分层、Telegram 1V1 回访 SOP、Excel 导出审计
025_preset_auto_promote.sql # 预设自动晋升触发器 + canonical_jsonb 序列化函数
035_admin_config_management.sql # 运营后台草稿、发布、回滚和审计基础
036_admin_operator_names.sql # 操作人姓名快照
037_model_selector_complete.sql # 用户模型选择持久化、严格目录校验和活动草稿复用
038_seed_payment_plans.sql # 将内置充值套餐迁入 runtime_config，后续由运营平台发布调整
039_admin_character_cards.sql # 放弃配置草稿与运营后台角色卡只读列表
040_migrate_llm_model_catalog.sql # 将旧版 4 模型迁移为正式分档模型目录
041_admin_operations_features.sql # 每模型倍率、充值页配置与角色卡运营写操作
042_admin_config_validation_and_audit_compaction.sql # 充值配置校验分发与角色排序审计压缩
043_admin_analytics.sql # 运营数据分析聚合、明细查询、权限与查询索引
044_admin_platform_presets.sql # 平台统一预设管理、默认快照发布、版本历史与审计
045_admin_character_layout_drafts.sql # 角色卡三状态草稿、原子发布、版本与发布历史
046_admin_character_layout_rollback.sql # 角色布局发布历史查询与原子回滚
047_admin_character_layout_release_details.sql # 角色布局发布类型、目标版本与完整角色快照
```

### 已部署「统一 st schema」的环境（D014 原地搬迁，保留数据）

若 Supabase 上 5~6 张表仍在 `st.*` 下，**不要**直接 `DROP SCHEMA st CASCADE`（会丢种子与用户镜像数据）：

```sql
-- 1. 原地搬迁（ALTER TABLE SET SCHEMA，保留数据与 FK）
013_migrate_st_schema_split.sql

-- 2. 刷新 RLS + schema USAGE（幂等）
010_rls_policies.sql
```

搬迁后表位置：

| 原位置                                                               | 新位置                |
| -------------------------------------------------------------------- | --------------------- |
| `st.platform_settings` / `platform_presets` / `platform_api_configs` | `st_platform.*`       |
| `st.user_st_settings` / `user_st_chats`                              | `st_users.*`          |
| `st.sync_tasks`（若已建）                                            | `st_infra.sync_tasks` |

### 可重置的测试环境（无数据可丢）

```sql
DROP SCHEMA IF EXISTS st CASCADE;
DROP SCHEMA IF EXISTS st_platform CASCADE;
DROP SCHEMA IF EXISTS st_users CASCADE;
DROP SCHEMA IF EXISTS st_infra CASCADE;
-- 再顺序跑 003-012
```

D010 → D011 → D014 的演进差异详见 DECISIONS.md D014。

## 文件命名规范

`<三位序号>_<描述>.sql`，如 `012_xxx.sql`

## 阶段一表清单（三标签视图）

每张表的 `COMMENT ON TABLE` 必带 `[partition=...][shape=...][direction=...]` 三标签，供同步引擎从 `information_schema` 反向校验配置清单。详细解释见 DECISIONS.md 总览章节。

| 表                                                     | partition | shape                  | direction | 说明                                           | 落地 SQL         |
| ------------------------------------------------------ | --------- | ---------------------- | --------- | ---------------------------------------------- | ---------------- |
| `public.users` (扩展 `st_handle`, `st_initialized_at`) | identity  | -                      | none      | 身份映射，Bridge 写入一次                      | 001 / 002        |
| `miniapp.characters` (复用 + 同步字段)                 | A         | resource:platform_pool | down      | 平台默认角色卡池                               | 004 / 011 (seed) |
| `st_platform.platform_settings` (新方案核心)           | A         | config                 | down      | settings.json 全量快照 + writable_paths 白名单 | 005 / 011 (seed) |
| `st_platform.platform_presets`                         | A         | resource:platform_pool | down      | 平台默认 API 预设池                            | 006 / 011 (seed) |
| `st_platform.platform_api_configs`                     | A         | resource:platform_pool | down      | 平台 API 配置（含凭证）                        | 007 / 011 (seed) |
| `st_users.user_st_settings` (新方案核心)               | B         | config                 | up        | 用户白名单内 settings 反向镜像，append-only    | 008              |
| `st_users.user_st_chats`                               | B         | resource:user_pool     | up        | 用户聊天记录镜像（占位）                       | 009              |
| `st_infra.sync_tasks`                                  | infra     | queue                  | internal  | 反向同步任务持久化队列                         | 012              |

**标签字典**：

- `partition`：`A`（平台管控）/ `B`（用户运行时）/ `identity`（身份系统）/ `infra`（引擎基建）
- `shape`：`config`（配置型）/ `resource:platform_pool`（资源型-平台池）/ `resource:user_pool`（资源型-用户池）/ `queue`（任务队列）
- `direction`：`down`（Supabase → ST）/ `up`（ST → Supabase）/ `none`（不参与双向同步）/ `internal`（引擎内部，无 ST 文件系统对应）

## RLS 策略（D009 minimal 模式 + D014 三 schema）

阶段一所有同步相关表统一采用 **service_role 唯一可访问** 的最小模式：

- `anon` / `authenticated` 角色：**完全禁止**
  - schema 级（三个新 schema 全部）：`REVOKE USAGE ON SCHEMA st_platform / st_users / st_infra FROM anon, authenticated`
  - 表级：无任何 policy，所有表的 GRANT 已 REVOKE
- `service_role` 角色：BYPASSRLS + schema USAGE，全权限（同步引擎走此身份）
- `postgres` 角色：BYPASSRLS，全权限（现有 backend 通过 Prisma `DATABASE_URL` 连接，不受影响）

未来阶段二如需开放部分表给 authenticated 直读（如大厅展示），需要：

1. `GRANT USAGE ON SCHEMA st_platform TO authenticated`（按需选择具体 schema）
2. `CREATE POLICY ... FOR SELECT TO authenticated USING (...)`
3. 同步在 DECISIONS.md 补对应决策

## 种子数据（011）

| 类型              | 数量           | 来源                                                                             | 目标表                             | UUID 范围              |
| ----------------- | -------------- | -------------------------------------------------------------------------------- | ---------------------------------- | ---------------------- |
| 角色卡            | 3              | `SillyTavern-latest/data/default-user/characters/{第七开发部,莫池来,贺商寒}.png` | `miniapp.characters`               | `11111111-...001..003` |
| 预设              | 1              | `OpenAI Settings/Default.json`                                                   | `st_platform.platform_presets`     | `22222222-...001`      |
| API 配置          | 1              | 占位（`api_key=REPLACE_ME`，部署时替换）                                         | `st_platform.platform_api_configs` | `33333333-...001`      |
| platform_settings | 1（version=1） | `default-user/settings.json` 经清洗                                              | `st_platform.platform_settings`    | `44444444-...001`      |

**settings_jsonb 清洗（用户确认 Q5）**：

- `active_character` → `platform_<第一张卡 uuid>.png`
- `oai_settings.preset_settings_openai` → `platform_<预设 uuid>`
- `main_api` → `"openai"`

**writable_paths 白名单（J1，阶段一走整组路径）**：

- `{ path: "active_character", transform: "character_ref" }`
- `{ path: "oai_settings.prompts", transform: "passthrough" }`

**重新生成种子数据**：

```bash
cd packages/shared
../backend/node_modules/.bin/tsx scripts/generate-seed-sql.ts
```

生成器代码在 `packages/shared/scripts/generate-seed-sql.ts`，会：

1. 从 ST PNG 提取 chara_card_v3 元数据写入 `miniapp.characters`
2. 从 `OpenAI Settings/Default.json` 写入 `st_platform.platform_presets`
3. 写入 `st_platform.platform_api_configs` 占位（api_key=REPLACE_ME）
4. 从 `settings.json` 全量导出 + 三处指针清洗 + canonical content_hash → `st_platform.platform_settings`

## 部署注意事项

### API Key 替换

种子数据写入 `st_platform.platform_api_configs` 时 `api_key = "REPLACE_ME"`，部署时必须替换：

```sql
UPDATE st_platform.platform_api_configs
SET config_payload = jsonb_set(config_payload, '{api_key}', '"sk-or-v1-XXXXX"')
WHERE id = '33333333-3333-4333-8333-000000000001';
```

或通过运维后台替换。**注意**：011 的 ON CONFLICT 子句故意不更新 `config_payload`，保护已部署的真实 key 不被种子重置。

### platform_settings 后续版本

阶段一种子只写 `platform_version = 1`。

**预设更新场景**（最常见）：运营无需手动操作 `platform_settings`，只需在 `platform_presets` 中 INSERT 一行 `is_default=true` 的新预设，触发器 `trg_preset_auto_promote`（025）会自动追加新版 `platform_settings`（详见下方「运营更新预设」章节）。

**其他 settings 变更**（如开放新的 writable_paths、修改 main_api 等）：仍需手动 INSERT：

```sql
-- platform_version 单调递增；content_hash 不能与历史重复
INSERT INTO st_platform.platform_settings (
  platform_version, settings_jsonb, writable_paths, content_hash, created_by, note
) VALUES (
  2, '{...}'::jsonb, '[...]'::jsonb, 'sha256-hash', 'admin@xxx', 'v2: 开放 power_user.theme'
);
```

应用层负责计算 canonical content_hash（key 排序后 sha256），同 hash 会被 UNIQUE 约束拒绝。

### 运营更新预设

> **前置条件**：migration `025_preset_auto_promote.sql` 已执行。

运营只需执行**一条 SQL**，触发器自动完成所有关联操作：

```sql
-- ═══════════════════════════════════════════════════════════════════════
-- 运营更新预设：一条 INSERT 即可
-- ═══════════════════════════════════════════════════════════════════════
--
-- 作用：向 platform_presets 插入一行新的默认预设。
--       触发器 trg_preset_auto_promote 会自动完成以下操作：
--         ① 将旧默认预设的 is_default 置为 false、enabled 置为 false
--         ② 复制最新 platform_settings，将 preset 指针更新为新预设
--         ③ platform_version 自动 +1
--         ④ content_hash 自动计算
--         ⑤ 插入新的 platform_settings 行
--
-- 下发时机：
--   - 新用户：下次登录时 provision 自动下发新预设文件 + 新 settings 指针
--   - 老用户：settings.json 每次登录都会刷新（指针生效），新预设文件因
--             UUID 不同（文件不存在）也会被写入，无需 force

INSERT INTO st_platform.platform_presets (display_name, preset_payload, is_default)
VALUES (
  '预设名称',                  -- 运营展示名（不影响落盘文件名）
  '{
    "完整的 ST OpenAI 预设 JSON，
     从 SillyTavern 的 OpenAI Settings/*.json 中导出"
  }'::jsonb,
  true                         -- 标记为默认 → 触发自动晋升
);
```

**执行后的验证查询**：

```sql
-- ① 检查当前默认预设（应只有一行 is_default=true）
SELECT id, display_name, is_default, enabled, created_at
  FROM st_platform.platform_presets
 ORDER BY created_at DESC
 LIMIT 5;

-- ② 检查 platform_settings 最新版本（指针应指向新预设）
SELECT platform_version,
       settings_jsonb->'oai_settings'->>'preset_settings_openai' AS preset_pointer,
       created_by, note, created_at
  FROM st_platform.platform_settings
 ORDER BY platform_version DESC
 LIMIT 3;
```

**触发器内部流程（运营无需关心，仅供排障参考）**：

```
INSERT is_default=true
  │
  ├─ ① UPDATE platform_presets SET is_default=false, enabled=false WHERE is_default=true
  │     → 旧默认预设降级并禁用（新用户不再收到旧预设文件）
  │
  ├─ ② SELECT latest platform_settings (max platform_version)
  │     → 取最新一行 settings 快照作为基底
  │
  ├─ ③ jsonb_set(settings_jsonb, 'oai_settings.preset_settings_openai', 'platform_<新UUID>')
  │     → 更新 settings 中的预设指针
  │
  ├─ ④ platform_version + 1, canonical_jsonb → sha256 → content_hash
  │     → 版本递增 + 计算跨语言一致的 hash（使用 canonical_jsonb 函数）
  │
  └─ ⑤ INSERT INTO platform_settings (new version row)
        → 追加新版 settings 行（append-only，不修改历史）
```

**注意事项**：

- `is_default` 必须设为 `true`，否则触发器不会执行，预设只会作为普通行写入
- `preset_payload` 必须是完整可用的 ST 预设 JSON，provision 会原样写入用户的 `OpenAI Settings/` 目录
- 旧预设文件不会从已有用户的磁盘上删除（provision 无清理逻辑），但指针已切换，ST 不会再使用旧文件
- 如需回滚到旧预设，不能直接 UPDATE（append-only），需 INSERT 一行新预设指向旧 payload

## 回滚

阶段一不提供自动回滚脚本。如需回滚：

```sql
-- 删除三个新 schema（CASCADE 级联删除其下所有表）
DROP SCHEMA IF EXISTS st_infra CASCADE;
DROP SCHEMA IF EXISTS st_users CASCADE;
DROP SCHEMA IF EXISTS st_platform CASCADE;

-- 回滚 miniapp.characters 同步字段
ALTER TABLE miniapp.characters DROP COLUMN IF EXISTS is_default;
ALTER TABLE miniapp.characters DROP COLUMN IF EXISTS is_published;
ALTER TABLE miniapp.characters DROP COLUMN IF EXISTS is_active;
ALTER TABLE miniapp.characters DROP COLUMN IF EXISTS sort_order;

-- 回滚 001/002（如果连身份字段也要回滚）
ALTER TABLE public.users DROP COLUMN IF EXISTS st_initialized_at;
ALTER TABLE public.users DROP COLUMN IF EXISTS st_handle;
```

## Prisma 同步

执行完迁移后，如需更新 Prisma Client：

```bash
cd packages/backend
# 先在 schema.prisma 的 datasource 块里加入 schemas = ["public", "miniapp", "st_platform", "st_users", "st_infra"]
npx prisma db pull
npx prisma generate
```

`prisma db pull` 会内省三个新 schema 下的表，并自动加 `@@schema("st_platform")` / `@@schema("st_users")` / `@@schema("st_infra")` 标记，不会破坏现有 `miniapp.*` model。
