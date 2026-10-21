# 执行计划：drama_archive 域授权与访问接入

严格按顺序执行，每步验证通过再进入下一步；任一步失败就停下来，不跳过验证直接往后做。

## 步骤

1. **写 migration 文件**：新建 `packages/shared/migrations/20261021_drama_archive_grant_service_role.sql`，内容见 `design.md` §2.1。本地走 `pnpm lint:migrations`（如仓库已配置）确认命名/格式合规。
2. **test 库执行前置核查**：用只读查询确认 `service_role`/`anon`/`authenticated` 当前对 `drama_archive` 确实没有任何表权限，记录结果。
3. **执行 migration**：通过 `.github/workflows/db-migrate.yml` 的 `workflow_dispatch`，目标选 test 项目、文件选刚创建的那个。执行前再次确认 workflow 输入的 project-ref 确实指向 test，不是生产。
4. **执行后验证**：重跑步骤 2 的查询，确认只多出 `service_role` 的 `USAGE` + 三张表 `SELECT`；`anon`/`authenticated` 仍为空；`drama_worker` 的权限（函数 EXECUTE 列表）与执行前一致。把前后对比记录进 task.md 执行日志。
5. **写 PostgREST 暴露脚本**：新建 `ops/schema-split/postgrest-expose-test-drama-archive.sql`，按 `design.md` §2.2 的三步模式（记录现状 → 追加 → 验证）。
6. **test 库执行 PostgREST 暴露变更**：先跑 step 0 记录当前 `pgrst.db_schemas`，确认和已知现状一致后再追加 `drama_archive`；执行后用 `curl` 带 `Accept-Profile: drama_archive` 验证能拿到 200（而不是 `PGRST106`）。
7. **改 DOMAIN_SCHEMAS**：编辑 `packages/backend/src/lib/supabase.ts`，追加 `'drama_archive'` 并带上说明注释；跑 `pnpm --filter @miniapp/backend typecheck`。
8. **端到端只读验证**：写一个一次性脚本（不进正式代码库，或写完验证完立即删除），用 `getDomainDb('drama_archive')` 查询 test 库里至少一条真实 `videos` 行，确认权限 + 暴露列表 + 代码改动三者合在一起真正生效。
9. **私有桶签名验证**：同一个一次性脚本（或单独脚本）对一个已知 `object_path` 调 `storage.from('drama-videos').createSignedUrl(path, 60)`，确认返回链接可访问。验证完清理临时脚本，不留在仓库里。
10. **记录与收尾**：在 task.md 执行日志里写清楚每一步的实测结果（不写"执行成功"这种空泛结论，要有查询结果/返回值摘要）；确认父任务 `prd.md` 的 Open Issue 条目和本任务一致。

## 验证命令

```bash
pnpm --filter @miniapp/backend typecheck
```

其余验证是 SQL 查询 / `curl` / 一次性 Node 脚本，不是现成的 pnpm 命令，执行结果需要人工记录在 task.md。

## 风险与回滚点

- 步骤 3（GRANT）和步骤 6（PostgREST 暴露）都是对 test 项目共享基础设施的改动，执行前必须确认目标环境是 test，不是生产；这两步各自独立可回滚，不需要联动。
- 步骤 6 影响面最大（`authenticator` 角色的全局 GUC），如果追加后发现现有功能（走 PostgREST 的其他域请求）出现异常，立即执行回滚 `ALTER ROLE` 恢复 step 0 记录的原值，并停止后续步骤。
- 步骤 7 只是类型层面的改动，没有运行时风险，可以直接 revert。
