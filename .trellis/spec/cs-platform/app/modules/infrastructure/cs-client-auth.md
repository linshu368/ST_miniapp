---
module_id: cs-platform.infrastructure.cs-client-auth
title: CS API、鉴权与环境基建
scope: cs-platform
category: infrastructure
status: active
owners: [cs-platform]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# CS API、鉴权与环境基建

## 职责与边界

提供统一 API client、React Query、管理员 header、环境选择和 SPA 部署基础。

## 当前状态

CS 平台独立 Vite 构建，通过 HTTP 与 Backend 通信。

## 入口与调用者

所有 CS 页面和业务 hooks 使用。

## 涉及文件

| 路径                                | 职责                |
| ----------------------------------- | ------------------- |
| `packages/cs-platform/src/api.ts`   | API 与公共 helper   |
| `packages/cs-platform/src/main.tsx` | Query/provider 装配 |
| `packages/cs-platform/vercel.json`  | SPA rewrite         |

## 关键实现链路

环境配置 → API client/header → Query 缓存 → 页面状态。

## 数据、契约与外部依赖

依赖 React Query、Vite 和 shared DTO。

## 关键节点与约束

query key 必须含环境；浏览器配置不存放 service secret。

## 验证方式

CS typecheck/build 与人工环境切换验证。

## 已知缺口与待核验项

缺少 `.env.example` 和自动测试 script。

## 关联模块

`backend.infrastructure.runtime-data-security`。
