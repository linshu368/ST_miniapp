---
module_id: shared.infrastructure.database-environment
title: 数据库环境与迁移公共配置
scope: shared
category: infrastructure
status: active
owners: [shared]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 数据库环境与迁移公共配置

## 职责与边界

提供 test/production 数据库配置解析与 migration 唯一来源约定。

## 当前状态

迁移集中在 `packages/shared/migrations`，环境必须显式区分。

## 入口与调用者

Backend、脚本和手工迁移流程使用。

## 涉及文件

| 路径                                     | 职责         |
| ---------------------------------------- | ------------ |
| `packages/shared/src/config/database.ts` | 环境配置     |
| `packages/shared/migrations/`            | SQL 唯一来源 |

## 关键实现链路

选择环境 → 校验 project ref → 单文件 migration → shape/RLS/读写验证。

## 数据、契约与外部依赖

依赖 Supabase/PostgreSQL，不存储 secret 值。

## 关键节点与约束

测试与生产不保证同构；迁移不随应用部署自动执行。

## 验证方式

Shared tests 与 database spec 的手工门禁。

## 已知缺口与待核验项

历史 migration 存在重号，不能按编号推断语义。

## 关联模块

`database.infrastructure.schema-security`。
