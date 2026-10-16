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

主表清退需四类证据与独立授权，三文件按 catch-up→view→DROP，事务/5s lock/60s statement/RESTRICT；视图保留 owner/ACL/invoker，原 reader 仅补 OpenRouter 所需列权限。未知旧 JSON、未保全事实或历史结算阻断；新专表调用不为历史清退被中断。无表重写/空间回收承诺，删列后旧 Backend 不可直接回退。

## 关联模块

`backend.infrastructure.runtime-data-security`、`shared.business.conversation-contracts`,`shared.infrastructure.database-environment`。

## 变更记录

定义八域归属、跨域边界、RLS/grant，以及日期命名、账本治理和 `psql` 单文件迁移纪律。

## T9 专表旧别名清理（本地实现，远端未执行）

新增独立 `20261016_openrouter_chat_history_drop_legacy_aliases.sql`：删除11个重复别名，保留canonical原名列、llm_generation_id/data及UNIQUE/FK/ACL；仅填NULL原名安全字段、非空冲突/未知依赖/超过2000候选拒绝。显式删除8个旧别名CHECK，canonical CHECK保留。不把待回捞metadata空值判为失败，不改父行业务事实或Venice。可先清专表，主表DROP仍有独立历史JSON/结算和运行门禁；不搬raw JSON、不伪造结算。PG17/PostgREST双处真实删列回归见任务T9报告；真实环境覆盖与所有旧writer退出仍需独立验收。
