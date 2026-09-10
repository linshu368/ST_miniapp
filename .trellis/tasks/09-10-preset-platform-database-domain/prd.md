# Preset Platform 数据库独立域

## Goal

创建 preset_platform schema、表、RLS/grant、RPC、审计与迁移验证方案。

## Requirements

- 在 `packages/shared/migrations/` 新增单文件 migration，创建独立 `preset_platform` schema。
- 表范围包括 preset definitions、私有 drafts、immutable releases、platform default pointer、私有 test sessions、test messages、audit log。
- 所有对象声明 `-- domain: preset_platform`，并使用 UUID/timestamptz、显式 check/FK/index/comment。
- RLS/grant 按 viewer/operator/publisher/owner 权限分层；会话和草稿必须按 operator 私有。
- RPC 覆盖发布/回滚、开轮、收口、幂等请求和版本冲突；`SECURITY DEFINER` 必须固定 search_path、撤销 PUBLIC execute。
- 生产库允许保存 `preset_platform` 工作台数据，但不得写入 `admin` 或 MiniApp 业务域。
- 跨域角色卡和真实输入只读访问必须通过 repository/RPC/API 边界，不直接 JOIN 其他域表。
- 本任务不实现 backend/SPA，只交付数据库结构、权限和验证记录。

## Acceptance Criteria

- [ ] test 库单文件 migration 执行并记录前后 shape、RLS/grant、RPC 权限、锁/容量和回滚。
- [ ] 允许/拒绝路径覆盖匿名、普通登录、viewer、operator、publisher、service role。
- [ ] 会话/草稿私有、发布版本 immutable、默认 pointer 原子切换、request id 幂等均有数据库级验证。
- [ ] 分页查询有稳定排序和 explain 记录。
- [ ] 生产执行前有独立确认、回滚或 forward-fix 说明。
- [ ] 根据实现补充 `.trellis/spec/database/supabase/*`、`docs/schema归属地图.md` 和 migration 执行记录。

## Notes

- 依赖 `09-10-preset-platform-shared-contracts` 的契约口径。
- 不得创建 `supabase/migrations/` 平行来源。
