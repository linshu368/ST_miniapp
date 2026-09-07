# Supabase 测试库结构参考

> **状态：Blocked（2026-09-07）**。当前执行环境未提供可调用的 Supabase MCP server/resource/tool，无法确认连接目标或只读采集测试库。本文不得由 migration、`config.toml` 或历史 snapshot 代填。

## 计划采集范围

- 目标：仓库 `supabase:link:test` 所指测试项目；实施时必须由 MCP 返回身份后核对。
- 业务 schema 候选：`app_core`、`miniapp_features`、`experience`、`billing`、`admin`、`cs_platform`、`miniapp_traffic`、`miniapp_analytics`。
- 对象：relations、字段、约束、索引、RLS/policies、functions、triggers、types、grants、comments 和跨 schema 依赖。

## 解阻条件

1. 用户/运行环境连接 Supabase MCP；
2. MCP 明确指向测试项目而非生产；
3. 工具提供只读元数据查询；
4. 采集后按 [MCP 采集规范](./introspection-and-documentation.md) 对账和脱敏。

在解阻前，没有任何内容可标记为 `TEST-DB`，且本文明确不代表生产库。
