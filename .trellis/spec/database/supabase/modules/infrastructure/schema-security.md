---
module_id: database.infrastructure.schema-security
title: Schema、RLS 与迁移执行基建
scope: database
category: infrastructure
status: active
owners: [database]
last_verified_task: .trellis/tasks/10-10-image-plaza-v2/
last_verified_at: 2026-10-13
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

## 图片创作广场 V2（2026-10-12）

图片广场对象按 experience、miniapp_features、billing、app_core 四域归属；表启用 RLS 并撤销浏览器角色权限，SECURITY DEFINER RPC 固定 `search_path` 且只授权 service_role/postgres。Storage bucket 保持私有；Admin 发布链扩展深层 JSON 校验。迁移仍需在明确 test 目标后单文件人工执行并验证。

`20261013_image_plaza_seed_catalog.sql` 提供 `experience.import_image_plaza_seed_work` SECURITY DEFINER RPC，固定 `search_path`，撤销 public/anon/authenticated 并仅授予 service_role/postgres；导入以来源 ID advisory transaction lock 保证幂等并检测漂移。`20261013_image_plaza_seed_large_assets.sql` 前向同步 RPC、artifact CHECK 与私有 bucket 的 50 MiB seed 容量；三份 migration 的 SQL、权限/RLS、幂等和容量 shape 已在 test 项目验证，production 仍需独立发布确认。

## 变更记录

- 2026-10-13：任务 `10-10-image-plaza-v2` 记录种子导入 RPC 的权限和幂等边界。

定义八域归属、跨域边界、RLS/grant，以及日期命名、账本治理和 `psql` 单文件迁移纪律。
