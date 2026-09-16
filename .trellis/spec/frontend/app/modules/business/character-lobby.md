---
module_id: frontend.business.character-lobby
title: 大厅角色发现与收藏
scope: frontend
category: business
status: active
owners: [frontend]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 大厅角色发现与收藏

## 职责与边界

展示角色大厅、详情、推荐顺序、最新标记和收藏交互。

## 当前状态

大厅主入口和收藏状态已通过 React Query 接入 Backend。

## 入口与调用者

用户从主导航大厅进入并跳转会话。

## 涉及文件

| 路径                                          | 职责                |
| --------------------------------------------- | ------------------- |
| `packages/frontend/src/app/(main)/page.tsx`   | 大厅页面            |
| `packages/frontend/src/lib/api/characters.ts` | 角色 query          |
| `packages/frontend/src/lib/api/favorites.ts`  | 收藏 query/mutation |

## 关键实现链路

页面参数 → lobby/character query → 卡片渲染 → 收藏 mutation/缓存失效。

## 数据、契约与外部依赖

消费 shared 角色/收藏契约与 Backend。

## 关键节点与约束

组件不得直接 fetch；空态、错误重试和图片降级需明确。

## 验证方式

Frontend tests/build 与移动端大厅 smoke。

## 已知缺口与待核验项

真实数据排序观感需上线环境观察。

## 关联模块

`backend.business.character-lobby`、`shared.business.character-lobby-contracts`。
