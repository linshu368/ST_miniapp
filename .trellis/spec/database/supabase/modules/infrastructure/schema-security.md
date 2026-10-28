---
module_id: database.infrastructure.schema-security
title: Schema、RLS 与迁移执行基建
scope: database
category: infrastructure
status: active
owners: [database]
last_verified_task: .trellis/tasks/10-27-media-plaza-schema-move/
last_verified_at: 2026-10-27
---

# Schema、RLS 与迁移执行基建

## 职责与边界

定义九域归属、跨域边界、RLS/grant、日期命名、账本治理和 `psql` 单文件迁移纪律。生产迁移必须测试优先、人工执行并记录 shape、权限、容量与回滚。

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

## 图片创作广场 V2（2026-10-12）

`20261027_media_plaza_schema_move.sql` 执行后，图片广场 8 张运行时表与 3 个 RPC 统一归 `media_plaza`；计费与运行时配置仍分别归 `billing`、`app_core`。表保留 RLS，schema/table/function 撤销浏览器角色权限并只授权 service_role/postgres。迁移不保留旧 schema 兼容入口，必须暂停图片广场流量、执行 M1、暴露已创建的新 schema 并立即部署匹配 Backend；不得提前暴露不存在的 schema。

`20261013_image_plaza_seed_catalog.sql` 初始创建的导入 RPC 会由 M1 移至 `media_plaza.import_image_plaza_seed_work`；其 SECURITY DEFINER、固定 `search_path`、最小权限、来源 ID advisory transaction lock 与漂移检测语义不变。`20261013_image_plaza_seed_large_assets.sql` 的 artifact CHECK 与私有 bucket 50 MiB seed 容量不变。

## 变更记录

- 2026-10-27：任务 `10-27-media-plaza-schema-move` 批准第九域 `media_plaza`，记录无兼容层的 M1/Backend 协调割接与 M1-only 回滚。
- 2026-10-13：任务 `10-10-image-plaza-v2` 记录种子导入 RPC 的权限和幂等边界。

定义九域归属、跨域边界、RLS/grant，以及日期命名、账本治理和 `psql` 单文件迁移纪律。

## T9 专表旧别名清理（本地实现，远端未执行）

新增独立 `20261016_openrouter_chat_history_drop_legacy_aliases.sql`：删除11个重复别名，保留canonical原名列、llm_generation_id/data及UNIQUE/FK/ACL；仅填NULL原名安全字段、非空冲突/未知依赖/超过2000候选拒绝。显式删除8个旧别名CHECK，canonical CHECK保留。不把待回捞metadata空值判为失败，不改父行业务事实或Venice。可先清专表，主表DROP仍有独立历史JSON/结算和运行门禁；不搬raw JSON、不伪造结算。PG17/PostgREST双处真实删列回归见任务T9报告；真实环境覆盖与所有旧writer退出仍需独立验收。

## T10 历史处置（本地实现，未远端执行）

新history_disposition只保全类型化原名调用字段/受控诊断，清父表raw并规范化已有OR诊断；不存未知JSON、自由文本错误或原始归档，Venice/业务/账务不写。LIMIT2001先预算、最多2000、指纹CAS/事务/ID/provider/类型守卫。主表DROP仅在两库未执行证明后修正：以真实snapshot schema账本边界分类旧终态账单/dedup/失败/真实pending，旧pending原样保留不伪造结算；现代未知/漏快照/身份或状态冲突/关联reserved继续阻断。先处置文件成功记账再主表DROP，TEST证据不替代Production；超窗旧账务停止自动回捞、独立核验。

## 2026-10-23 可运营回复风格

20261023_reply_style_options.sql（迁移交付，执行状态见任务验收）新增app_core用户偏好JSONB及校验helper/service_role-only原子更新RPC，seed空正式UI目录。扩展admin managed-key/validator和两表实际CHECK，保留前置名单/验证状态/ACL；无历史重写。事务lock5s/statement60s，repeat不覆盖运营值。测试/生产独立门禁，先迁移再消费者。

## 2026-10-26 轻量经营统计

`20261026_grafana_light_core.sql` 新增 miniapp_analytics.grafana_core_daily 日/型号派生汇总，运行时不依赖。owner-only refresh_grafana_core_day 一次仅处理近14天内的一天，先按 created_at 范围过滤后关联计费/供应商标量，保留实际成本覆盖率、去重每日用户和实际支付/星尘口径。只有一个30分钟 cron 更新今天/昨天，caller statement5s/lock1s/禁并行、事务 advisory lock，失败保留旧快照；读者仅 SELECT 聚合，不能刷新或接触正文。退出11个旧全历史 cron，保留其旧数据对象。生产新 cron 在实测与引导填充前关闭，执行状态见任务10-26-grafana-light-core。
