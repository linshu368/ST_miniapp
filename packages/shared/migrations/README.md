# SQL 迁移文件

本目录是仓库里**唯一**的 schema 变更源。现行规则以 [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md) 铁律 9 与 §7.4 为准，不要再引用已删除的 `DECISIONS.md` / `Schema划分设计.md`。

当前事实：

- 物理布局是 099 之后的八域（`app_core` / `experience` / `billing` / `miniapp_features` / `cs_platform` / `admin` / `miniapp_traffic` / `miniapp_analytics`）。`st_*` / `growth` / `miniapp_simulation` 已删。
- 新表必须在文件头声明 `-- domain: xxx`。跨域直连豁免见 ARCHITECTURE 铁律 8，不要另写一份地图。
- 新文件命名 `YYYYMMDD_<小写下划线描述>.sql`。三位数字编号已冻结，CI `pnpm lint:migrations` 拦截新编号。

## 现行执行通道

### 图片广场固定初始序位（2026-10-19，未执行）

文件：`20261019_image_plaza_initial_feed_order.sql`。前置：V2、seed_catalog、feed_like_order 三份 migration 的目标环境 shape 已核实。

- `experience.image_plaza_works` 加 nullable bigint、正数 CHECK 和 UNIQUE；一次编号所有未删除作品（包括有赞），模型内按源热度/时间/id，跨模型逐轮交错。不修改点赞、所有权、RLS/ACL 或生成/分享/导入流程；以后新增默认 NULL。
- 单事务持有 ACCESS EXCLUSIVE 锁，5 秒锁等待、60 秒每语句预算、100000 active 作品上限；阻塞期间分享/点赞/导入可能等待，必须维护窗口与容量验证。超预算停止，不自动重试/扩大阈值。重复执行明确拒绝，不重新编号。
- 保留既有点赞索引，新增零赞 partial 与最新索引。**候选索引还未得到真实 EXPLAIN/写成本验证**，本地无 PostgreSQL/Docker，不得将 unit mock 视为 SQL 验收。
- TEST preflight：核对列、约束、源热度类型、RLS/grants、现有索引、活跃作品规模与空间；确认没有已有 initial_feed_order。先隔离环境验证初始化原子回滚/重跑拒绝/并发，再 workflow 单文件 apply。
- postflight：比较前后权限；验证非空序位正数/唯一/覆盖，获赞与取消到零赞不重编号，新作品 NULL；实际 PostgREST `initial_feed_order::text` 与 NULL 混合方向游标、跨段 limit+1/字面搜索回归；1x/10x 合成规模首页/深页/搜索 EXPLAIN、点赞索引写成本与锁等待。仅保存结构/汇总，不提交业务行。
- 发布：TEST migration → Backend → Frontend → 真机/性能 → 独立 Production 审批；各环境独立初始化，不能复制 TEST 序位。当前没有执行任何远端迁移。
- 恢复：先回退 Frontend/Backend 到旧协议，保留新增列/索引（旧版本兼容）；初始迁移失败整笔回滚，结果未知先核对列/账本，禁止 force_rerun 重新编号。确认无消费者后才另审 DROP 索引/约束/列；错误初始化用独立 forward-fix 和新游标版本，不能删作品/点赞恢复。

**改库只有 GitHub Actions `Database Migration` 一条路。** 它才会查、写 `supabase_migrations.repo_migrations` 账本。

仓库 Secrets：

| Secret              | 用途                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| `TEST_DATABASE_URL` | test 库 **Session pooler** 连接串（端口 5432），必须包含 `zoqelpfhurwehlvypryl`    |
| `PROD_DATABASE_URL` | production **Session pooler** 连接串（端口 5432），必须包含 `wbtsfzozlmurljvglhpn` |

> Action 用 `psql -f` 执行整份 SQL（`supabase db query` 不能跑多语句文件）。直连 `db.*.supabase.co` 是 IPv6-only，GitHub-hosted runner 连不上。`SUPABASE_ACCESS_TOKEN` 只给本地 CLI 用，这个 workflow 不读。

步骤：GitHub → Actions → `Database Migration` → 选 `mode` 与 `environment`。

- **inspect**：只读。把日期命名迁移的 sha256 和 `repo_migrations` 对账，并探 R3 发奖入口、111 `st_handle` 是否可空、A 的结算两列。生产同样要填 `confirm_production`。
- **apply**：填 `migration_file`（如 `packages/shared/migrations/20260910_schema_migrations_ledger.sql`）。生产必须在 `confirm_production` 填 `RUN_PRODUCTION_MIGRATION`。查账本、执行、记账在同一次调用里；已执行且 checksum 一致会报 `MIGRATION_ALREADY_APPLIED`；文件被改过报 `MIGRATION_CHECKSUM_DRIFT`（写新迁移，不要改旧文件再跑）。`force_rerun` 只在文件未改时重跑 SQL，不覆盖首次记账。生产会拒绝 `104_rollback_voice_billing.sql`。
- **abandon_claim**：仅用于“SQL 已回滚/失败、没有账本成功行、原文件在失败认领后被修订”的恢复。先执行 `20261013_repo_migration_claim_recovery.sql`，再选择原 `migration_file` 并填写 `claim_abandon_reason`；脚本会在一个事务中锁定认领、复核无账本且 checksum 漂移、记录旧/新 checksum 与原因，然后删除认领，**不会执行目标 migration SQL**。之后才能以修订文件正常 `apply`。不得把它用于已记账文件、同 checksum 的可续跑认领，或代替生产问题排查。

应用启动**不会**自动跑 SQL；`packages/backend` 的 `start` 只做 `prisma generate`。workflow 校验 project ref：test 只能连 `zoqelpfhurwehlvypryl`，production 只能连 `wbtsfzozlmurljvglhpn`。

不要用的方式（不记账，不能当现行通道）：

- Supabase Studio SQL Editor、Management API 直改表结构
- 按历史三位数字前缀在 Studio 里手跑
- 本地 `pnpm supabase:db:query --file …` 对着远程库执行（仅排障时用，事后必须补账本）

### 本地 CLI（查询 / 调试）

SQL 源只在本目录；不要复制到 `supabase/migrations` 变成第二套来源。

```bash
pnpm supabase --version
pnpm supabase:status
pnpm supabase:start
pnpm supabase:stop
pnpm supabase login
pnpm supabase:link:test
pnpm supabase:link:prod
```

查库（不是发布）：

```bash
pnpm supabase:db:query -- --db-url "$DATABASE_URL" --file packages/shared/migrations/20260910_schema_migrations_ledger.sql
```

## 命名与账本

- **2026-09-10 起**：`YYYYMMDD_描述.sql`。存量三位编号文件锁死，新增编号会被 CI 拒绝（`scripts/check-migration-filenames.mjs`）。
- **账本** `supabase_migrations.repo_migrations`（建表：`20260910_schema_migrations_ledger.sql`）：workflow `apply` 执行前查重，已有记录且 checksum 一致则拒绝（`force_rerun` 可再跑 SQL，但不改首次 `applied_at` / checksum）；checksum 不一致拒绝，即使勾了 `force_rerun`。成功后写入 `filename / checksum / applied_by`。`20260914_repo_migration_ledger_events.sql` 补 `repo_migration_claims`（执行中认领）和 `repo_migration_events`（含 force_rerun 历史）；`20261013_repo_migration_claim_recovery.sql` 增加不可绕过的失败认领废弃审计。放在平台 schema，不进 `app_core`。不要用同 schema 下 CLI 的 `schema_migrations`（列是 `version`，没有 `filename`）。账本表不存在时，除账本迁移本身外会失败，不再静默放行。
- 账本只覆盖 2026-09-10 之后的新迁移，不回填更早历史。
- 查环境：Actions `mode=inspect`，或 `SELECT * FROM supabase_migrations.repo_migrations ORDER BY applied_at DESC`。
- 已执行文件被改过：用**新迁移**表达修正，不要改旧文件再跑。
- 本地协议回归（本机 Postgres，不连远程）：`pnpm test:migration-ledger`。

顺序依赖写在各文件头部「前置」，不要按文件名序号推断。并行分支撞号的存量（021/030/031/032/053/065/086/088/092/093/095 与 105/108/109）**同号含义可以不同**。099 已在 test 与生产执行完毕；其执行剧本是历史文档，见下方。

### 文本后处理版本（按环境账本核对后逐文件执行）

按顺序、一次一个文件：

1. `20260928_text_postprocess_versions.sql`：`app_core.text_postprocess_versions` 与 `miniapp_text_postprocess_config` 的专用草稿/发布/回滚/放弃事务。
2. `20260928_chat_history_postprocess_version.sql`：`experience.chat_history.postprocess_version`、当前消息视图和开轮 wrapper。必须在第 1 个文件成功之后执行。
3. `20260929_fix_text_postprocess_writer_guard.sql`：将专用 writer guard 改为事务本地设置，修复 PostgREST service role 跨 SECURITY DEFINER 边界时的误拒绝。必须在第 1 个文件成功之后执行。
4. `20260929_grant_text_postprocess_snapshot_insert.sql`：恢复专用发布 RPC owner `postgres` 对版本快照表的最小 `INSERT` 权限；`service_role` 保持只读，直接写仍由既有 trigger 拒绝。必须在第 1 个文件成功之后执行。
5. `20260929_grant_text_postprocess_snapshot_read.sql`：恢复对话开轮 wrapper owner `postgres` 和 Backend `service_role` 对版本快照的最小 `SELECT` 权限；要求两个 wrapper 仍为 `postgres` 所有的 `SECURITY DEFINER` 函数，拒绝未知 owner。必须在第 1、2 个文件成功之后执行。
6. `20260929_fix_text_postprocess_snapshot_fk_lock.sql`：补 owner `postgres` 的 `UPDATE(version)`，满足版本外键的 `SELECT FOR KEY SHARE` 权限检查；撤销 API 角色额外的表/列写权限，恢复 `service_role` 只读。保留 RLS、FK 和 ALWAYS 不可变触发器，无回填。要求第 1、2 个文件和既有授权修复完成；失败事务回滚，提交后采用 forward-fix，不恢复宽泛授权。
7. `20260930_fix_system_instructions_text_value_validation.sql`：恢复 Admin 平台规则模板使用 `text_value`、`value=NULL` 的既有契约，修复后续 validator 包装链把它误送入 JSON-only 守卫的问题。只替换最外层校验函数，不改配置数据、草稿、正式版本、RLS/grant 或富文本快照；迁移内验证合法文本、错误存储列、空值、缺失占位符及既有 VIP 分支。TEST 单文件执行和 Admin 保存/发布回读通过后才能继续 MiniApp 验收；Production 独立审批。
8. `20260930_bind_current_text_postprocess_on_turn_start.sql`：新增发送/重生成 current-postprocess RPC，在既有开轮事务内读取 `runtime_config` 权威指针、校验不可变 artifact 快照并绑定非空版本。保留旧显式 wrapper 的 `NULL=不绑定` 语义；新 Backend 必须在本文件之后发布，RPC 缺失或当前配置非法时不得降级开轮。无 backfill/表重写；TEST 冷启动首发通过后才规划 Production。
9. `20261013_accept_rich_reply_protocol_artifact.sql`：使发布/回滚的 artifact 守卫接受编译器写入的 `rich_reply_protocol` 描述符（版本 1 或 2，含 `enabled`）。不改草稿、正式指针或历史快照；先 TEST 单文件执行并完成一轮规则发布/真实生成验证，再单独审批 Production。

本地 SQL 回归应使用非 superuser 的 `postgres` 执行迁移（具备本地建库/建角色权限），另设隔离实例的 superuser `TEXT_POSTPROCESS_TEST_ADMIN` 执行恶意写入/replica 场景。例如在明确的本地 Unix socket 上运行 `PGHOST=/path/to/local/socket PGUSER=postgres TEXT_POSTPROCESS_TEST_ADMIN=local_test_admin bash packages/shared/migrations/tests/run-text-postprocess-t2.sh`。不要降权或修改共享开发实例已有角色；使用临时隔离实例。runner 覆盖缺失行锁权限、额外授权收敛、迁移重跑、非空/NULL 开轮、重生成、不可变快照、CAS、事务回滚和并发锁。

artifact 修订（2026-09-29，仍未执行远端）：首个文件在版本表新增 `artifact jsonb`，Backend 可终止 Worker 在事务前编译；publish/rollback 显式传 `p_source`、`p_artifact`，快照与当前指针/release/audit/draft 原子绑定。runtime config 不放 artifact。旧本地表通过 `ADD COLUMN IF NOT EXISTS` 与 `NOT VALID` CHECK 保留 NULL 历史；新行必须非 NULL，旧行在 MiniApp unavailable，不读时编译、不回填、不替代版本。历史 UPDATE/DELETE/TRUNCATE 无角色例外，trigger 为 `ENABLE ALWAYS`；恶意最高权限 DDL 仍不属于应用权限防护能力。

专用签名：`admin.publish_text_postprocess(uuid,uuid,text,integer,timestamptz,text,text,jsonb,jsonb)`、`admin.rollback_text_postprocess(uuid,uuid,text,integer,integer,jsonb,jsonb)`；最后两参数是 source/artifact。旧重载删除。SQL 对完整 payload 计算 SHA-256 request identity，source/artifact 不同必须冲突；Backend 重放读 outcome 的明确版本，不重新编译。未知结果仍查询原 request_id。

本地 runner 只接受 Unix socket；覆盖 fresh/replay/CAS/原子性、postgres/service_role/SECURITY DEFINER/replica session、旧无 artifact 表/旧重载、重跑、补丁漂移停止及恢复。TEST 仍须逐文件 preflight/apply/postflight 和业务读写验证；本修订不能证明远端 shape。

不播种规则，不回填旧消息，不改历史 migration。已有引用时不要 DROP 快照或该列。本地协议场景是 `fixtures/text_postprocess_t2_harness.sql` 加 `tests/text_postprocess_t2_scenarios.sql`，只对临时库执行，不能当作远端发布。

## 图片广场白名单恢复（2026-10-16，未部署）

`20261016_reconcile_image_plaza_managed_config_keys.sql` 修复平台规则静态白名单覆盖图片广场四个 key 的回归，同时保留现有合法 key、CHECK 表达式、验证状态与 validator 链。前置为 `20261012_image_plaza_v2.sql`；若计划部署 10/13 平台规则、10/14 标签开关迁移，先完成这些文件，再执行本恢复文件，勿倒序覆盖。

1. 在已确认 TEST 中只读核对三个相关 migration 的账本、函数定义/owner/ACL、两表 CHECK/验证状态与表大小；未知 shape 停止。当前 MCP 无 TEST 访问权限，仓库声明不代表实况。
2. 经 `Database Migration` workflow 选择 TEST，单文件 apply 本迁移，不用 SQL Editor 改库。一次性执行，禁止 `force_rerun`；已存在恢复前置函数会拒绝。
3. 内置自检检查四个 key、两表真实 CHECK、未知 key 拒绝、其他 key 行为不变、合法配置通过与非法配置拒绝。锁等待 5 秒/语句 60 秒，失败整笔回滚；不自动重试。锁超时先检查写流量/表容量。
4. 只读复核以下 SQL；在 Admin 保存模型/标签/分享提示草稿并回读，确认保存不更改正式配置；分别验证发布、历史恢复、平台规则/标签功能开关与 viewer 拒写。生产独立审批。

```sql
SELECT key, admin.is_managed_config_key(key) AS allowed
FROM unnest(ARRAY[
  'image_plaza_enabled', 'image_plaza_model_catalog', 'image_plaza_share_tip',
  'image_plaza_tags', 'image_plaza_tags_feature_enabled',
  'system_instructions', 'choice_rules', 'status_rules', 'memory_rules',
  'llm_model_catalog', '__unknown_config_key__'
]) AS keys(key);
-- 前置迁移齐全时合法 key 为 true，未知 key 必须 false。
SELECT conrelid::regclass, conname, convalidated, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN ('admin.config_drafts'::regclass, 'admin.config_releases'::regclass)
  AND conname IN ('config_drafts_config_key_check', 'config_releases_config_key_check');
SELECT oid::regprocedure, pg_get_userbyid(proowner) AS owner, proacl,
       pg_get_functiondef(oid)
FROM pg_proc
WHERE pronamespace = 'admin'::regnamespace
  AND proname LIKE 'is_managed_config_key%';
```

无业务行写入/回填，RLS/表 grants 不变。重建已验证 CHECK 可能扫描历史行并持有 ACCESS EXCLUSIVE，低峰执行。提交后采用新 forward-fix 保留兼容范围，勿删历史记录或恢复旧窄白名单；应用回退无需回退此兼容迁移。

## Prisma

```bash
cd packages/backend
npx prisma generate
```

099 之后 `schema.prisma` 的 `schemas` 是 `["app_core", "miniapp_features", "billing"]`。`experience` / `cs_platform` 等无 Prisma model 的域走 `getDomainDb` 或全限定 SQL。

## 历史（不是现行规则）

下列文件已从工作区删除，需要时从 git 取回，并标明那是当时的决策而不是现在的权威：

| 内容                                     | 取回                                                  |
| ---------------------------------------- | ----------------------------------------------------- |
| 八域归属原稿                             | `git show 7541a54^:docs/schema归属地图.md`            |
| 099 执行剧本                             | `git show b4491cd^:docs/schema划分-一阶段执行计划.md` |
| ST 三 schema / DECISIONS 时代的本 README | 本文件改版前的 git 历史                               |

`st_platform` / `st_users` / `st_infra`（088）、`growth`（089）、`miniapp_simulation`（090）已删库。不要按「D014 三 schema」或「Studio + 数字前缀」执行新变更。

### 20261026_first_token_stage_budgets.sql

在20261023首token配置迁移之后，添加nullable兜底阶段时限、客户端实际等待、服务端超时阶段；扩展配置校验、原begin/report函数和invoker分析投影，不回填历史策略，不新增授权。TEST通过后单文件生产执行，再发布Backend/Admin、运营4/2/10配置、Frontend及v2看板。保留列/历史回滚应用，禁止改写旧迁移或releases。验证用`scripts/test-first-token-fallback-local.sh`（隔离本地PG17/PostgREST、reader ACL、身份/账务与v2失败率）。
