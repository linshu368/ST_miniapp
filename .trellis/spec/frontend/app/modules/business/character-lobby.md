---
module_id: frontend.business.character-lobby
title: 大厅角色发现与收藏
scope: frontend
category: business
status: active
owners: [frontend]
last_verified_task: .trellis/tasks/09-20-lobby-list-position-restore-plan/
last_verified_at: 2026-09-29
---

# 大厅角色发现与收藏

## 职责与边界

展示角色大厅、详情、推荐顺序、最新标记和收藏交互。

## 当前状态

大厅主入口和收藏状态已通过 React Query 接入 Backend。从大厅角色卡进入聊天前会记录一次同文档短生命周期返回快照，返回大厅时恢复排序、搜索词、已渲染角色 ID 顺序摘要、锚点卡和滚动位置；快照读入大厅组件 state 后立即清理共享存储，后续恢复只使用本次挂载持有的副本。收藏状态仍只读取 React Query/favorite cache。

## 入口与调用者

用户从主导航大厅进入、打开角色详情并跳转会话；聊天页挂载后预取大厅路由，聊天顶部返回和 Telegram BackButton 返回大厅时复用同一返回语义，系统 history 返回由进入前快照恢复现场。主导航主动点击大厅会清除旧快照，不触发恢复。

## 涉及文件

| 路径                                                     | 职责                         |
| -------------------------------------------------------- | ---------------------------- |
| `packages/frontend/src/app/(main)/page.tsx`              | 大厅页面                     |
| `packages/frontend/src/components/characters/`           | 大厅卡片、详情与返回快照接线 |
| `packages/frontend/src/components/chat/chat-top-bar.tsx` | 聊天顶部返回大厅入口         |
| `packages/frontend/src/components/nav/bottom-nav.tsx`    | 主导航大厅主动入口           |
| `packages/frontend/src/lib/api/characters.ts`            | 角色 query                   |
| `packages/frontend/src/lib/api/favorites.ts`             | 收藏 query/mutation          |
| `packages/frontend/src/lib/lobby-return.ts`              | 大厅返回快照 helper          |

## 关键实现链路

页面参数 → lobby/character query → 卡片渲染 → 进入聊天前写入一次性返回快照 → 聊天页预取 `/` → 聊天返回大厅 → Gallery 初始条件读取快照并立即清理共享存储、跳过一次强制 mount refetch → layout effect 以锚点/邻卡/scrollY 恢复 → 结束恢复态。收藏 mutation 与缓存失效仍走 favorites 现有链路。

## 数据、契约与外部依赖

消费 shared 角色/收藏契约与 Backend。

## 关键节点与约束

组件不得直接 fetch；空态、错误重试和图片降级需明确。返回快照只能保存 UI 条件、角色 ID 顺序摘要和定位标量，不保存完整角色 DTO、收藏状态、initData、token 或聊天正文；快照损坏、过期、刷新后 document token 不匹配或 sessionStorage 不可用时安全降级。

## 验证方式

`pnpm --filter @miniapp/frontend typecheck && pnpm --filter @miniapp/frontend test && pnpm --filter @miniapp/frontend lint && pnpm --filter @miniapp/frontend build`；人工 smoke 需覆盖推荐/最新/搜索、顶部返回/Telegram 返回/history 返回、锚点下架兜底与主导航主动进大厅不恢复。

## 已知缺口与待核验项

真实数据排序观感需上线环境观察。大厅当前仍非分页接口；返回快照保存已加载 ID 摘要以便后续 infinite query 分支复用，但本模块未新增后端分页。

## 关联模块

`backend.business.character-lobby`、`shared.business.character-lobby-contracts`。
