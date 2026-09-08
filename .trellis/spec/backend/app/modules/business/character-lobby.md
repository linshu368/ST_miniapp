---
module_id: backend.business.character-lobby
title: 角色卡、大厅与收藏
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 角色卡、大厅与收藏

## 职责与边界

提供角色列表/详情、最新红点、收藏、运营置顶和推荐排序，不负责聊天执行。

## 当前状态

公开角色发现、用户收藏、排序参数和每日排序分重算已落地。

## 入口与调用者

Frontend 大厅及 Admin 排序配置调用 characters/favorites/lobby API。

## 涉及文件

| 路径                                        | 职责     |
| ------------------------------------------- | -------- |
| `packages/backend/src/routes/characters.ts` | 角色 API |
| `packages/backend/src/routes/favorites.ts`  | 收藏 API |
| `packages/backend/src/features/lobby/`      | 大厅排序 |

## 关键实现链路

请求参数 → 公开/用户鉴权 → 排序与置顶配置 → repository → DTO。

## 数据、契约与外部依赖

依赖 app_core.characters、miniapp_features 收藏/排序表和 shared 角色契约。

## 关键节点与约束

测试卡与发布状态必须过滤；大厅定时重算不依赖 analytics 运行时视图。

## 验证方式

Backend lobby/route tests 与 Frontend 大厅人工回归。

## 已知缺口与待核验项

排序参数调整需观察推荐质量与任务容量。

## 关联模块

`frontend.business.character-lobby`、`shared.business.character-lobby-contracts`。
