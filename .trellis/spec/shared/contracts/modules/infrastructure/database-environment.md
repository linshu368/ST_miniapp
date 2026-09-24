---
module_id: shared.infrastructure.database-environment
title: 数据库环境与迁移公共配置
scope: shared
category: infrastructure
status: active
owners: [shared]
last_verified_task: .trellis/tasks/09-11-package-spec-module-sync/
last_verified_at: 2026-09-11
---

# 数据库环境与迁移公共配置

## 职责与边界

提供 test/production 数据库配置解析与 migration 唯一来源约定。

## 当前状态

## 入口与调用者

Backend、脚本和手工迁移流程使用。

## 涉及文件

| 路径                                     | 职责             |
| ---------------------------------------- | ---------------- |
| `packages/shared/src/config/database.ts` | 环境配置         |
| `packages/shared/migrations/`            | SQL 唯一来源     |
| `.github/workflows/db-migrate.yml`       | 手工远端执行入口 |

## 关键实现链路

## 数据、契约与外部依赖

依赖 Supabase/PostgreSQL，不存储 secret 值。Shared 仅定义浏览器可见 DTO、错误码、容量上限和 runtime validation schema。

## 关键节点与约束

测试与生产不保证同构；迁移不随应用部署自动执行。契约中不得加入数据库 row、连接串、service-role key 或供应商 secret。

## 验证方式

Shared tests 与 database spec 的手工门禁。

## 已知缺口与待核验项

## 关联模块

`database.infrastructure.schema-security`。

## 变更记录
