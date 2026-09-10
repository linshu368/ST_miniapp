# Preset Platform 数据库独立域实施计划

## 顺序

1. 扫描最新 migration 编号和 `docs/schema归属地图.md`，确认不按旧编号推断。
2. 设计 `preset_platform` schema 表、索引、FK、check、comment、RLS/grant 和 RPC。
3. 编写单文件 migration，文件头声明 `-- domain: preset_platform`。
4. 在 test 库按单文件流程执行，记录 shape、权限、允许/拒绝路径、并发/幂等、分页 explain、锁/容量。
5. 验证 rollback 或 forward-fix 路径；生产执行另行确认。
6. 更新 `.trellis/spec/database/supabase/*`、`docs/schema归属地图.md` 和迁移执行记录。

## 验证

```bash
pnpm --filter @miniapp/shared test
# test DB: GitHub Actions Database Migration 单文件执行
# SQL/RLS/RPC 验证命令和结果写回任务记录
```
