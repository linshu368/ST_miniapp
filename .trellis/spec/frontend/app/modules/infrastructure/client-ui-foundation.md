---
module_id: frontend.infrastructure.client-ui-foundation
title: API、Telegram 与 UI 基建
scope: frontend
category: infrastructure
status: active
owners: [frontend]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# API、Telegram 与 UI 基建

## 职责与边界

提供统一 REST client、Query provider、Telegram runtime、Zustand 状态和通用 UI。

## 当前状态

API 与 server state 已集中，Tailwind/shadcn 作为 UI 基础。

## 入口与调用者

所有 Frontend 页面和业务组件使用。

## 涉及文件

| 路径                                      | 职责             |
| ----------------------------------------- | ---------------- |
| `packages/frontend/src/lib/api/client.ts` | REST client      |
| `packages/frontend/src/lib/api/`          | Query hooks      |
| `packages/frontend/src/components/ui/`    | 公共 UI          |
| `packages/frontend/src/stores/`           | 跨组件客户端状态 |

## 关键实现链路

Provider 初始化 → Telegram 上下文 → query/client → 通用 loading/error/UI。

## 数据、契约与外部依赖

依赖 Telegram SDK、React Query、Zustand 与 shared DTO。

## 关键节点与约束

浏览器公开变量不存 secret；server state 不复制到 Zustand。

## 验证方式

Frontend typecheck、test、build 与真机检查。

## 已知缺口与待核验项

Telegram WebView 差异需持续人工回归。

## 关联模块

`backend.infrastructure.runtime-data-security`。
