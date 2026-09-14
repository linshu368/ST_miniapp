---
module_id: database.infrastructure.schema-security
title: Schema、RLS 与迁移执行基建
scope: database
category: infrastructure
status: active
owners: [database]
last_verified_task: .trellis/tasks/09-11-package-spec-module-sync/
last_verified_at: 2026-09-11
---

# Schema、RLS 与迁移执行基建

## 职责与边界

定义八域归属、跨域边界、RLS/grant，以及日期命名、账本治理和 `psql` 单文件迁移纪律。

## 当前状态

一阶段 schema 划分已生产落地，miniapp 空壳仍待收口。

## 入口与调用者

所有新增表、函数、repository 和生产迁移任务遵守。

## 涉及文件

| 路径                               | 职责               |
| ---------------------------------- | ------------------ |
| `packages/shared/migrations/`      | migration 唯一来源 |
| `docs/ARCHITECTURE.md`             | 现行域归属说明     |
| `.github/workflows/db-migrate.yml` | 手工执行入口       |

## 关键实现链路

声明 domain → test 账本查重/`psql` 单文件执行 → shape/RLS/关键读写 → 成功记账 → production 人工确认。

## 数据、契约与外部依赖

Supabase PostgreSQL/PostgREST/Auth/Storage。

## 关键节点与约束

禁止平行 migration 源；新文件必须日期命名；生产先测试并记录锁、容量、账本状态和回滚。

## 验证方式

Database spec checklist、实库只读结构采集和应用层回归。

## 已知缺口与待核验项

空壳 schema 与旧 public 函数待独立评审。

## 关联模块

`backend.infrastructure.runtime-data-security`、`shared.infrastructure.database-environment`。
