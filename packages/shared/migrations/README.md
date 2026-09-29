# SQL 迁移文件

本目录是仓库里**唯一**的 schema 变更源。现行规则以 [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md) 铁律 9 与 §7.4 为准，不要再引用已删除的 `DECISIONS.md` / `Schema划分设计.md`。

当前事实：

- 物理布局是 099 之后的八域（`app_core` / `experience` / `billing` / `miniapp_features` / `cs_platform` / `admin` / `miniapp_traffic` / `miniapp_analytics`）。`st_*` / `growth` / `miniapp_simulation` 已删。
- 新表必须在文件头声明 `-- domain: xxx`。跨域直连豁免见 ARCHITECTURE 铁律 8，不要另写一份地图。
- 新文件命名 `YYYYMMDD_<小写下划线描述>.sql`。三位数字编号已冻结，CI `pnpm lint:migrations` 拦截新编号。

## 现行执行通道

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
- **账本** `supabase_migrations.repo_migrations`（建表：`20260910_schema_migrations_ledger.sql`）：workflow `apply` 执行前查重，已有记录且 checksum 一致则拒绝（`force_rerun` 可再跑 SQL，但不改首次 `applied_at` / checksum）；checksum 不一致拒绝，即使勾了 `force_rerun`。成功后写入 `filename / checksum / applied_by`。`20260914_repo_migration_ledger_events.sql` 补 `repo_migration_claims`（执行中认领）和 `repo_migration_events`（含 force_rerun 历史）。放在平台 schema，不进 `app_core`。不要用同 schema 下 CLI 的 `schema_migrations`（列是 `version`，没有 `filename`）。账本表不存在时，除账本迁移本身外会失败，不再静默放行。
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

本地 SQL 回归应使用非 superuser 的 `postgres` 执行迁移（具备本地建库/建角色权限），另设隔离实例的 superuser `TEXT_POSTPROCESS_TEST_ADMIN` 执行恶意写入/replica 场景。例如在明确的本地 Unix socket 上运行 `PGHOST=/path/to/local/socket PGUSER=postgres TEXT_POSTPROCESS_TEST_ADMIN=local_test_admin bash packages/shared/migrations/tests/run-text-postprocess-t2.sh`。不要降权或修改共享开发实例已有角色；使用临时隔离实例。runner 覆盖缺失行锁权限、额外授权收敛、迁移重跑、非空/NULL 开轮、重生成、不可变快照、CAS、事务回滚和并发锁。

artifact 修订（2026-09-29，仍未执行远端）：首个文件在版本表新增 `artifact jsonb`，Backend 可终止 Worker 在事务前编译；publish/rollback 显式传 `p_source`、`p_artifact`，快照与当前指针/release/audit/draft 原子绑定。runtime config 不放 artifact。旧本地表通过 `ADD COLUMN IF NOT EXISTS` 与 `NOT VALID` CHECK 保留 NULL 历史；新行必须非 NULL，旧行在 MiniApp unavailable，不读时编译、不回填、不替代版本。历史 UPDATE/DELETE/TRUNCATE 无角色例外，trigger 为 `ENABLE ALWAYS`；恶意最高权限 DDL 仍不属于应用权限防护能力。

专用签名：`admin.publish_text_postprocess(uuid,uuid,text,integer,timestamptz,text,text,jsonb,jsonb)`、`admin.rollback_text_postprocess(uuid,uuid,text,integer,integer,jsonb,jsonb)`；最后两参数是 source/artifact。旧重载删除。SQL 对完整 payload 计算 SHA-256 request identity，source/artifact 不同必须冲突；Backend 重放读 outcome 的明确版本，不重新编译。未知结果仍查询原 request_id。

本地 runner 只接受 Unix socket；覆盖 fresh/replay/CAS/原子性、postgres/service_role/SECURITY DEFINER/replica session、旧无 artifact 表/旧重载、重跑、补丁漂移停止及恢复。TEST 仍须逐文件 preflight/apply/postflight 和业务读写验证；本修订不能证明远端 shape。

不播种规则，不回填旧消息，不改历史 migration。已有引用时不要 DROP 快照或该列。本地协议场景是 `fixtures/text_postprocess_t2_harness.sql` 加 `tests/text_postprocess_t2_scenarios.sql`，只对临时库执行，不能当作远端发布。

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
