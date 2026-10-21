# drama_archive 域授权与访问接入

> 方案来源：`docs/短剧视频接入方案.md` §2.1、§5.5；父任务 `10-21-drama-video-integration`。
> 本任务是父任务三个子任务中的第一个（前置阻塞项），其余两个子任务在本任务验收通过前不得开始实现。

## Background

`telegram-video-archive`（独立 Python 项目）已经把短剧视频归档进 Supabase **test 库**的 `drama_archive` schema（`dramas`/`videos`/`ai_results`/`pipeline_tasks` 四张表 + 私有桶 `drama-videos`）。这批对象是该项目直接对 Supabase 执行 `telegram-video-archive/migrations/001_pipeline.sql` 建的，**不经过** ST_miniAPP 的迁移通道。

该迁移在收尾阶段显式执行了：

```sql
FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA drama_archive FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA drama_archive FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA drama_archive FROM %I', r);
END LOOP;
```

四张表均已 `ENABLE ROW LEVEL SECURITY` 且**没有任何 policy**（"No client policies. Worker gets only narrowly scoped SECURITY DEFINER functions."），只有 `drama_worker`（下载/AI pipeline 专用角色）拿到 `USAGE` + 表 `SELECT/INSERT/UPDATE` 的等效权限（通过其专属 `SECURITY DEFINER` 函数，未直接 GRANT 表权限给它）。

**结论**：ST_miniAPP backend 现在用的 `service_role` 读不了 `drama_archive` 的任何一行。这是原设计刻意把下载链路和 miniapp 隔离开，不是 bug。本任务要新增一条**只读**授权，让 backend 能用自己的 `service_role` 直接查询这四张表中的三张（不含 `pipeline_tasks`），而不触碰 `drama_worker` 现有的权限边界。

## Goal

在 **test 项目**完成以下四件事，使 backend 具备读取 `drama_archive.dramas/videos/ai_results` 并对私有桶 `drama-videos` 签发短期播放链接的能力：

1. **（2026-10-21 实测后修订，见下方「范围变更记录」）** 新增一条 migration，对 `service_role` 授予 `drama_archive` schema 的 `USAGE`。执行前实测发现 `service_role` 在表级 ACL 上早已挂着全部四张表（含 `pipeline_tasks`）的 `SELECT/INSERT/UPDATE/DELETE`（历史遗留，非本任务授予），且 `service_role.rolbypassrls = true`；本任务唯一缺的闸门就是 schema `USAGE`。用户已确认原「只读三表、不授权 pipeline_tasks」的限制不再是硬约束（后续功能需要 backend 读写这些表），因此 migration 只需单条 `GRANT USAGE ON SCHEMA drama_archive TO service_role;`，不新增任何 `GRANT SELECT`（已存在，多授予一次是空操作）。**不**修改 `drama_worker` 现有权限，**不**改变 `anon`/`authenticated` 的权限边界（两者仍然没有 schema `USAGE`，保持拿不到任何数据）。
2. test 项目 PostgREST 的 `pgrst.db_schemas` 暴露列表追加 `drama_archive`（只追加、不重排现有项），否则 `getDomainDb('drama_archive')` 会报 `PGRST106`。
3. `packages/backend/src/lib/supabase.ts` 的 `DOMAIN_SCHEMAS` 字面量数组追加 `'drama_archive'`，否则类型检查过不去。
4. 验证 `service_role` 对私有桶 `drama-videos` 具备 `createSignedUrl` 所需的权限（预期默认可用，这里只是落地确认，不代表需要新增桶策略）。

## Non-Goals

- 不修改 `drama_worker` 的任何现有权限或其 `SECURITY DEFINER` 函数。
- 不创建新表、视图或数据库函数。
- 不实现 backend 的 repository/路由代码（那是子任务 `10-21-drama-api-contract-backend` 的范围，本任务只解除它的前置阻塞）。
- 不在本任务内把 `drama_archive` 正式登记进 `.trellis/spec/database/supabase/schema-and-object-conventions.md` 的八域地图——这是已知的规范缺口（见 Open Issue），本轮只记录，不裁决，二期再处理。
- 不动生产库；本任务全程只针对 **test 项目**。

## Constraints

- `packages/shared/migrations/` 是本仓库唯一 migration 源；新 SQL 必须落在这里，命名 `YYYYMMDD_描述.sql`，通过 `.github/workflows/db-migrate.yml` 的 `workflow_dispatch` 单文件执行，不走本地 CLI 绕过工作流门禁。
- PostgREST 暴露列表变更参照 `ops/schema-split/postgrest-expose-test.sql` 的既有模式（记录现状 → 断言现状一致 → 追加 → 验证），顺序只追加、不重排——`db_schemas` 第一项是无 `Accept-Profile` 时的默认 schema，重排会静默改变默认目标。
- `service_role` 本身绕过 RLS（Supabase 约定），所以不需要为这次只读授权新增 RLS policy；但必须验证 `anon`/`authenticated` 在改动后仍然被 REVOKE，没有被意外放宽。
- 每个 migration 必须先在 test 库验证前置 shape、单文件执行、执行后验证对象/权限，再进入下一文件；生产环境不在本任务范围内。

## Acceptance Criteria

- [ ] test 项目新增 migration 文件已在 `packages/shared/migrations/` 落地，内容只包含对 `service_role` 的 `GRANT USAGE ON SCHEMA drama_archive`，不含对 `drama_worker` 的任何改动。（2026-10-21 修订：原"只授权 dramas/videos/ai_results 三表 SELECT、不含 pipeline_tasks"的限制已按用户决定放宽，见下方「范围变更记录」；不再新增显式 `GRANT SELECT`，因为表级权限已经存在。）
- [ ] 该 migration 已通过 `.github/workflows/db-migrate.yml` 在 **test** 项目执行成功，并记录执行前后的 `information_schema`/`pg_catalog` 权限查询结果作为证据。
- [ ] 执行后验证：用 `service_role` key 能 `SELECT`（以及按修订后范围能 `INSERT`/`UPDATE`/`DELETE`）`dramas`/`videos`/`ai_results`/`pipeline_tasks`；用 `anon`/`authenticated` key（或等效查询）确认仍然没有 `drama_archive` schema 的 `USAGE`、拿不到任何一行。
- [ ] test 项目 `authenticator` 角色的 `pgrst.db_schemas` 已追加 `drama_archive`，且原有 5 项（`public, graphql_public, miniapp, miniapp_traffic, admin` 等现状，以实测为准）顺序未变、未被移除。
- [ ] `packages/backend/src/lib/supabase.ts` 的 `DOMAIN_SCHEMAS` 已追加 `'drama_archive'`，`pnpm --filter @miniapp/backend typecheck` 通过。
- [ ] 用临时验证脚本（一次性、不进正式代码）通过 `getDomainDb('drama_archive')` 对 test 库查询到至少一条真实 `videos` 行，证明暴露列表 + GRANT + 代码改动三者共同生效；验证后清理临时脚本。
- [ ] 已用 `service_role` key 对私有桶 `drama-videos` 实际调用一次 `createSignedUrl`（任选一个已存在的 `object_path`）并成功返回可用链接。
- [ ] `drama_archive` 未登记进八域地图这一缺口已在 `design.md` 和父任务 `prd.md` 的 Open Issue 中记录，并留下二期处理的待办指向。

## 范围变更记录（2026-10-21，执行期间）

T2 前置核查（见 `task.md` Execution Log）发现实际状态和本文档开头的「结论」不一致：

- `information_schema.role_table_grants` 显示 `service_role`（以及 `anon`/`authenticated`）在表级 ACL 上早已拥有 `drama_archive` 全部四张表（含 `pipeline_tasks`）的 `SELECT/INSERT/UPDATE/DELETE`，这些授权先于本任务存在，原因未知，按实测为准、不回填猜测。
- `service_role` 和 `anon`/`authenticated` 当前都没有 schema 级 `USAGE`；这是唯一还在挡着访问的闸门。`pg_roles.rolbypassrls` 确认 `service_role = true`（绕过 RLS），`anon`/`authenticated`/`drama_worker = false`。
- `pg_policies` 确认 `drama_archive` 四张表确实零 policy，符合原文档描述。

结论：本任务最初设计的「只读、排除 pipeline_tasks」的 GRANT 方案，如果只补一条 schema `USAGE`，会连带把表级 ACL 里早已存在的 `pipeline_tasks` 读写权限和其余三表的写权限一起激活（因为 `service_role` 绕过 RLS，表级授权一旦可达就是真实可用的，不是摆设）。用户在 2026-10-21 确认：这个"只读三表"的限制不是硬约束，backend 以后确实需要读写这些表，所以接受这个连带效果，不需要额外加 `REVOKE` 去收紧它。最终方案简化为单条 `GRANT USAGE ON SCHEMA drama_archive TO service_role;`。`anon`/`authenticated`/`drama_worker` 的权限边界不受影响。

另：用户已在 Supabase Studio 手动把 `drama_archive` 加入 "Exposed schemas"（跳过了 design.md §2.2 原计划的脚本化记录/追加流程）。实测 `pg_db_role_setting` 查询暂时还没看到 `authenticator` 角色的 `pgrst.db_schemas` 包含 `drama_archive`（原 10 项顺序未变），具体是走了哪条生效通道尚未查清。用户已明确这个不确定性可以接受、不要卡住后续节奏，以 T6 的 `curl -H "Accept-Profile: drama_archive"` 实测结果为准；如果届时仍不通，再回头排查。

## Open Issue（记录，不在本任务裁决）

`drama_archive` 目前不在 `.trellis/spec/database/supabase/schema-and-object-conventions.md` 的八域地图（`app_core`/`miniapp_features`/`experience`/`billing`/`admin`/`cs_platform`/`miniapp_traffic`/`miniapp_analytics`）里，且该规范明确要求"不得为了一个新功能创建新的 schema；扩展八域需要单独的架构决策、权限模型、迁移顺序和回滚方案"。

本任务不创建新 schema——`drama_archive` 已经由 `telegram-video-archive` 项目直接建好，本任务只是让 backend 以只读方式接入一个已存在、游离于域地图文档之外的 schema。这是方案文档 §5.5 已经写明、用户已确认延后到二期的已知缺口：本轮先让 `DOMAIN_SCHEMAS` 收录它，并在代码注释里显式承认这个缺口，不悄悄绕过规范；二期再补"正式架构决策 + 登记为第九个域（或并入 `miniapp_features`）"。
