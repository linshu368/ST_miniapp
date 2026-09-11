# MCP 采集与数据库文档维护

## 前置门禁

只有在 MCP 明确显示目标为仓库测试项目时，才能写 `TEST-DB`。连接缺失或目标不明时标记 Blocked，不得用 migration/config/history 猜测实况。仅运行 catalog/information_schema/pg_catalog 只读查询，不执行 DDL/DML，不读取业务行。

## 必采对象

schemas；tables/views/materialized views；columns（类型、nullable、default、identity/generated、comment）；PK/FK/unique/check；indexes；RLS 开关/policies；functions/procedures（签名、返回、安全模式、语言、comment）；triggers；enum/custom types；grants；跨 schema 依赖与 cron（若可见）。

## 对账

将 MCP 实况与 `packages/shared/migrations`、`supabase/config.toml`、`ops/schema-split/inventory.sql`、`docs/schema*` 对账。每项差异标 `GAP`，说明“测试库额外/缺失/定义不同/权限不同/待确认”，禁止通过修改文档抹平差异。

## 文档格式

记录项目 ref（非 secret）、环境、UTC/本地采集时间、工具/查询版本、schema 对象计数和限制；按 schema 列对象与字段。明确“不代表生产库”。更新数据库变更时同步参考文档；任何疑似 key/JWT/URI/个人数据先删除再提交。
