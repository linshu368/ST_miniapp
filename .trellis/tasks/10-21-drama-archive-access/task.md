# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status  | Task                           | Files / Scope                                                              | Depends On | Verification                                                                                                                    |
| --- | ------- | ------------------------------ | -------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Done    | 写 GRANT migration 文件        | `packages/shared/migrations/20261021_drama_archive_grant_service_role.sql` | -          | 文件内容已按 2026-10-21 范围变更简化为单条 `GRANT USAGE ON SCHEMA drama_archive TO service_role;`，命名符合 `YYYYMMDD_描述.sql` |
| T2  | Done    | test 库前置权限核查            | 只读 SQL 查询（不落库，用户在 Supabase SQL Editor 跑）                     | T1         | 已取得 RLS/role_table_grants/schema USAGE/rolbypassrls/pg_policies 五组实测结果，详见下方 Execution Log                         |
| T3  | Done    | 执行 migration（test）         | `.github/workflows/db-migrate.yml`                                         | T2         | 工作流执行成功，project-ref 指向 test；证据见下方 Execution Log                                                                 |
| T4  | Done    | 执行后权限验证                 | 同 T2 查询                                                                 | T3         | service_role 的 schema USAGE 由 false 变 true；anon/authenticated 仍为 false；drama_worker 函数 EXECUTE 权限不变                |
| T5  | Skipped | 写 PostgREST 暴露脚本          | `ops/schema-split/postgrest-expose-test-drama-archive.sql`                 | -          | 用户 2026-10-21 决定跳过，走 Studio 手动暴露，出问题再处理，见下方 Execution Log                                                |
| T6  | Skipped | test 库执行 PostgREST 暴露变更 | 同上，手工 psql                                                            | T5         | 同 T5，待 T8 实测如报 `PGRST106` 再回头处理                                                                                     |
| T7  | Done    | DOMAIN_SCHEMAS 代码改动        | `packages/backend/src/lib/supabase.ts`                                     | T4, T6     | `pnpm --filter @miniapp/backend typecheck` 通过                                                                                 |
| T8  | Done    | 端到端只读验证                 | 一次性验证脚本（验证后删除）                                               | T7         | `getDomainDb('drama_archive')` 查到至少一条真实 `videos` 行                                                                     |
| T9  | Done    | 私有桶签名验证                 | 一次性验证脚本（验证后删除）                                               | T4         | `createSignedUrl` 对已知 `object_path` 成功返回链接                                                                             |
| T10 | Done    | 记录结果、同步 Open Issue      | task.md 执行日志、父任务 prd.md                                            | T8, T9     | 执行日志含实测数据，非空泛结论                                                                                                  |

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
- **T3（Done，2026-10-21）**：用户在 GitHub Actions 手动触发 `.github/workflows/db-migrate.yml`，`workflow_dispatch` 参数 `mode=apply`、`environment=test`、`migration_file=packages/shared/migrations/20261021_drama_archive_grant_service_role.sql`、`force_rerun=false`。工作流的 `Migration summary` Step Summary 原文：

  ```
  ### Database migration operation completed

  - Environment: `test`
  - Project ref: `zoqelpfhurwehlvypryl`
  - Migration file: `packages/shared/migrations/20261021_drama_archive_grant_service_role.sql`
  - Mode: `apply`
  - force_rerun: `false`
  ```

  这个 Step Summary 只在 `success()` 时才会写（见 `.github/workflows/db-migrate.yml` 第 162 行 `if: ... && success()`），project-ref 确认是 test（`zoqelpfhurwehlvypryl`），说明文件内的 preflight 断言、`GRANT USAGE`、postflight 断言、`COMMIT` 都正常执行完毕，账本也已写入（`apply-repo-migration.sh` 的记账逻辑）。T4 会再跑一遍 `has_schema_privilege` 查询做独立确认，不只依赖这条 Step Summary。

- **T4（Done，2026-10-21）**：migration 执行后重跑 T2 的核查组合，结果：
  - ①（`has_schema_privilege`）：`service_role` 从 `false` 变为 `true`；`anon=false`、`authenticated=false`、`drama_worker=true` 均未变——符合预期，只有 `service_role` 拿到新 `USAGE`。
  - ②（`drama_worker` 函数 EXECUTE 清单）：8 个函数（`archived_messages`/`claim`/`fail`/`finish`/`import_video`/`regenerate_ai`/`renew`/`video_state`）`drama_worker_can_execute` 全部仍为 `true`，和 T2 实测④逐条比对完全一致——`drama_worker` 未受本次 migration 影响。
  - ③（`SET ROLE service_role` 后直接查行数）：`dramas=6`、`videos=16`、`ai_results=9`、`pipeline_tasks=48`，四张表全部可读，证实"USAGE + 既有表级权限"组合在真实查询层面生效，不只是 ACL 元数据层面。
  - ④（`SET ROLE anon` 后查 `videos`）：报错 `42501: permission denied for schema drama_archive`——`anon` 仍被 schema USAGE 这道闸门挡住，边界没有被放宽。
  - 结论：migration 效果与 design.md §2.1 修订后的预期完全吻合，T3+T4 验收通过。
- **T5/T6（Skipped，2026-10-21）**：design.md §2.2 原计划是写一个新的 `ops/schema-split/postgrest-expose-test-drama-archive.sql`、按"记录现状→确认一致→只追加→NOTIFY→curl 验证"的流程手动执行 `ALTER ROLE authenticator SET pgrst.db_schemas=...`。但用户已经在 T2 阶段通过 Supabase Studio 的 "Exposed schemas" 设置手动勾选保存了 `drama_archive`（具体生效通道当时查证不是直接写 `authenticator` 角色的 `pgrst.db_schemas`，原因未查清）。用户 2026-10-21 明确指示：不需要再纠结具体是哪条通道生效，直接跳过 T5/T6 这两步计划中的脚本化操作，等 T8（`getDomainDb('drama_archive')` 端到端验证）如果报 `PGRST106`（schema 未暴露）再回头针对性处理，不要为了这一点堵住后续节奏。
  - **T8 实测中确实遇到了问题，但不是 `PGRST106`**：第一次跑 T8 报的是 `PGRST205: Could not find the table 'drama_archive.videos' in the schema cache`——schema 本身已经被 PostgREST 接受（否则会是 `PGRST106`），只是 PostgREST 内部的 schema cache 还没重新内省过 `drama_archive` 的表结构。处理：在 Supabase SQL Editor 执行 `NOTIFY pgrst, 'reload schema';`（纯缓存刷新信号，不改权限/数据，无需回滚）。执行后重跑 T8 验证脚本，问题消失（见下方 T8 记录）。
  - 顺手又查了一次 `pg_db_role_setting`：这次 `authenticator` 的 `setconfig` 里**完全没有 `pgrst.db_schemas` 这一项**了（只剩 `session_preload_libraries`/`statement_timeout`/`lock_timeout`/`pgrst.db_extra_search_path`），和之前两次实测（10 项列表、不含 `drama_archive`）都不一样。说明 Studio 的 "Exposed schemas" 开关走的确实是另一条配置通道（不是 `ALTER ROLE authenticator SET pgrst.db_schemas`），具体是哪条通道仍未查清。按用户 2026-10-21 明确指示，不再继续排查这个通道细节——T8/T9 的真实查询结果已经是功能性的最终判据，这条留作已知的未解之谜，不阻塞任务推进。
- **T7（Done，2026-10-21）**：`packages/backend/src/lib/supabase.ts` 的 `DOMAIN_SCHEMAS` 追加 `'drama_archive'`，带说明注释（第九个域、未登记进八域地图、指向本任务 prd.md 的 Open Issue）。`pnpm run typecheck`（`packages/backend`）最终输出：

  ```
  src/features/image-plaza/seed-import.ts:5:67 - error TS2307: Cannot find module 'undici' ...
  src/platform/venice-http.ts:1:89 - error TS2307: Cannot find module 'undici' ...
  Found 2 errors in 2 files.
  ```

  这 2 个错误和本任务无关：本地 `packages/backend/node_modules/undici` 确实没装（已用 `ls` 核实），是环境依赖缺失，不是 `DOMAIN_SCHEMAS` 改动引入的新错误；本次改动涉及的文件（`supabase.ts` 及消费它的代码）没有任何类型错误。第一次跑的时候这两个错误之外还多了一个 `tmp-verify-drama-archive-access.ts:54` 的 `TS2532: Object is possibly 'undefined'`，是验证脚本自己的问题（`videos[0]` 在严格模式下不会因为前面判断过 `length` 就自动收窄类型），已改成 `const video = videos?.[0]` 的写法修掉，重跑后确认只剩前述 2 个无关错误。

- **T8（Done，2026-10-21）**：一次性脚本 `packages/backend/src/scripts/tmp-verify-drama-archive-access.ts`（已在本条记录后删除，不留在仓库里）用 `getDomainDb('drama_archive')` 查询 `videos` 表，强制把 `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` 映到 `.env` 里的 `TEST_SUPABASE_URL`/`TEST_SUPABASE_SERVICE_ROLE_KEY` 并校验 project ref 防止误连生产。第一次执行报 `PGRST205: Could not find the table 'drama_archive.videos' in the schema cache`（处理过程见上方 T5/T6 记录：`NOTIFY pgrst, 'reload schema'` 后问题消失）。重跑后终端输出：

  ```
  目标 project ref 校验通过: zoqelpfhurwehlvypryl
  T8 OK: 查到真实 videos 行: {
    id: 'd9d54f14-11af-506e-95db-d1145367b77c',
    object_path: 'videos/d9d54f14-11af-506e-95db-d1145367b77c/original'
  }
  ```

  查到的是一条真实存在的 `videos` 行（非构造数据），证明 GRANT USAGE + PostgREST 暴露（经 `NOTIFY` 刷新缓存后）+ `DOMAIN_SCHEMAS` 代码改动三者组合在真实查询链路上生效。

- **T9（Done，2026-10-21）**：同一次脚本执行，对上面那条 `videos` 行的 `object_path`（`videos/d9d54f14-11af-506e-95db-d1145367b77c/original`）调用 `getSupabaseClient().storage.from('drama-videos').createSignedUrl(objectPath, 60)`，终端输出：

  ```
  T9 OK: 签名链接已生成（60 秒内有效，只打印不含签名 token 的路径前缀）: {
    objectPath: 'videos/d9d54f14-11af-506e-95db-d1145367b77c/original',
    hasSignedUrl: true,
    pathPrefix: 'https://zoqelpfhurwehlvypryl.supabase.co/storage/v1/object/sign/drama-videos/videos/d9d54f14-11af-506e-95db-d1145367b77c/original'
  }
  ```

  `hasSignedUrl: true` 且路径前缀指向正确的私有桶 `drama-videos`，证明 `service_role` 默认就能对该桶签发短期播放链接，不需要额外的 bucket-level grant，和 design.md §2.4 的预期一致。验证脚本随后已删除（`rm packages/backend/src/scripts/tmp-verify-drama-archive-access.ts`，不进正式代码）。

- **T10（Done，2026-10-21）**：`prd.md` 的 Acceptance Criteria 七条全部勾选，每条都带实测证据指针（migration 文件/Step Summary/`task.md` 对应 Execution Log 条目），其中第 3、4 条按实际发生的情况做了文字修订（范围从"只读三表"改为"USAGE 开门即生效四表读写"；PostgREST 暴露从"脚本化追加 db_schemas"改为"Studio 设置生效，通道未查清但功能验证通过"），不是空泛打勾。`prd.md` 新增了「范围变更记录」章节完整写明前因后果。父任务 `10-21-drama-video-integration/prd.md` 的 Open Issue 第 1 条已核对，和本任务一致，无需改动；但发现父任务「核心设计约束」第 1 条（"backend 用自己的 service_role 直接只读这三张表"）与本任务实际落地的范围（USAGE 开门后四表读写）不一致——这条是跨子任务约束，会影响子任务 2（`10-21-drama-api-contract-backend`）的设计前提，已在对话里向用户提出修订建议、等待确认，不在本任务内自行改动父任务的核心设计约束。
