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

迁移集中在 `packages/shared/migrations`，新文件使用日期命名；远端 workflow 通过 `psql` 执行并使用 `supabase_migrations.repo_migrations` 查重/记账，环境必须显式区分。Batch Lab 浏览器契约复用相同环境口径，公开 preview/sample-set DTO、source environment、digest 与容量上限，但不暴露数据库连接配置。

## 入口与调用者

Backend、脚本和手工迁移流程使用。

## 涉及文件

| 路径                                     | 职责                     |
| ---------------------------------------- | ------------------------ |
| `packages/shared/src/config/database.ts` | 环境配置                 |
| `packages/shared/src/api/batch-lab.ts`   | Batch Lab 浏览器安全契约 |
| `packages/shared/migrations/`            | SQL 唯一来源             |
| `.github/workflows/db-migrate.yml`       | 手工远端执行入口         |

## 关键实现链路

选择环境 → 校验 project ref → 账本查重 → `psql` 单文件 migration → shape/RLS/读写验证 → 成功记账。Batch Lab preview/样本集响应必须携带 `source_environment` 与 digest，消费者缓存 key 也必须包含 backend/source 环境。

## 数据、契约与外部依赖

依赖 Supabase/PostgreSQL，不存储 secret 值。Shared 仅定义浏览器可见 DTO、错误码、容量上限和 runtime validation schema。

## 关键节点与约束

测试与生产不保证同构；迁移不随应用部署自动执行。契约中不得加入数据库 row、连接串、service-role key 或供应商 secret。

## 验证方式

Shared tests 与 database spec 的手工门禁。

## 已知缺口与待核验项

历史三位编号 migration 已冻结且存在重号；仓库账本只证明已记录的环境执行，不得用 migration 文件存在替代实库状态。Batch Lab 新 spec 已固定 test-first、单文件迁移、shape/RLS/读写验证和 forward-fix 口径。

## 关联模块

`database.infrastructure.schema-security`。

## 变更记录

- 2026-09-16：任务 `Batch Lab 数据库域、环境与样本集`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-data-samples/`）更新模块知识文档；commit：`14124a5b9df62627bb9fddfd722194206a0aa83b`。
- 2026-09-17：任务 `Batch Lab 集成验收、发布与 Spec 收口`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-integration-spec/`）收口 Batch Lab integration/spec、发布回滚、环境与剩余人工核验事实；提交前归档，见本任务后续 Git 提交。
