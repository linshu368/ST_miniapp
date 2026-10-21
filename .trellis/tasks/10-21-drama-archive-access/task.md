# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                           | Files / Scope                                                              | Depends On | Verification                                                                                                                    |
| --- | ------ | ------------------------------ | -------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Done   | 写 GRANT migration 文件        | `packages/shared/migrations/20261021_drama_archive_grant_service_role.sql` | -          | 文件内容已按 2026-10-21 范围变更简化为单条 `GRANT USAGE ON SCHEMA drama_archive TO service_role;`，命名符合 `YYYYMMDD_描述.sql` |
| T2  | Done   | test 库前置权限核查            | 只读 SQL 查询（不落库，用户在 Supabase SQL Editor 跑）                     | T1         | 已取得 RLS/role_table_grants/schema USAGE/rolbypassrls/pg_policies 五组实测结果，详见下方 Execution Log                         |
| T3  | Todo   | 执行 migration（test）         | `.github/workflows/db-migrate.yml`                                         | T2         | 工作流执行成功，project-ref 指向 test；需先把完整 SQL 和调用参数发用户确认                                                      |
| T4  | Todo   | 执行后权限验证                 | 同 T2 查询                                                                 | T3         | service_role 的 schema USAGE 由 false 变 true；anon/authenticated 仍为 false；drama_worker 函数 EXECUTE 权限不变                |
| T5  | Todo   | 写 PostgREST 暴露脚本          | `ops/schema-split/postgrest-expose-test-drama-archive.sql`                 | -          | 三步模式（记录/追加/验证），只追加不重排                                                                                        |
| T6  | Todo   | test 库执行 PostgREST 暴露变更 | 同上，手工 psql                                                            | T5         | `curl -H "Accept-Profile: drama_archive"` 返回 200                                                                              |
| T7  | Todo   | DOMAIN_SCHEMAS 代码改动        | `packages/backend/src/lib/supabase.ts`                                     | T4, T6     | `pnpm --filter @miniapp/backend typecheck` 通过                                                                                 |
| T8  | Todo   | 端到端只读验证                 | 一次性验证脚本（验证后删除）                                               | T7         | `getDomainDb('drama_archive')` 查到至少一条真实 `videos` 行                                                                     |
| T9  | Todo   | 私有桶签名验证                 | 一次性验证脚本（验证后删除）                                               | T4         | `createSignedUrl` 对已知 `object_path` 成功返回链接                                                                             |
| T10 | Todo   | 记录结果、同步 Open Issue      | task.md 执行日志、父任务 prd.md                                            | T8, T9     | 执行日志含实测数据，非空泛结论                                                                                                  |

## Execution Log

- **T1（Done，2026-10-21，2026-10-21 按范围变更改写过一次）**：新建 `packages/shared/migrations/20261021_drama_archive_grant_service_role.sql`。初版内容是 `GRANT USAGE ON SCHEMA drama_archive TO service_role;` + 对三表的 `GRANT SELECT`（不含 `pipeline_tasks`），带与仓库既有 GRANT 类 migration（如 `20260929_grant_text_postprocess_snapshot_read.sql`）同风格的 preflight/postflight `DO` 块。T2 核查发现前置假设不成立后，已按下方「范围决定」改写为单条 `GRANT USAGE ON SCHEMA drama_archive TO service_role;`（删除冗余的 `GRANT SELECT`，因为表级权限已存在），header 注释和 preflight/postflight 同步更新为只断言/只授予 schema USAGE。本地跑 `node scripts/check-migration-filenames.mjs` 输出 `迁移文件命名检查通过。`，命名合规（两次改写后都重新跑过）。
- **T2（Blocked，2026-10-21）**：尝试执行 test 库只读权限核查时发现当前会话没有任何可用的数据库读取通道——本机 shell 环境变量和 `.env.compose`/`.env.schema-split` 里都没有可用的 test 库连接串（`.env.compose` 的 `DATABASE_URL`/`SUPABASE_URL` 是占位符 `placeholder.supabase.co`），本会话也没有配置 Supabase MCP 工具。`.github/workflows/db-migrate.yml` 的 `mode=inspect` 跑的是固定脚本 `scripts/inspect-repo-migrations.sh`（账本 checksum 三方互证 + 几个历史探针：`r3_grant_bonus_credits`/`st_handle_nullable`/`a_snapshot`/`a_settled_at`），不支持任意只读查询，也没有探 `drama_archive` 权限的探针。改为由用户直接在 Supabase test 项目 SQL Editor 跑只读查询、把结果贴回。
  - 实测①（`pg_tables.rowsecurity`）：`drama_archive.{ai_results,dramas,pipeline_tasks,videos}` 四张表 `rowsecurity = true`，符合 prd.md 假设。
  - 实测②（`information_schema.role_table_grants`，2026-10-21 用户在做任何本任务操作前跑的基线）：`anon`/`authenticated`/`postgres`/`service_role` 对**全部四张表（含 `pipeline_tasks`）**都有 `SELECT/INSERT/UPDATE/DELETE` 的表级授权记录——这和 prd.md 引用的 upstream `REVOKE ALL ON ALL TABLES IN SCHEMA drama_archive FROM anon/authenticated/service_role` 字面结论不一致（这条表级 REVOKE 看起来没有对这三个角色完全生效，或执行后被别的机制重新授予；具体原因未查，按"文档与实测不一致，以实测为准"处理，不回填推测）。
  - 实测③（`has_schema_privilege(rolname, 'drama_archive', 'USAGE')`，首次漏跑、已重新执行确认）：`anon=false`、`authenticated=false`、`service_role=false`、`drama_worker=true`。只有 `drama_worker` 有 schema 级 `USAGE`。
  - **结论（②+③ 合并解读）**：当前 `service_role`/`anon`/`authenticated` 虽然在表级 ACL 里挂着（含 `pipeline_tasks` 的）`SELECT/INSERT/UPDATE/DELETE`，但三者都没有 schema `USAGE`——Postgres 访问 schema 里任何对象都要求先有 schema `USAGE`，缺了它表级授权形同虚设，所以 prd.md「service_role 现在读不了 drama_archive 任何一行」这个结论目前仍然成立，只是成立的机制和文档描述的不一样（文档说是表级也被 REVOKE 干净，实测是表级授权还在、但 schema USAGE 这道闸门挡住了）。
  - **新暴露的风险，尚未解决，阻塞 T3**：本任务计划的 migration 只 `GRANT USAGE ON SCHEMA drama_archive TO service_role`，一旦执行，`service_role` 会拿到 schema `USAGE`。叠加②里它已经挂着的 `pipeline_tasks` 的 `SELECT/INSERT/UPDATE/DELETE` 和 `dramas/videos/ai_results` 的 `INSERT/UPDATE/DELETE`（都是现在就已经存在、不是本 migration 新授予的），如果 `service_role` 在 Postgres 层面真的有 `BYPASSRLS`（Supabase 官方文档说 service_role 绕过 RLS，但本任务还没有用 `pg_roles.rolbypassrls` 实测核实过），那执行本 migration 后 `service_role` 很可能不只是能读 3 张表，而是能读写全部 4 张表，包括 `pipeline_tasks`——直接违反 prd.md 验收标准「不授权 pipeline_tasks」「只读」。而修复它需要在 migration 里加 `REVOKE`，这超出了 prd.md 硬约束写死的「migration 内容只能是两条 GRANT」的范围，需要用户决定要不要扩大这次 migration 的范围，不能自行加 REVOKE。
  - 实测⑦（`pg_roles.rolbypassrls`）：`service_role=true`、`postgres=true`；`anon=false`、`authenticated=false`、`drama_worker=false`。确认 `service_role` 确实绕过 RLS。
  - 实测⑥（`pg_policies`，补跑）：`Success. No rows returned`——`drama_archive` 四张表确实零 policy，与 prd.md 描述一致。
  - 实测⑧（`pg_db_role_setting`，`authenticator` 角色）：`pgrst.db_schemas=public, graphql_public, miniapp, miniapp_traffic, admin, cs_platform, app_core, miniapp_features, experience, billing`（10 项，顺序未变，**不含 `drama_archive`**）。用户确认在跑②之前就已经在 Supabase Studio 把 `drama_archive` 勾选并保存进 "Exposed schemas"，但这条 GUC 查询暂时看不到——说明 Studio 这个开关生效的通道，不是（或不只是）直接写 `authenticator` 角色的 `pgrst.db_schemas`。用户已明确表示不需要现在查清楚具体是哪条通道，接受这个不确定性，留到 T6 用 `curl -H "Accept-Profile: drama_archive"` 实测是否返回 200 作为唯一判据；顺序目前没被打乱，没有立即风险。
  - **范围决定（用户 2026-10-21 拍板，已同步进 prd.md「范围变更记录」/ design.md §1、§2.1）**：原「只读三表、排除 pipeline_tasks」不再是硬约束——`service_role` 已经在表级 ACL 上拥有全部四张表的读写权限（历史遗留）且绕过 RLS，所以给它 schema `USAGE` 会连带激活这些权限；用户确认接受，因为backend 以后确实需要读写这些表。因此 migration 简化为单条 `GRANT USAGE ON SCHEMA drama_archive TO service_role;`，不需要额外 `GRANT SELECT`、也不需要 `REVOKE`。`anon`/`authenticated`/`drama_worker` 的边界不受影响。T1 的 migration 文件已按此改写（见上）。
