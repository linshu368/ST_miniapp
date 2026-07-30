# Sentry 接入实现方案 Base

前置需求说明：[docs/Sentry接入需求说明.md](docs/Sentry接入需求说明.md)

## 范围与已确认决策

- 仅覆盖浏览器端，不接入 Next.js Server、Edge 或 Fastify 后端 Sentry。
- 环境为 `production` 和 `development`；dev 分支前端通过 Vercel Development 部署。
- 使用 Telegram ID 作为 Sentry User ID。
- 核心 SDK 尽早同步初始化，Session Replay 在首个客户端 effect 中动态加载。
- Replay、Tracing 初始采样率均为 100%，Replay 保持 `maskAllText: false`、`blockAllMedia: false`。
- 现有 iframe 性能上报与 Sentry 自定义 Span 首版双写。
- 本轮不实现 eruda，不改造 Fastify Pino 日志体系。

## 1. 依赖、环境和发布标识

- 在 [packages/frontend/package.json](packages/frontend/package.json) 引入最新且兼容 Next.js 14 的 `@sentry/nextjs`，同步更新 `pnpm-lock.yaml`。
- 增加浏览器配置：`NEXT_PUBLIC_SENTRY_DSN`、`NEXT_PUBLIC_SENTRY_ENVIRONMENT`；DSN 缺失或环境值非法时禁用上报。
- 增加构建配置：`SENTRY_ORG`、`SENTRY_PROJECT`、`SENTRY_AUTH_TOKEN`、`SENTRY_RELEASE`。Token 仅保存在 Vercel，不进入浏览器产物。
- production 和 development 分别在 Vercel 对应环境配置 `production`、`development`；release 统一使用 Git Commit SHA。
- 更新 [ops/env/vercel.env.production.example](ops/env/vercel.env.production.example)，并补充 Vercel Development 配置说明。

## 2. 浏览器端初始化与错误捕获

- 新增 [packages/frontend/src/instrumentation-client.ts](packages/frontend/src/instrumentation-client.ts)，初始化 Error、Breadcrumb、BrowserTracing 和 Sentry Logs，不静态加载 Replay。
- 配置 `tracesSampleRate: 1.0`、`replaysSessionSampleRate: 1.0`、`replaysOnErrorSampleRate: 1.0`、`enableLogs: true`、environment 和 release。
- 新增 [packages/frontend/src/app/global-error.tsx](packages/frontend/src/app/global-error.tsx)，捕获并上报 App Router 根组件错误，同时提供最小错误回退界面。
- 使用 SDK 默认能力采集页面加载、路由切换、Fetch 请求、运行时错误及未处理 Promise；不对请求层进行重复 Trace 封装。

## 3. 数据清理

- 新增 [packages/frontend/src/lib/sentry/sanitize.ts](packages/frontend/src/lib/sentry/sanitize.ts)，供 `beforeSend`、`beforeBreadcrumb` 和结构化 Log 共用。
- 针对性清理 `X-Init-Data`、Authorization、Cookie、Token、Secret、`tgWebAppData` 等认证字段或 URL 参数，不遮罩正常对话内容。
- 修改 [packages/frontend/src/app/providers.tsx](packages/frontend/src/app/providers.tsx)，移除完整 `rawInitData` Console 输出，改为不含原文的状态信息。
- 为清理逻辑增加单元测试，覆盖大小写、嵌套对象、URL 查询参数和原对象不被意外修改。

## 4. Replay 动态加载与用户关联

- 新增 [packages/frontend/src/lib/sentry/client.ts](packages/frontend/src/lib/sentry/client.ts)，集中提供 Replay 动态加载、用户设置和结构化日志入口。
- 在 [packages/frontend/src/app/providers.tsx](packages/frontend/src/app/providers.tsx) 的首次 effect 中完成 Telegram SDK 初始化后：
  1. 从现有 initData 解析 Telegram ID；
  2. 调用 `Sentry.setUser({ id: String(telegramUserId) })`；
  3. 立即触发 Replay 动态导入，但不等待、不阻塞页面渲染。
- Replay 加载使用模块级 Promise 防止重复加载；失败仅上报 warning，不影响应用。
- 接受动态加载窗口限制：极早错误仍有 Error Event，但 Replay 集成完成前可能没有对应回放。

## 5. 结构化 Log 与日志边界

- 保留 Console Breadcrumb，不将所有 Console 自动转成 Sentry Log。
- 仅主动发送关键事件：Replay 加载失败、Telegram 用户上下文失败、Bridge 启动致命错误、`gate_stall`、`select_stall`、角色切换失败及关键恢复结果。
- 结构化属性限定为稳定事件名、Telegram ID、characterId、requestId、Bridge 状态、结果、environment 和 release，不上传对话正文或认证数据。
- [packages/frontend/src/lib/logger.ts](packages/frontend/src/lib/logger.ts) 继续作为本地 Console 门面；Sentry Logger 通过独立适配器调用，避免将现有日志无差别远程化。

## 6. 自定义性能 Span 与双写

- 新增 [packages/frontend/src/lib/sentry/bridge-telemetry.ts](packages/frontend/src/lib/sentry/bridge-telemetry.ts)，维护跨异步回调的 inactive spans，并保证异常路径也能结束 span。
- 首批 Span：
  - `bridge.boot`：`bridge_start` 至 `st_ready` 或 `boot_fatal`。
  - `tavern.open`：`page_mount` 至 `chat_ready` 或 `select_error`。
  - `tavern.ensure_character`：`ensure_start` 至 `ensure_end`。
  - `tavern.select_character`：`select_start` 至 `select_end` 或 `select_error`。
- 在 [packages/frontend/src/lib/bridge/bridge-client.ts](packages/frontend/src/lib/bridge/bridge-client.ts)、[packages/frontend/src/components/bridge/st-iframe.tsx](packages/frontend/src/components/bridge/st-iframe.tsx) 和 [packages/frontend/src/app/tavern/[characterId]/page.tsx](packages/frontend/src/app/tavern/[characterId]/page.tsx) 接入 Span 与关键 Log。
- 保留 [packages/frontend/src/lib/bridge/iframe-timing.ts](packages/frontend/src/lib/bridge/iframe-timing.ts) 及现有 debug POST；待真机数据对照完成后再单独决定移除。

## 7. Source Map

- 修改 [packages/frontend/next.config.mjs](packages/frontend/next.config.mjs)，在不改变现有 rewrites、standalone 和 webpack alias 的前提下使用 `withSentryConfig` 包装配置。
- production 与 Vercel Development 的 `next build` 均上传 Source Map，并确保上传 release 与浏览器事件 release 一致。
- 客户端 Source Map 上传成功后删除，不作为公开静态资源部署。
- 没有 `SENTRY_AUTH_TOKEN` 的本地和普通 PR CI 构建继续成功，但明确跳过上传；Vercel 部署必须配置 Token。

## 8. 前后端日志关联

- Fastify Pino 保持现状，继续负责 reqId、业务分支、数据库和上游调用原因。
- Sentry 负责客户端 Error、Replay、Trace、Breadcrumb 和关键结构化 Log。
- 在 [packages/frontend/src/lib/api/client.ts](packages/frontend/src/lib/api/client.ts) 复用后端支持的 `X-Request-Id`：请求失败时将 requestId 加入 Breadcrumb 或结构化 Log，便于从 Sentry 跳转到 Railway Pino 查询；不重复创建 Fetch Span。

## 9. 验证与交付

- 接入前记录 `next build` 输出和关键路由 First Load JS；接入后对比核心 SDK及 Replay 动态 chunk，确认 Replay 未进入首包且首屏无明显退化。
- 执行 frontend typecheck、lint、tests 和 production build；验证无 Sentry 凭证时构建仍可通过。
- 在 development 验证 Error、未处理 Promise、结构化 Log、Telegram ID、environment、release、Fetch Trace、自定义 Span 和 Source Map。
- 在真机 Telegram WebView 验证 Replay 能记录父页面及同源 SillyTavern iframe 中的输入、模型输出和操作；若 iframe 内容缺失，优先核对同源、CSP、静态资源 CORS 和 Sentry iframe 限制，不通过全局屏蔽 iframe 绕过验收。
- 在 production 主动触发测试错误，确认源码行列、对应 Replay 及用户关联。
- 最后在 Sentry 后台配置 First Seen Error Alert 和飞书/TG Webhook；上线后观察 100% Replay/Trace 的额度和性能，再决定降采样或升级套餐。

## 主要风险与控制

- Replay 动态加载会留下极短的无回放窗口；通过核心 SDK同步初始化保证错误本身仍可上报。
- 100% Replay/Trace 可能快速消耗额度；采样率集中配置，首轮按需求不下调。
- Replay 对同源 iframe、CSP 和资源 CORS 有兼容要求；必须以真机 Telegram 验收结果为准。
- Source Map 成功依赖 Vercel 构建环境中的 org、project、Token 和 release 配置；部署前需完成 Sentry 项目侧准备。
