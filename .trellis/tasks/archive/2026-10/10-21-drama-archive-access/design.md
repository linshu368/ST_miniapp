# 技术设计：drama_archive 域授权与访问接入

## 1. 现状核实（来自 `telegram-video-archive/migrations/001_pipeline.sql` 实读）

- 四张表 `dramas`/`videos`/`ai_results`/`pipeline_tasks` 均已 `ENABLE ROW LEVEL SECURITY`，且**没有任何 policy**（注释原文："No client policies. Worker gets only narrowly scoped SECURITY DEFINER functions."）。
- `anon`/`authenticated`/`service_role` 三者都被显式 `REVOKE ALL ON SCHEMA/TABLES/FUNCTIONS`。
- `drama_worker` 没有被直接 `GRANT` 表权限，而是通过几个 `SECURITY DEFINER` 函数（`import_video`/`claim`/`renew`/`finish`/`fail`/`regenerate_ai`）间接读写，函数本身 `REVOKE ALL FROM PUBLIC` 后单独 `GRANT EXECUTE TO drama_worker`。
- `videos.object_path` 有 `CHECK (object_path = 'videos/' || id::text || '/original')` 约束，路径格式已在数据库层面固定，和方案文档 §2.1 描述一致。

**权限影响评估（2026-10-21 按 T2 实测修订）**：上面引用的 upstream REVOKE 脚本是读源码得出的推断，T2 对 test 库的实测显示和它不完全一致——`information_schema.role_table_grants` 里 `anon`/`authenticated`/`service_role` 当前在表级 ACL 上都挂着全部四张表的 `SELECT/INSERT/UPDATE/DELETE`（表级 `REVOKE` 似乎没有对这三个角色完全生效，原因未知，不回填推测）。实际挡住访问的闸门是 schema 级 `USAGE`：`has_schema_privilege` 实测显示 `service_role`/`anon`/`authenticated` 现在都是 `false`，只有 `drama_worker` 是 `true`。`pg_roles.rolbypassrls` 确认 `service_role = true`（绕过 RLS），`anon`/`authenticated` = `false`。`pg_policies` 确认四张表确实零 policy。

综合结论：`anon`/`authenticated` 即使将来拿到表级权限也会被"零 policy = 默认拒绝"挡住（它们不绕过 RLS）；`service_role` 绕过 RLS，所以它能不能访问完全取决于 schema `USAGE`——一旦补上，表级 ACL 里已经存在的权限立刻可用，不需要再额外 `GRANT`。因此本次改动**只需要 `GRANT USAGE ON SCHEMA drama_archive TO service_role`**，不需要新增/修改任何 RLS policy，也不需要额外的表级 `GRANT`（已存在）。

## 2. 改动范围

### 2.1 新 migration：`packages/shared/migrations/20261021_drama_archive_grant_service_role.sql`

**2026-10-21 修订**：T2 实测发现前置假设（"anon/authenticated/service_role 在表级也被 REVOKE 干净"）不成立——`service_role` 在表级 ACL 上早已拥有全部四张表（含 `pipeline_tasks`）的 `SELECT/INSERT/UPDATE/DELETE`，唯一缺的是 schema `USAGE`；`service_role.rolbypassrls = true`，所以一旦补上 `USAGE`，这些表级授权就会立即变成真实可用的读写权限。用户确认"只读三表、排除 pipeline_tasks"不是硬约束，接受这个连带效果，不需要额外 `REVOKE`。方案简化为：

```sql
GRANT USAGE ON SCHEMA drama_archive TO service_role;
-- dramas/videos/ai_results/pipeline_tasks 的表级 SELECT/INSERT/UPDATE/DELETE 已经存在（历史遗留，非本迁移授予）；
-- 补上 schema USAGE 后 service_role 即可直接使用这些既有表级授权，读写全部四张表。
-- 不修改 drama_worker 的任何权限；drama_worker 的访问路径（SECURITY DEFINER 函数）保持不变。
-- 不修改 anon/authenticated 的权限边界：二者目前都没有 drama_archive 的 schema USAGE，本迁移不触碰它们。
```

- 遵循 `packages/shared/migrations/` 命名规则 `YYYYMMDD_描述.sql`；按现有流程走 `.github/workflows/db-migrate.yml` 的 `workflow_dispatch`，一次只选这一个文件。
- 执行前用只读查询核对前置 shape：`information_schema.role_table_grants`（确认 `service_role` 表级权限的现状）+ `has_schema_privilege(rolname, 'drama_archive', 'USAGE')`（确认 `service_role`/`anon`/`authenticated` 当前都为 `false`，只有 `drama_worker` 为 `true`）。
- 执行后再跑同一组查询，确认只多出 `service_role` 对 schema 的 `USAGE`；`anon`/`authenticated` 的 `USAGE` 仍为 `false`；`drama_worker` 的函数 `EXECUTE` 权限不变。
- 这是纯增量授权，可通过对称的 `REVOKE USAGE ON SCHEMA drama_archive FROM service_role;` 回滚，不影响 `drama_worker` 的既有链路，回滚风险极低。

### 2.2 PostgREST 暴露列表：新增 `ops/schema-split/postgrest-expose-test-drama-archive.sql`

参照 `ops/schema-split/postgrest-expose-test.sql` 的既有模式（该文件记录的是 099 割接时的历史操作，本次是一次新的、独立的追加操作，不编辑历史文件）：

```sql
-- step 0：记录现状，贴进执行记录
SELECT r.rolname, s.setconfig
FROM pg_db_role_setting s
JOIN pg_roles r ON r.oid = s.setrole
WHERE r.rolname = 'authenticator';

-- step 1：断言现状与基线一致后，只追加 drama_archive，不重排、不删除已有项
-- 具体 ALTER ROLE authenticator SET pgrst.db_schemas = '<原有列表>, drama_archive';
-- 原有列表以 step 0 的实测结果为准，不凭历史文档推断

-- step 2：NOTIFY pgrst, 'reload config'（或等效的 PostgREST 重载方式，落地时核对 Supabase 项目是否需要手动触发）

-- step 3：用一次 PostgREST 请求验证 Accept-Profile: drama_archive 能拿到 200 而不是 PGRST106
```

- 顺序只追加：`db_schemas` 第一项是无 `Accept-Profile` 时的默认 schema，重排会静默改变默认目标，这条规则不可违反。
- 这一步是本任务里对现有基础设施影响面最大的改动（影响所有通过 `authenticator` 走 PostgREST 的请求），执行前后都要留存 `pg_db_role_setting` 快照。

### 2.3 `packages/backend/src/lib/supabase.ts`：`DOMAIN_SCHEMAS` 追加

```ts
export const DOMAIN_SCHEMAS = [
  'app_core',
  'miniapp_features',
  'experience',
  'billing',
  'admin',
  'cs_platform',
  'miniapp_traffic',
  'miniapp_analytics',
  'drama_archive', // 新增：第九个只读域，暂未登记进 schema-and-object-conventions.md 的八域地图，见本任务 prd.md Open Issue，二期处理
] as const;
```

- 只改这一处字面量数组；`getDomainDb('drama_archive')` 的类型检查会自动放行。
- 改动后运行 `pnpm --filter @miniapp/backend typecheck`。

### 2.4 私有桶 `drama-videos` 签名权限验证

- Supabase 私有桶默认 `service_role` 可以对任意对象 `createSignedUrl`，不需要 bucket policy 改动。
- 验证方式：用一个已存在的 `videos.object_path`（从 test 库查一条 `upload` 成功的记录），临时脚本调用 `supabase.storage.from('drama-videos').createSignedUrl(path, 60)`，确认返回签名 URL 且能直接访问。
- 若验证失败（权限不足），再评估是否需要显式 bucket-level grant；预期不需要，这里只是确认，不预先写容错代码。

## 3. 规范偏离记录（不回避，明确写清楚例外）

`.trellis/spec/database/supabase/schema-and-object-conventions.md` 规定：

> 不得为了一个新功能创建新的 schema；扩展八域需要单独的架构决策、权限模型、迁移顺序和回滚方案。

本任务**不创建新 schema**——`drama_archive` 是 `telegram-video-archive` 项目已经建好的既成事实，不经 ST_miniAPP 迁移通道产生。我们只是让 `DOMAIN_SCHEMAS` 以只读方式"看见"一个已存在、目前游离在八域地图之外的 schema。这不满足"扩展八域需要单独架构决策"的完整要求，是方案文档 §5.5 已经写明、用户已确认延后到二期的已知缺口。

本任务的处理方式：

1. 在代码注释（`supabase.ts`）和本任务文档里都显式写明这个缺口，不假装它已经被正式登记。
2. 父任务 `prd.md` 保留同一条 Open Issue，确保二期规划时不会遗漏。
3. 不因为这个缺口而阻塞 MVP——用户已经在方案文档里明确这是刻意的延后决定，不是本任务疏漏。

## 4. 验证清单（对应 prd.md 验收标准）

| 验证项                      | 方法                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| schema USAGE 生效           | migration 执行前后对比 `has_schema_privilege('service_role', 'drama_archive', 'USAGE')`：`false` → `true` |
| anon/authenticated 未被放宽 | 同一组 `has_schema_privilege` 查询确认两者仍为 `false`（既有表级 ACL 对它们无意义，因为还是没有 USAGE）   |
| drama_worker 未受影响       | 对比 migration 执行前后 `drama_worker` 的函数 EXECUTE 权限（应完全不变）                                  |
| PostgREST 暴露生效          | `curl` 带 `Accept-Profile: drama_archive` 的 PostgREST 请求返回 200                                       |
| DOMAIN_SCHEMAS 类型检查     | `pnpm --filter @miniapp/backend typecheck`                                                                |
| 端到端只读验证              | 临时脚本用 `getDomainDb('drama_archive')` 查到至少一条真实 `videos` 行后删除脚本                          |
| 私有桶签名                  | 临时脚本对一个已知 `object_path` 调 `createSignedUrl` 成功返回                                            |

## 5. 回滚

- migration：`REVOKE USAGE ON SCHEMA drama_archive FROM service_role;` 即可撤销（重新关上唯一的闸门，表级 ACL 保持原状不用动），不影响已存在数据，不影响 `drama_worker`。
- PostgREST 暴露列表：重新执行一次把 `drama_archive` 从 `db_schemas` 里移除的 `ALTER ROLE`，恢复 step 0 记录的原值。
- `DOMAIN_SCHEMAS` 代码改动：直接 revert 该行。
- 三者互相独立，任一步骤出问题都可以单独回滚，不需要联动回滚。
