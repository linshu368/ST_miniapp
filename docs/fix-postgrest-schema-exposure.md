# 修复 PostgREST 自定义 Schema 暴露问题

> 适用场景：Supabase 远程项目（test / production）新增自定义 schema 后，REST API 报 `PGRST106 Invalid schema`。

## 问题现象

Provision 通过 `supabase-js` 的 `.schema('st_platform')` 访问表时，PostgREST 返回：

```json
{
  "code": "PGRST106",
  "message": "Invalid schema: st_platform",
  "hint": "Only the following schemas are exposed: public, graphql_public, miniapp"
}
```

本地 `config.toml` 中已配置 `schemas = ["public", "graphql_public", "miniapp", "st_platform", "st_users", "st_infra"]`，但远程项目不生效。

## 根因

PostgREST 的 `db_schemas` 配置有两条传递路径：

| 路径                       | 机制                                                   | 生效方式     |
| -------------------------- | ------------------------------------------------------ | ------------ |
| Dashboard / Management API | 写入 Supabase 管理层 → 需要平台编排重启 PostgREST 容器 | 依赖外部重启 |
| 数据库 GUC + NOTIFY        | 写入 PostgreSQL 角色配置 → PostgREST 内部热加载        | 不需要重启   |

**Dashboard 修改后 PostgREST 进程不一定会重启**（平台编排可能延迟或失效），导致配置已存储但运行时未加载。

## 修复方法

在 Supabase SQL Editor（或 psql）中执行：

```sql
-- 1. 将 schema 列表写入 authenticator 角色的 GUC
--    PostgREST 连接时以 authenticator 身份读取此配置
ALTER ROLE authenticator SET pgrst.db_schemas =
  'public,graphql_public,miniapp,st_platform,st_users,st_infra';

-- 2. 通知 PostgREST 重新加载配置（发现新 schema）
NOTIFY pgrst, 'reload config';

-- 3. 通知 PostgREST 重新扫描表结构（发现 schema 里的表）
NOTIFY pgrst, 'reload schema';
```

## 验证

```bash
cd packages/sync-engine
npx tsx scripts/probe-postgrest-schemas.ts
```

期望输出全部 ✅。如果仍有 `PGRST205 Could not find table in schema cache`，说明第 3 步 `reload schema` 需要再执行一次。

## 排查时的关键诊断命令

### 查看 PostgREST 实际暴露了哪些 schema

用一个不存在的 schema 触发错误，hint 中会列出完整的合法列表：

```bash
curl -s "https://<project_ref>.supabase.co/rest/v1/x" \
  -H "apikey: $SERVICE_ROLE_KEY" \
  -H "Accept-Profile: nonexistent_schema"
```

### 查看 Management API 中存储的配置

```bash
curl -s "https://api.supabase.com/v1/projects/<project_ref>/postgrest" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"
```

### 检查 authenticator 角色对各 schema 的 USAGE 权限

```sql
SELECT
  nspname AS schema_name,
  has_schema_privilege('authenticator', nspname, 'USAGE') AS authenticator_can_usage
FROM pg_namespace
WHERE nspname IN ('public', 'miniapp', 'st_platform', 'st_users', 'st_infra');
```

## 常见误区

| 你做了什么                              | 为什么没用                                              |
| --------------------------------------- | ------------------------------------------------------- |
| Dashboard 改了 Exposed Schemas 并点保存 | 配置写入管理层，但 PostgREST 容器未重启，运行时没加载   |
| `NOTIFY pgrst, 'reload schema'`         | 这只刷新表/函数缓存，不会重新加载 `db_schemas` 配置本身 |
| Management API PATCH db_schemas         | 同 Dashboard，只是换了入口写同一处配置                  |
| API 调 `/restart` 重启项目              | 不保证 PostgREST 进程真正重启，或重启后仍读旧环境变量   |

## 新环境部署 Checklist

当部署到新的 Supabase 项目或创建新的 Branching 分支时，确保在迁移完成后执行：

1. ✅ 跑完所有 `packages/shared/migrations/` 下的 SQL（schema + 表 + RLS）
2. ✅ 执行本文档中的 `ALTER ROLE authenticator SET pgrst.db_schemas = ...`
3. ✅ 执行 `NOTIFY pgrst, 'reload config'` + `NOTIFY pgrst, 'reload schema'`
4. ✅ 用 `probe-postgrest-schemas.ts` 验证

## 相关文件

- `supabase/config.toml` — 本地 PostgREST schema 配置（仅本地生效）
- `packages/shared/migrations/003_create_st_schemas.sql` — schema 创建 + 权限
- `packages/sync-engine/scripts/probe-postgrest-schemas.ts` — 诊断脚本
- `packages/sync-engine/src/provisioner/fetcher.ts` — provision 数据拉取逻辑

## 时间线（2026-07-02 首次修复）

- 发现 provision 从 test 分支拉不到 `st_platform.platform_presets`
- 诊断确认 PostgREST 只暴露 `public, graphql_public, miniapp`
- Dashboard 修改 + API PATCH + 项目重启均无效
- 最终通过 `ALTER ROLE authenticator SET pgrst.db_schemas` + `NOTIFY pgrst, 'reload config/schema'` 修复
