---
module_id: admin.business.operations
title: 配置、内容与增长运营
scope: admin
category: business
status: active
owners: [admin]
last_verified_task: .trellis/tasks/10-10-image-plaza-v2/
last_verified_at: 2026-10-12
---

# 配置、内容与增长运营

## 职责与边界

管理模型/运行配置、角色卡、公告、邀请规则和回访赠送。

## 当前状态

主要运营页面已集中在 Admin SPA。图片运营只管理普通图片配置；`image_advanced_*` 与独立 VIP 媒体配置页已删除。VIP 策略仍管理 `feature_free_trial_limits.basic_image`，普通图片免费次数不受影响。

## 入口与调用者

内部运营人员通过 Admin 导航使用。

## 涉及文件

| 路径                                                        | 职责     |
| ----------------------------------------------------------- | -------- |
| `packages/admin/src/components/ModelCatalogEditor.tsx`      | 模型配置 |
| `packages/admin/src/components/CharacterCardsView.tsx`      | 角色卡   |
| `packages/admin/src/components/AnnouncementsView.tsx`       | 公告     |
| `packages/admin/src/components/InviteProgramView.tsx`       | 邀请计划 |
| `packages/admin/src/components/OutreachCreditGrantView.tsx` | 回访赠送 |

## 关键实现链路

登录/环境 → 表单校验 → Admin API/Supabase → 发布或原子写 → 审计结果。

## 数据、契约与外部依赖

依赖 Backend、Supabase session、runtime_config 和 shared 契约。

## 关键节点与约束

发布、赠送、上下架等写操作必须确认、防重复并展示结果。

## 验证方式

Admin test/typecheck/build 与 test 环境人工 smoke。

## 已知缺口与待核验项

生产配置变更需独立人工确认和观察。

## 关联模块

`admin.infrastructure.admin-client-auth`、`backend.infrastructure.runtime-data-security`。

## 图片创作广场 V2（2026-10-12）

Admin 在现有配置草稿、发布、回滚链路中增加图片广场模型目录、首次分享提示与标签管理；模型页包含上架星尘价计算器，但最终发布值仍是服务端权威 credits。配置 schema 同时在 shared 和数据库发布校验器中约束。`image_plaza_tags_feature_enabled` 文案仅描述分享自动打标，不描述广场标签展示。

## 变更记录

- 2026-10-16：标准价改为目录顶层可选 standard_prices 元数据，随草稿保存并回填，公开模型与实际扣费仍仅使用原模型字段/credits；统一参数仍为页面临时值。旧目录无标准价时留空，不反推。

- 2026-10-16：标签编辑采用独立 UI 行标识并保留空值/重复 ID 中间态，保存仍使用 shared 严格校验。模型定价增加本次页面有效的标准价、统一参数、公式预览和批量重算；缺失任一档位标准价时不部分覆盖，只更新 credits 草稿，不持久化计算参数。

- 2026-10-15：任务 `10-15-image-plaza-tag-prompt-filter` 将标签功能开关文案改为仅控制分享自动打标。
- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）删除无法恢复的乱码变更记录；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。
