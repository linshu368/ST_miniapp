---
module_id: backend.infrastructure.runtime-data-security
title: 运行时、鉴权与数据访问基建
scope: backend
category: infrastructure
status: active
owners: [backend]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 运行时、鉴权与数据访问基建

## 职责与边界

提供配置、Telegram/运营鉴权、域数据库 client、repository、日志和后台任务基座。

## 当前状态

配置与 runtime config 已集中，Supabase 按域访问，服务日志使用 Pino。

## 入口与调用者

Backend routes、features、jobs 统一消费。

## 涉及文件

| 路径                                                | 职责              |
| --------------------------------------------------- | ----------------- |
| `packages/backend/src/platform/config.ts`           | 环境配置解析      |
| `packages/backend/src/platform/runtime-config.ts`   | DB 运行配置入口   |
| `packages/backend/src/middleware/auth.ts`           | Telegram 鉴权     |
| `packages/backend/src/lib/supabase.ts`              | 按域数据库 client |
| `packages/backend/src/infrastructure/repositories/` | 数据访问实现      |

## 关键实现链路

启动解析配置 → route 鉴权 → feature → repository/domain client → Pino 结果摘要。

## 数据、契约与外部依赖

连接 Supabase、Redis/Sentry 等；secret 仅服务端读取。

## 关键节点与约束

外部调用必须超时；日志禁止 token/敏感正文；跨域访问走 RPC/repository/API。

## 验证方式

`pnpm --filter @miniapp/backend typecheck && pnpm --filter @miniapp/backend test`。

## 已知缺口与待核验项

部署控制台遗留资源仍需人工清理。

## 关联模块

`database.infrastructure.schema-security`。
