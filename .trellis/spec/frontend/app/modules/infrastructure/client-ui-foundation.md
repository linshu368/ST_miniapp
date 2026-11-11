---
module_id: frontend.infrastructure.client-ui-foundation
title: API、Telegram 与 UI 基建
scope: frontend
category: infrastructure
status: active
owners: [frontend]
last_verified_task: .trellis/tasks/11-05-optimize-android-navigation-tail/
last_verified_at: 2026-11-06
---

# API、Telegram 与 UI 基建

## 职责与边界

提供统一 REST client、Query provider、Telegram runtime、Zustand 状态、通用 UI。不拥有业务生成或支付结算。

## 当前状态

2026-11-11 本地候选：timedFetch 可选 priority 将请求槽队列纳入同一总截止，默认调用行为不变；显式 abort race 防止响应体卡住后占槽，同步解析延迟 timer 时也检查单调时钟。全局错误边界原址 reload 且沿用失败埋点，不依赖 Router Context；Telegram 原始签名身份从合法启动来源捕获到内存，既有 URL 清理顺序保留。不得新增凭据持久化或自动重放聊天写请求。

API 与 server state 已集中，Tailwind/shadcn 作为 UI 基础。GET 传输失败由统一 API client 最多重试一次，React Query 不再叠加默认重试；queryFn 必须把 React Query 的 `AbortSignal` 传到底层请求，排队、退避与在途阶段的主动取消均不得再发请求。

默认关闭且非首屏必需的重型面板可用动态导入，并在首次打开后保持挂载以保留关闭动画和局部草稿；消息正文、输入框、播放器地址等关键路径不得为追求 bundle 数字而延后。

五个一级路由 `/watch`、`/dramas`、`/characters`、`/creation`、`/profile` 统一复用真实 Link intent 到 `usePageReady` 的 `page.navigation` 计时。成功样本带有限 `readiness_budget=within_2s|over_2s`；失败、离页和停滞仍由 terminal/stall 事件单独观察，不能只看 ready 幸存样本。BottomNav 在入口关键工作结束后按平台优先级串行预热 route chunk：Android/Android X 每轮最多一个，iOS/other 最多两个；短剧目录不在导航 intent 预取，避免与剧场增量列表挂载竞态。

Android/Android X 的有效底栏导航点击到目标 `usePageReady` content ready/failed 之间启用内存级安静窗口；经两次绘制机会与有界 idle 后恢复未读、settings、Profile 次级读取和后台 route 预热，目标未结算时 4 秒强制放行。Characters 主列表与 Profile 钱包等 P0 不受阻塞；Android touch intent 只保留 Characters 主查询预取，iOS/other 沿用 characters、favorites、wallet 的既有 intent 策略。该调度独立于 Sentry/Grafana 开关，不改变 `page.navigation` 起止点。

移动端性能策略同时提供角色目录 deadline：Android/Android X 为 1.8 秒，iOS/other 为 20 秒。该 deadline 覆盖响应体读取并沿 React Query signal 取消，目录请求不额外叠加重试；推荐 POST 保持独立 5 秒有限预算和不自动重试。缓存响应只限明确允许共享的无 selection `latest` 成功结果，不能把个人推荐或错误响应提升为公共缓存。

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
- 2026-11-05：任务 `治理 Android 五入口公共导航长尾`（`.trellis/tasks/11-05-optimize-android-navigation-tail/`）增加 Android SPA 导航安静窗口、4 秒兜底和单 route 后台预热上限；iOS 行为与页面 ready 口径不变，效果需按新 release 生产复测。
- 2026-11-06：同任务第二阶段增加 Android 角色目录 1.8 秒全阶段 deadline、受限公共缓存与 Profile 次级 chunk，仍以发布后同 release 的 P95、2 秒率和 terminal/stall 门禁为准。

## 五入口公共导航适配（2026-10-27，本地）

BottomNav 在角色/AI短剧/首页/生成/我的统一贴底暖黑五入口，中央播放符号保留，中央使用无底座折叠播放标记，当前栏目用字重/图标轻底托反馈；未读点仍属于我的，角色入口保留最后栏目。BottomNav 导出的 isBottomNavHidden 同时约束 MainLayout 内容留白，避免隐藏底栏后残留空白。globals.css 的 --app-nav-height / --app-nav-space 是高度与安全区来源；短剧固定滚动区、普通入口最小高度、影像作品操作条与提示同步使用。没有更改各闭环业务接口或内部操作。
