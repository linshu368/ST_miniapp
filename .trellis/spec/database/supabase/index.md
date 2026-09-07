# Supabase 与数据库迁移规范

适用于 `packages/shared/migrations/*.sql`、Supabase/PostgREST 配置、Prisma 映射、运行时数据库访问和结构文档。

## 专题规范

- [Schema 与对象约定](./schema-and-object-conventions.md)
- [迁移、发布与回滚](./migrations-and-rollbacks.md)
- [安全、RLS 与授权](./security-rls-and-grants.md)
- [MCP 采集与文档维护](./introspection-and-documentation.md)
- [测试库结构参考](./test-database-reference.md)（当前等待 Supabase MCP 连接）

## 证据标签

- `TEST-DB`：已确认指向测试项目的 MCP 只读实况；
- `MIGRATION`：`packages/shared/migrations` 声明，不等于已执行；
- `CONFIG`：`supabase/config.toml`/运维配置，不等于远端已生效；
- `DOC`：有日期的历史文档；
- `GAP`：来源冲突或无法解释。

## Pre-Development Checklist

1. 阅读 `docs/ARCHITECTURE.md` 数据库章节、`docs/schema*`、`ops/schema-split/inventory.sql` 和相关 migration。
2. 搜索 `.from()`、`.rpc()`、`.schema()`、raw SQL、Prisma model、repository、函数/view/trigger/FK/cron 引用。
3. 明确 schema 归属、锁与容量、事务、幂等、RLS/grant、发布顺序、验证和回滚。
4. test 与 production 不保证同构；不得将一方结果冒充另一方。

## Required Rules

- `packages/shared/migrations/` 是唯一 migration 源；禁止建立 `supabase/migrations` 平行来源或改写历史文件。
- 每次只执行并验证一个 migration；测试库验证后才规划生产执行，生产必须附回滚/恢复说明。
- `public` 和旧 `analytics` 属旧 bot 边界；无已批准 PRD 不得修改/引用。
- 删除/瘦身必须同时获得应用无引用、数据库内部无引用、生产无读写证据三类负信号。
- 禁止将数据导出、业务行、JWT、连接串、service-role key 或敏感归档提交 Git。

## Quality Check

验证 SQL 语法、幂等性、事务与锁、权限/RLS、跨 schema 依赖、测试库执行前后 shape、回滚与观察。将环境、命令、结果和差异记录到任务，禁止只写“执行成功”。
