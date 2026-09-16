---
module_id: database.infrastructure.schema-security
title: Schema、RLS 与迁移执行基建
scope: database
category: infrastructure
status: active
owners: [database]
last_verified_task: .trellis/tasks/09-11-batch-lab-postprocessing/
last_verified_at: 2026-09-16
---

# Schema、RLS 与迁移执行基建

## 职责与边界

定义八域归属、跨域边界、RLS/grant、日期命名、账本治理和 `psql` 单文件迁移纪律。生产迁移必须测试优先、人工执行并记录 shape、权限、容量与回滚。

## 当前状态

一阶段 schema 划分已生产落地，miniapp 空壳仍待收口。Batch Lab 使用独立内部调试域 `batch_lab`；`110_batch_lab_samples.sql` 管理样本 preview、冻结样本集、source reader/login 和 PostgREST service-role 访问边界。新增 `20260916_batch_lab_postprocessing.sql` 管理不可变 processor_versions、display_results、默认 none/v1 版本、RLS/ACL 和禁止 UPDATE/DELETE 的 trigger。真实业务域不得依赖 `batch_lab`。

## 入口与调用者

所有新增表、函数、repository 和生产迁移任务遵守本模块。Batch Lab 由 backend service-role 写 `batch_lab`，来源读取使用专用只读 PostgreSQL 登录角色。

## 涉及文件

| 路径                                                               | 职责                                         |
| ------------------------------------------------------------------ | -------------------------------------------- |
| `packages/shared/migrations/`                                      | migration 唯一来源                           |
| `packages/shared/migrations/110_batch_lab_samples.sql`             | Batch Lab 样本域与只读授权                   |
| `packages/shared/migrations/20260916_batch_lab_postprocessing.sql` | Batch Lab processor/display 存储与不可变约束 |
| `ops/batch-lab/README.md`                                          | Batch Lab 暴露/回滚/LOGIN 顺序               |
| `docs/ARCHITECTURE.md`                                             | 现行域归属说明                               |
| `.github/workflows/db-migrate.yml`                                 | 手工执行入口                                 |

## 关键实现链路

声明 domain -> test 账本查重/`psql` 单文件执行 -> shape/RLS/关键读写验证 -> 成功记账 -> production 人工确认。Batch Lab 迁移先创建 deny-by-default 的 `batch_lab` 表/RPC，再单独人工暴露 PostgREST schema；来源 LOGIN/secret 与真实连接验证必须独立授权，不随 migration 自动开启。

## 数据、契约与外部依赖

Supabase PostgreSQL/PostgREST/Auth/Storage。Batch Lab 平台写入使用 service-role 访问 `batch_lab`；来源读取使用专用 PostgreSQL 只读角色访问必要业务表。Display result 保存的是展示用安全 HTML 和原文/输出文本，不回写真实业务域，也不进入生成上下文。

## 关键节点与约束

禁止平行 migration 源；新文件必须日期命名。生产先测试并记录锁、容量、账本状态和回滚。Batch Lab 表启用 RLS 并撤销 anon/authenticated；processor_versions 与 display_results 通过 trigger 阻止 UPDATE/DELETE；display_results 的 success/error shape、renderer protocol/version、输入输出长度和 digest 由数据库约束兜底。来源角色必须 NOLOGIN 直到人工设置 secret，并保持 read-only、5s statement timeout、500ms lock timeout。

## 验证方式

Database spec checklist、实库只读结构采集和应用层回归。Batch Lab 需验证 SQL 拒写、只读角色负测、preview/freeze 原子性、processor/display 不可变、RLS/ACL、幂等冲突和回滚事务。

## 已知缺口与待核验项

`pnpm lint:migrations` 当前仍因已执行旧文件 `110_batch_lab_samples.sql` 的三位数字命名失败；本任务新增 migration 已使用日期命名。Postprocessing migration 尚需人工在 test/production 单文件执行并完成文件尾部 post-apply 验证，不得用离线测试替代实库状态。

## 关联模块

`backend.infrastructure.runtime-data-security`、`shared.business.conversation-contracts`。

## 变更记录

- 2026-09-16：任务 `Batch Lab 后处理与富文本渲染`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-postprocessing/`）更新模块知识文档；commit：`1f41de3952d8b4bad42ea59fb4a439d08d2cab26`。
