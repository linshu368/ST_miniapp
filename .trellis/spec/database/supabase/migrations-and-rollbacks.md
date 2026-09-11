# 迁移、发布与回滚

## 文件与不可变性

- 新 SQL 只添加到 `packages/shared/migrations/`。2026-09-10 起统一命名为 `YYYYMMDD_描述.sql`，并通过 `pnpm lint:migrations` 校验；三位编号文件属于冻结历史，不得继续编号、改名、编辑、重排或“清理”，也不得按编号推断依赖和环境执行状态。
- `supabase/config.toml` 当前 `schema_paths=[]`，本地 reset/push 不会自然代表 shared migrations 的执行链；必须使用项目约定的手工流程。
- 远端 test/production 的正式入口是 `.github/workflows/db-migrate.yml` 的 `workflow_dispatch`：一次选择一个 `packages/shared/migrations/*.sql`，保留 project-ref 校验、production 明文确认、environment concurrency 和执行摘要。本地 CLI 仅用于明确授权的本地/诊断场景，不能绕开工作流门禁。
- workflow 使用 `psql --no-psqlrc --set ON_ERROR_STOP=1 --file` 执行完整多语句文件。执行前按 filename 查询 `supabase_migrations.repo_migrations`，成功后记录 filename、checksum 与执行者；它是仓库迁移账本，不得与 Supabase CLI 自有 migration history 混淆。`force_rerun` 只能用于已审查的显式恢复场景。

## 设计必填

每个 migration 在 design/implement 中写：目标对象和 schema、前置 shape、数据量/锁、事务和幂等、backfill 批次、应用兼容顺序、RLS/grant、测试 SQL、失败停止条件、回滚或 forward-fix。

## 执行顺序

1. 对测试目标采集/验证前置 shape；
2. 审查 SQL，无 DDL/DML 误指生产；
3. 单文件执行；
4. 验证对象、约束、权限、关键读写和性能；
5. 记录结果后再进入下一文件；
6. 生产执行需独立确认，不因测试成功自动执行。

GitHub Actions 操作前再次核对 workflow 版本、目标 environment secrets 和输入文件；禁止把数据库 URI 复制到 issue、日志补充或任务 Markdown。

## 安全变更模式

- 破坏性字段采用 expand → 双兼容/回填 → consumer 切换 → contract；不得同次先删后发。
- 大表索引/约束评估 concurrent、NOT VALID/VALIDATE、statement/lock timeout 和 Railway/Supabase 连接影响。
- migration 应可重复检测目标 shape；不能真正幂等时明确“一次性”及安全失败条件。
- 回滚可能丢数据时优先 forward-fix；任何恢复步骤都写明数据损失边界和备份前提。
