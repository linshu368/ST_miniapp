---
module_id: database.infrastructure.schema-security
title: Schema、RLS 与迁移执行基建
scope: database
category: infrastructure
status: active
owners: [database]
last_verified_task: .trellis/tasks/09-11-batch-lab-data-samples/
last_verified_at: 2026-09-16
---

# Schema、RLS 与迁移执行基建

## 职责与边界

定义八域归属、跨域边界、RLS/grant，以及日期命名、账本治理和 `psql` 单文件迁移纪律。

## 当前状态

一阶段 schema 划分已生产落地，miniapp 空壳仍待收口。Batch Lab 新增独立内部调试域 `batch_lab`，由 migration `110_batch_lab_samples.sql` 管理样本 preview、冻结样本集、source reader/login 角色和 PostgREST service-role 访问边界；真实业务域不得依赖 `batch_lab`。

## 入口与调用者

所有新增表、函数、repository 和生产迁移任务遵守。

## 涉及文件

| 路径                                                   | 职责                           |
| ------------------------------------------------------ | ------------------------------ |
| `packages/shared/migrations/`                          | migration 唯一来源             |
| `packages/shared/migrations/110_batch_lab_samples.sql` | Batch Lab 样本域与只读授权     |
| `ops/batch-lab/README.md`                              | Batch Lab 暴露/回滚/LOGIN 顺序 |
| `docs/ARCHITECTURE.md`                                 | 现行域归属说明                 |
| `.github/workflows/db-migrate.yml`                     | 手工执行入口                   |

## 关键实现链路

声明 domain → test 账本查重/`psql` 单文件执行 → shape/RLS/关键读写 → 成功记账 → production 人工确认。Batch Lab 迁移先创建 deny-by-default 的 `batch_lab` 表/RPC，再单独人工暴露 PostgREST schema；来源 LOGIN/secret 与真实连接验证必须独立授权，不随 migration 自动开启。

## 数据、契约与外部依赖

Supabase PostgreSQL/PostgREST/Auth/Storage。Batch Lab 平台写入使用 service-role 访问 `batch_lab`，来源读取使用专用 PostgreSQL 只读角色访问必要业务表。

## 关键节点与约束

禁止平行 migration 源；新文件必须日期命名；生产先测试并记录锁、容量、账本状态和回滚。Batch Lab 表启用 RLS 且 anon/authenticated 无 schema usage；`SECURITY INVOKER` RPC 只授予 service_role/postgres；来源角色必须 NOLOGIN 直到人工设置 secret，并保持 read-only、5s statement timeout、500ms lock timeout。

## 验证方式

Database spec checklist、实库只读结构采集和应用层回归。Batch Lab 还需验证 SQL 拒写、只读角色负测、preview/freeze 原子性、幂等冲突和回滚事务。

## 已知缺口与待核验项

空壳 schema 与旧 public 函数待独立评审。Batch Lab test 分支真实双 direct 会话锁等待与重新授权后的来源连接验证仍需人工执行；不得用 production 或离线测试替代。

## 关联模块

`backend.infrastructure.runtime-data-security`、`shared.infrastructure.database-environment`。

## 变更记录

- 2026-09-16：任务 `Batch Lab 数据库域、环境与样本集`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-data-samples/`）更新模块知识文档；commit：`14124a5b9df62627bb9fddfd722194206a0aa83b`。
