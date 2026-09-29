---
module_id: database.infrastructure.schema-security
title: Schema、RLS 与迁移执行基建
scope: database
category: infrastructure
status: active
owners: [database]
last_verified_task: .trellis/tasks/09-28-remove-advanced-image-generation/
last_verified_at: 2026-09-28
---

# Schema、RLS 与迁移执行基建

## 职责与边界

定义八域归属、跨域边界、RLS/grant、日期命名、账本治理和 `psql` 单文件迁移纪律。生产迁移必须测试优先、人工执行并记录 shape、权限、容量与回滚。

## 当前状态

高级图片应用退场后，`20260928_remove_advanced_image_config.sql` 作为待人工执行的 forward migration，删除四个 `image_advanced_*` runtime/Admin 配置并以 managed-key、validator 和 CHECK 三层阻止回写；普通图片 `feature_free_trial_limits.basic_image`、历史图片 attempt 与结算对象不变。

## 入口与调用者

## 涉及文件

| 路径                                                                   | 职责                               |
| ---------------------------------------------------------------------- | ---------------------------------- |
| `packages/shared/migrations/`                                          | migration 唯一来源                 |
| `docs/ARCHITECTURE.md`                                                 | 现行域归属说明                     |
| `.github/workflows/db-migrate.yml`                                     | 手工执行入口                       |
| `packages/shared/migrations/20260928_remove_advanced_image_config.sql` | 高级图片配置退场 forward migration |

## 关键实现链路

## 数据、契约与外部依赖

## 关键节点与约束

## 验证方式

## 已知缺口与待核验项

## 关联模块

`backend.infrastructure.runtime-data-security`、`shared.business.conversation-contracts`,`shared.infrastructure.database-environment`。

## 变更记录

定义八域归属、跨域边界、RLS/grant，以及日期命名、账本治理和 `psql` 单文件迁移纪律。
