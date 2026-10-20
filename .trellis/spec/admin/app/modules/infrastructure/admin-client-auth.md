---
module_id: admin.infrastructure.admin-client-auth
title: Admin API、鉴权与环境基建
scope: admin
category: infrastructure
status: active
owners: [admin]
last_verified_task: .trellis/tasks/10-10-image-plaza-v2/
last_verified_at: 2026-10-12
---

# Admin API、鉴权与环境基建

## 职责与边界

## 当前状态

## 入口与调用者

## 涉及文件

| 路径                                          | 职责               |
| --------------------------------------------- | ------------------ |
| `packages/admin/src/components/LoginPage.tsx` | Admin 登录入口     |
| `packages/admin/src/lib/adminApi.ts`          | Admin API helper   |
| `packages/admin/src/lib/adminNavigation.ts`   | Admin 导航公共逻辑 |

## 关键实现链路

## 数据、契约与外部依赖

## 关键节点与约束

## 验证方式

## 已知缺口与待核验项

## 关联模块

`backend.infrastructure.runtime-data-security`、`shared.infrastructure.database-environment`。

## 图片创作广场 V2（2026-10-12）

图片广场配置页只复用 Admin 既有 session、环境切换与 config draft/publish/rollback helper；浏览器不直接访问数据库、不持有 Venice 密钥，也不新建平行鉴权或 API client。

## 变更记录
