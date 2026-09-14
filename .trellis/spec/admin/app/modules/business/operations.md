---
module_id: admin.business.operations
title: 配置、内容与增长运营
scope: admin
category: business
status: active
owners: [admin]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 配置、内容与增长运营

## 职责与边界

管理模型/运行配置、角色卡、公告、邀请规则和回访赠送。

## 当前状态

主要运营页面已集中在 Admin SPA。

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
