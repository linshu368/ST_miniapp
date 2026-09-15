# T4 PostHog SDK 官方 API 核验

核验时间：2026-09-15  
核验对象：`posthog-js@1.433.4`（npm latest 当时为 1.433.4）+ PostHog 当前公开文档。  
未猜过期 API。未访问 PostHog 项目控制台；100% 采样与 **30 天**保留（当前 Free 套餐上限）的项目级互证仍属 T7。不得把 60 天写成当前能力。

## 版本

- 安装并锁定：`posthog-js@1.433.4`（`packages/frontend/package.json` 精确版本 + lockfile）。
- 来源：`https://registry.npmjs.org/posthog-js/latest`。
- 未引入 `@posthog/react`、第三个 replay SDK 或全局 analytics 框架。

## Next.js / Telegram WebView

- 本仓库是 **Next.js 14 App Router**。官方 Next Session Replay 安装文档把 `instrumentation-client.ts` 标为 **Next.js 15.3+**；14 的推荐路径是 `'use client'` Provider + `useEffect` 初始化。
- 现有 `instrumentation-client.ts` 只服务 Sentry，T4 **不**把 PostHog 放进去（也避免改 Sentry Replay 配置）。
- `defaults: '2026-05-30'` 已含 `external_scripts_inject_target: 'head'`，用于避免 Next SSR hydration 被 SDK 改 DOM。不使用 `'2026-06-25'` 及之后的 snapshot，因为那些默认打开 `streamNetworkBody` / `captureJsonLd`。
- Telegram Mini App 跑在移动 WebView 里，`posthog-js` 是浏览器 SDK。Recorder 会从 `*.posthog.com` / `*-assets.i.posthog.com` 懒加载；WebView 拦截、localStorage 失败或初始化抛错时 adapter no-op，不阻断 Telegram/Sentry。

## 手动录制 API（web vs 移动端）

当前官方「How to control which sessions you record」把平台页签并列，容易误读：

| 平台                         | 开始新段                                                                                                         | 停止                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **Web `posthog-js`**         | `startSessionRecording(true)` 或 `{ sampling, linked_flag, url_trigger, event_trigger }`，覆盖 ingestion control | `stopSessionRecording()` |
| iOS / Android / RN / Flutter | `startSessionRecording(false)` 表示 **resumeCurrent=false，开始新 session**                                      | `stopSessionRecording()` |

`posthog-js@1.433.4` 类型为：

```ts
startSessionRecording(override?: {
  sampling?: boolean;
  linked_flag?: boolean;
  url_trigger?: true;
  event_trigger?: true;
} | true): void
```

在 web 上传入 `false` **不能编译**；运行时也只是 `disable_session_recording: false`，**不会**轮转 `$session_id`。

因此 adapter 的「开始新回放段」实现为：若已在录则 `stopSessionRecording()`，再 `startSessionRecording({ sampling: true, linked_flag: true, url_trigger: true, event_trigger: true })`，以满足 T1 的 100% 手动录制、不被 sampling/flag/URL/event trigger 丢掉。逻辑段仍以 `replay_context_id` 关联；不调用会丢掉 identity 的 `reset()`。

无参 `startSessionRecording()` 仍遵守项目 ingestion control，本期不用。

## Browser-side masking

官方 Privacy 文档（web）：

- 默认 `maskAllInputs: true`；`ph-no-capture` 是 `blockClass`，元素在回放中被占位块替换。
- `ph-mask` 是默认 `maskTextClass`；`maskTextSelector` / `maskInputFn` / `maskTextFn` 做选择器或函数级屏蔽。
- `ph-no-mask` 是 **iOS/Android/RN** 的解除屏蔽标识，**不是** web API。聊天区可见性用 `maskInputFn` + `.ph-chat-replay-visible` 实现。
- 页面 URL / 网络条目用 `maskCapturedNetworkRequestFn` 在浏览器内脱敏。
- 关闭 body/header：`recordBody: false`、`recordHeaders: false`、`streamNetworkBody: false`。
- Console body：不设 `enable_recording_console_log: true`（官方默认不采集；显式 `false` 避免远程配置打开）。

`sanitizeTelemetry` 只用于 Sentry/log，不能替代上述 DOM 屏蔽。

## 配置与降级

- 公开变量：`NEXT_PUBLIC_POSTHOG_KEY`、`NEXT_PUBLIC_POSTHOG_HOST`（HTTPS）。不是 secret。
- 缺配置、非 HTTPS host、SDK `init`/`start`/`stop`/`capture` 失败 → adapter no-op + 无内容健康码。
- 现有 Sentry Replay（`maskAllText: false`、100% 采样）未改。

## 参考

- https://posthog.com/docs/session-replay/how-to-control-which-sessions-you-record
- https://posthog.com/docs/session-replay/privacy
- https://posthog.com/docs/session-replay/installation/nextjs
- https://posthog.com/docs/session-replay/network-recording
- https://posthog.com/docs/session-replay/console-log-recording
- https://posthog.com/docs/libraries/js/config
- https://posthog.com/docs/libraries/js
