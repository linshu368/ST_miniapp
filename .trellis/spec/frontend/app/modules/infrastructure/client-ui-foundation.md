---
module_id: frontend.infrastructure.client-ui-foundation
title: API、Telegram 与 UI 基建
scope: frontend
category: infrastructure
status: active
owners: [frontend]
last_verified_task: .trellis/tasks/11-03-five-route-navigation-p95/
last_verified_at: 2026-11-04
---

# API、Telegram 与 UI 基建

## 职责与边界

提供统一 REST client、Query provider、Telegram runtime、Zustand 状态、通用 UI。不拥有业务生成或支付结算。

## 当前状态

API 与 server state 已集中，Tailwind/shadcn 作为 UI 基础。GET 传输失败由统一 API client 最多重试一次，React Query 不再叠加默认重试；queryFn 必须把 React Query 的 `AbortSignal` 传到底层请求，排队、退避与在途阶段的主动取消均不得再发请求。

默认关闭且非首屏必需的重型面板可用动态导入，并在首次打开后保持挂载以保留关闭动画和局部草稿；消息正文、输入框、播放器地址等关键路径不得为追求 bundle 数字而延后。

五个一级路由 `/`、`/dramas`、`/characters`、`/creation`、`/profile` 统一复用真实 Link intent 到 `usePageReady` 的 `page.navigation` 计时。成功样本带有限 `readiness_budget=within_2s|over_2s`；失败、离页和停滞仍由 terminal/stall 事件单独观察，不能只看 ready 幸存样本。BottomNav 在入口关键工作结束后按 Android/iOS 优先级串行预热最多两个 route chunk；只有明确 hover/focus/touch intent 才预取 characters、favorites 或 wallet 主 query，短剧目录不在导航 intent 预取，避免与剧场增量列表挂载竞态。

## 入口与调用者

所有 Frontend 页面和业务组件使用。

## 涉及文件

| 路径                                            | 职责                        |
| ----------------------------------------------- | --------------------------- |
| `packages/frontend/src/lib/api/client.ts`       | REST client、有限重试与取消 |
| `packages/frontend/src/lib/api/query-client.ts` | React Query 默认策略        |
| `packages/frontend/src/lib/api/`                | Query hooks                 |
| `packages/frontend/src/components/ui/`          | 公共 UI                     |
| `packages/frontend/src/stores/`                 | 跨组件客户端状态            |

## 关键实现链路

Provider 初始化 → Telegram 上下文 → query/client → 通用 loading/error/UI。读请求失败只由 API client 判定是否安全重试；调用方取消沿同一 signal 立即终止请求槽、退避与 fetch。

## 数据、契约与外部依赖

依赖 Telegram SDK、React Query、Zustand、shared DTO。浏览器公开变量不存 secret。

## 关键节点与约束

浏览器公开变量必须静态读取 `NEXT_PUBLIC_*`。server state 不复制到 Zustand。事件属性禁止 initData、token、支付 URL、聊天正文、图片 prompt、图片 URL、Storage path 和 provider request id。POST 不自动重试；GET 总尝试次数最多两次，abort 不得转换成普通失败后重试。

## 验证方式

Frontend typecheck、test、lint、build 与真机检查；取消/重试改动需覆盖退避取消和同源代理信号。

## 已知缺口与待核验项

Telegram WebView 差异需持续人工回归；生产 route bundle 与 Sentry 页面 P95 必须发布后复测，本地构建只提供相对体积证据。

## 关联模块

`frontend.business.conversation-ui`、`frontend.business.wallet-payment`、`backend.infrastructure.runtime-data-security`。

## 图片创作广场 V2（2026-10-12）

图片广场的配置、瀑布流、会话、报价、生成、点赞与分享均通过统一 API client 和 React Query 缓存；Studio 隐藏底栏；当前作品详情保留公共导航，其操作条位于导航上方，私有对象只消费后端签发的短期 URL。

## 变更记录

- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）记录图片业务事件复用现有 replay lifecycle 与 shared schema；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）移除已删除的 Mock 与表单脚手架事实并同步当前前端基础设施边界；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。
- 2026-10-29：任务 `Optimize Sentry slow pages and APIs`（`.trellis/tasks/archive/2026-10/10-29-optimize-sentry-slow-pages-apis/`）统一 GET 有限重试与查询取消，并明确可选重型 UI 的按需加载边界；commit：`f73e38a11dcf8556aba669c88dbd401569618cdf`。
- 2026-11-04：任务 `Optimize five-route mobile navigation readiness`（`.trellis/tasks/11-03-five-route-navigation-p95/`）补齐五路由 ready、2 秒预算维度、平台 route chunk 优先级与低风险 intent 预取；生产是否达标仍需发布后按 route/platform 样本验证。

## 五入口公共导航适配（2026-10-27，本地）

BottomNav 在角色/AI短剧/首页/生成/我的统一贴底暖黑五入口，中央播放符号保留，中央使用无底座折叠播放标记，当前栏目用字重/图标轻底托反馈；未读点仍属于我的，角色入口保留最后栏目。BottomNav 导出的 isBottomNavHidden 同时约束 MainLayout 内容留白，避免隐藏底栏后残留空白。globals.css 的 --app-nav-height / --app-nav-space 是高度与安全区来源；短剧固定滚动区、普通入口最小高度、影像作品操作条与提示同步使用。没有更改各闭环业务接口或内部操作。
