---
module_id: admin.infrastructure.admin-client-auth
title: Admin API、鉴权与环境基建
scope: admin
category: infrastructure
status: active
owners: [admin]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# Admin API、鉴权与环境基建

## 职责与边界

提供 Supabase 会话、环境选择、统一 API helper、UI 状态和构建配置。

## 当前状态

test/prod 配置隔离，Browser 只使用公开 anon 配置。

## 入口与调用者

Admin 所有业务页面复用。

## 涉及文件

| 路径                                          | 职责         |
| --------------------------------------------- | ------------ |
| `packages/admin/src/components/LoginPage.tsx` | 登录入口     |
| `packages/admin/src/lib/adminApi.ts`          | API helper   |
| `packages/admin/src/lib/adminNavigation.ts`   | 导航公共逻辑 |

## 关键实现链路

选择环境 → Supabase session → API helper 附带身份 → 统一错误/UI。

## 数据、契约与外部依赖

依赖 Vite、Ant Design、Refine、Supabase JS。

## 关键节点与约束

生产操作必须显式确认；VITE 变量均视为公开。

## 验证方式

Admin test/typecheck/build。

## 已知缺口与待核验项

不同部署 Root Directory 对配置文件选择需持续核对。

## 关联模块

`backend.infrastructure.runtime-data-security`。
