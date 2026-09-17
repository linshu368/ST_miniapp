---
module_id: shared.business.character-lobby-contracts
title: 角色、大厅与收藏契约
scope: shared
category: business
status: active
owners: [shared]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 角色、大厅与收藏契约

## 职责与边界

定义角色卡展示、收藏、置顶、精选和排序参数的跨包形状。

## 当前状态

Backend、Frontend 与 Admin 共同消费。

## 入口与调用者

由 shared 根出口导出。

## 涉及文件

| 路径                                              | 职责     |
| ------------------------------------------------- | -------- |
| `packages/shared/src/api/characters.ts`           | 角色 DTO |
| `packages/shared/src/api/favorites.ts`            | 收藏 DTO |
| `packages/shared/src/api/lobby-ranking-params.ts` | 排序参数 |

## 关键实现链路

Zod/DTO → Backend route → Frontend/Admin consumer。

## 数据、契约与外部依赖

无 I/O，不导出数据库行。

## 关键节点与约束

排序枚举和分页字段变更必须兼容现有消费者。

## 验证方式

Shared tests 与所有消费者 typecheck。

## 已知缺口与待核验项

新增展示字段需先确认 browser-safe。

## 关联模块

`backend.business.character-lobby`、`frontend.business.character-lobby`。
