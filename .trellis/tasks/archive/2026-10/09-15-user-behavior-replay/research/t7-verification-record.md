# T7 验收记录

记录时间：2026-09-15  
分支：`dev_posthog`  
执行人：qj  
状态：**Done（2026-09-16 需求方确认真机通过）/ 生产配置仍禁止启用**

本文不写入真实 PostHog key、token、initData、pay_url。

## 0. 2026-09-15 发布口径（覆盖原「隔离 test 项目」）

需求方确认：

- **没有单独的 test PostHog 项目。** 现有 US Cloud 项目 ID `610481` 将直接用于生产。
- **接受初期开发/Preview 遗留数据** 进入该项目。
- 真机验收改在 **对 `dev` 的 PR + Vercel Preview + Railway `pr-{n}` backend** 进行，而不是本地隔离项目。
- **Vercel / Railway Production 的 PostHog 变量先留空。** Preview 打开录制不等于生产启用。

因此 T7 原停止条件「没有隔离的 test 项目」**不再单独阻断 Preview 验收**。下列停止条件仍然有效，未齐不得打开生产配置：

- 无法证明 Free 套餐下 **30 天到期删除**
- 无法证明 **100% 手动录制**不被 ingestion control 丢掉
- 敏感字段仍能在回放/事件/日志中检索到
- 外部支付无法用 `order_id` 关联打开/回流/服务端终态

## 1. 项目与配置

| 项             | 结果                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostHog 项目   | US Cloud 项目 ID `610481`；Preview 验收与日后生产同一项目                                                                                                                                               |
| 本地 Frontend  | gitignored `packages/frontend/.env.local` 的 `NEXT_PUBLIC_POSTHOG_*`（不入库）                                                                                                                          |
| 本地 Backend   | gitignored `packages/backend/.env` 的 `POSTHOG_API_KEY` / `HOST`（不入库）                                                                                                                              |
| Preview 应注入 | Vercel **Preview**：`NEXT_PUBLIC_POSTHOG_KEY` / `HOST`；Railway **PR/`development` 副本**：`POSTHOG_API_KEY` / `HOST`。`NEXT_PUBLIC_API_URL` 必须指向该 PR 的 `https://stminiapp-pr-{n}.up.railway.app` |
| Production     | **先不注入**；互证与 Preview 真机矩阵通过后再开                                                                                                                                                         |

控制台 URL（无密钥）：

- Replay 设置：`https://us.posthog.com/project/610481/settings/project-replay`
- Billing / 套餐：组织 Billing
- DPA：`https://us.posthog.com/legal`

## 2. I6 自动化（2026-09-15 19:40 +08）

完整日志：`research/t7-i6-automation.log`（`I6_FAILS=0`）

| 命令                                        | 结果                         |
| ------------------------------------------- | ---------------------------- |
| `pnpm --filter @miniapp/shared typecheck`   | pass                         |
| `pnpm --filter @miniapp/shared test`        | 8 files / 56 tests pass      |
| `pnpm --filter @miniapp/backend typecheck`  | pass                         |
| `pnpm --filter @miniapp/backend test`       | 51 files / 435 tests pass    |
| `pnpm --filter @miniapp/frontend typecheck` | pass                         |
| `pnpm --filter @miniapp/frontend test`      | 106 tests pass               |
| `pnpm --filter @miniapp/frontend lint`      | No ESLint warnings or errors |
| `pnpm --filter @miniapp/frontend build`     | pass                         |
| `pnpm -r typecheck`                         | pass                         |
| `pnpm lint:imports`                         | pass                         |

Sentry Replay 源文件本任务未改。

## 3. 项目级互证

官方文档（不能替代项目截图）：

- Free Session Replay 最长 **30 天**（不是 60 天）：https://posthog.com/docs/session-replay/recording-retention
- 项目关闭录制时 `startSessionRecording` 无效：https://posthog.com/docs/session-replay/how-to-control-which-sessions-you-record
- Free 套餐可自助 DPA：https://posthog.com/docs/privacy

API 探测（不打印 key）：

| 探测                                                       | 结果                                                                                                                      | 是否算互证通过                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Capture `POST /i/v0/e/`                                    | HTTP 200                                                                                                                  | 仅证明事件可写入                                                                                                                       |
| 开启前 `sessionRecording`                                  | `false`                                                                                                                   | 当时手动 start 无效                                                                                                                    |
| 需求方打开录制后 `/array/{token}/config` 与 `/decide/?v=3` | `sessionRecording` 为配置对象；`endpoint=/s/`；`sampleRate=null`；`linkedFlag=null`；`urlTriggers=[]`；`eventTriggers=[]` | **部分**：录制已开、无额外 URL/flag/event trigger。`sampleRate=null` 在 PostHog 文档中表示未另配采样（全量），**仍须控制台 100% 截图** |
| 套餐 Free 截图                                             | 无                                                                                                                        | 未通过                                                                                                                                 |
| 保留期 30 天到期删除截图                                   | 需求方声明已设；仓库无图                                                                                                  | 未通过                                                                                                                                 |
| 访问限于产品+工程；含聊天正文的导出/共享/下载同一审批      | 无成员/权限截图                                                                                                           | 未通过                                                                                                                                 |
| 项目级 DPA                                                 | T1 只确认策略                                                                                                             | 未通过                                                                                                                                 |

截图应放入 `research/t7-evidence/`，文件名不含 key。

## 4. 手工验收矩阵（改在 PR Preview / Telegram WebView）

需求方 2026-09-16 确认 Preview 真机矩阵通过（含独立 recording、paywall context、`webview_resume` 回流）。仓库不补含密钥的截图。

- [x] 进入聊天开始新 recording；再进另一个聊天是新段，不与历史合并
- [x] SSE 可见节奏 + Markdown（画面允许正文；事件属性不允许正文）
- [x] 重生成、网络失败、reply-stalled
- [x] 四类 triggerSource：`chat_sse` / `chat_voice` / `custom_voice` / `model_switch`
- [x] 充值、邀请、创单、外部支付拉起、回流有 order ID、回流无 order ID（`/profile/orders?payment=returned`）
- [x] 失败/超时订单；观察窗口内离开（`payment_flow_left_observed`）；expired 不是不可逆失败
- [x] 未回流时仍能按 `order_id` 看到服务端 `payment_order_settled` / `payment_order_failed`
- [x] 同一 paywall 的多段 recording 用 `replay_context_id` + `order_id` + identity 关联
- [x] Telegram WebView、常规移动浏览器、窄屏、软键盘、前后台、外部支付打开/返回、弱网
- [x] 外部收银台不要求画面

静态单测（不能替代 Preview 真机）：

- 缺配置 / 非 HTTPS → adapter no-op
- `startSessionRecording({ sampling, linked_flag, url_trigger, event_trigger })`
- 事件 schema 拒绝 `content` / `pay_url` / initData 类键
- URL/网络录制剥离 query 与 body/header
- 等待页路径不再带 `pay_url`

## 5. 敏感数据搜索

| 通道                        | 本轮                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| PostHog 回放 URL / 事件属性 | 真机抽查最近 60 条未见 `pay_url` / `initData` / `content` / `message` |
| Sentry Replay UI            | 本期未改 Sentry Replay；聊天正文例外已批准，不作为 T7 改造对象        |
| Preview / 应用日志          | 需求方确认敏感字段检索通过；仓库不存放日志原文                        |
| 自动化单测                  | 已覆盖禁止属性与 URL 脱敏                                             |

## 6. 按序发布记录

| 步                             | 环境                                   | 配置                                                                                              | smoke      | 下一步 / 回滚点                                              |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------ |
| shared 契约                    | 本分支                                 | 无密钥                                                                                            | I6 pass    | 随 PR 合并                                                   |
| Backend context + 支付终态     | Railway `pr-{n}`（复制 `development`） | Preview 才加 `POSTHOG_*`；Production 留空                                                         | 待 PR      | 去掉 `POSTHOG_API_KEY` → capture no-op                       |
| Frontend Preview 100% 手动录制 | Vercel Preview                         | Preview 加 `NEXT_PUBLIC_POSTHOG_*`；Telegram WebApp 指向 Preview；API URL 指向 `stminiapp-pr-{n}` | 待真机矩阵 | 去掉公开变量 → adapter no-op                                 |
| 生产配置启用                   | Vercel Production + Railway production | **禁止**，直到 §3 截图 + §4 矩阵 + §5 检索齐                                                      | —          | 同一套变量留空即关；不回滚聊天/订单/结算；不改 Sentry Replay |

关闭应用 **不能** 删除 PostHog 历史；初期 Preview 数据按需求方接受留在项目 `610481`。

## 7. 给 T8 的结论

需求方 2026-09-16 确认 Preview 真机验收通过，T7 关闭。**生产配置仍不允许启用。** T8 只做全量质量检查、spec / module knowledge 与人工提交审阅，不得把 Production PostHog 写成已开。回滚仍是清空托管平台变量，不回滚聊天/订单/结算，不改 Sentry Replay。

## 8. PR-320 真机无 recording（2026-09-15）

部署核对（无密钥）：

| 项                     | 已验证结果                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR                     | [linshu368/ST_miniapp#320](https://github.com/linshu368/ST_miniapp/pull/320) `dev_posthog` → `dev`，HEAD `1ed302b`                                                 |
| Vercel Preview         | `https://st-miniapp-frontend-git-devposthog-3213527545-4308s-projects.vercel.app`，deployment `dpl_9kex8U3W6JAGtJY6r3ZSByriU7u6` / buildId `0BO_2xZ5ONLJGca46J8di` |
| Railway PR backend     | `https://stminiapp-pr-320.up.railway.app`（status: Success）                                                                                                       |
| Vercel Preview 变量    | `NEXT_PUBLIC_POSTHOG_KEY` / `HOST` 已存在且仅 Preview；Production 无这两项（符合先不启用生产）                                                                     |
| 项目 `610481` 远程录制 | `/array/{token}/config` 的 `sessionRecording` 为对象；`endpoint=/s/`；`sampleRate=null`；无 URL/flag/event trigger；`minimumDurationMilliseconds=null`             |

### 根因（已验证）

Preview 客户端 chunk `2610-f01b2d18dc2db2fe.js` 含 adapter 代码（`disable_session_recording`、`startSessionRecording`、`replay_sdk_init_failed`），但 **没有** `https://us.i.posthog.com`，也 **没有** 任何 `phc_` 字面量。

原因：`readPostHogBrowserEnv(env = process.env)` 再读 `env.NEXT_PUBLIC_POSTHOG_*`。Next.js 只内联静态 `process.env.NEXT_PUBLIC_*`，所以即使 Preview 变量已注入，浏览器运行时仍是 `missing_config`，SDK 不 init、不 identify、不请求 `/s/`。这是前端录制问题，与后端支付终态 capture 无关。

本地 `next build`（读取 gitignored `.env.local`）在修复后：客户端 chunk 出现 host + `phc_` 字面量。未把值写入本文。

### 链路对照

| 段                                                   | 结论                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 手机是否打开本次 PR Preview                          | **未验证**。需要对照 Telegram WebApp URL 是否为上面的 Preview host，而不是生产 `st-miniapp-frontend.vercel.app`                |
| 构建时 KEY/HOST 是否有效                             | 平台变量存在；**旧 Preview bundle 未内联**。修复后须等新 deployment                                                            |
| SDK init / identify                                  | 旧 Preview 不会执行（no-op）                                                                                                   |
| 聊天页真实 session ID → `startNewRecording`          | 代码路径存在；旧 Preview 因 adapter disabled 直接 return false                                                                 |
| `sessionRecordingStarted()`                          | 旧代码在调用 `startSessionRecording` 后无条件 return true；修复后改为返回 SDK `sessionRecordingStarted()`                      |
| 远程配置 + `https://us.i.posthog.com/s/`             | 项目侧允许保存；旧 Preview **不会发** 录制请求                                                                                 |
| 事件已写入 vs 回放入库                               | 旧 Preview 连 SDK 事件都不应发出。若 Activity 里也没有 `replay_chat_started`，与 no-op 一致；有事件无 recording 才是另一类问题 |
| `replay_sdk_init_failed` / `replay_recording_failed` | 缺配置时只打本地/Sentry warn（`client` 尚未建立，不会 capture 到 PostHog）                                                     |
| CSP / WebView 拦截                                   | **未验证**（无真机 HAR）。当前根因已足够解释零 recording                                                                       |
| Railway `POSTHOG_API_KEY`                            | **未列出**。只影响服务端支付终态事件，不影响 Session Replay 画面                                                               |

### 最小修复（未宣称上线）

- `config.ts`：静态读取 `process.env.NEXT_PUBLIC_POSTHOG_KEY/HOST`
- `adapter.ts`：`whenReady` / `isRecording`；`startNewRecording` 以 `sessionRecordingStarted()` 为准
- `lifecycle.ts`：开始聊天前等待 SDK；init 完成后若仍在 chat 且未在录则补 start

验证：`pnpm --filter @miniapp/frontend typecheck|test|lint|build` 通过（110 tests）。**须把此修复推到 PR-320 并等新 Vercel Preview 后再真机复测。** Production 变量仍禁止启用。T7 保持 Doing。

## 9. Preview 真机回放已入库后的未达标项（2026-09-15）

已入库：Vercel Preview 一条约 7:52 的真实回放；聊天、流式、付费墙、充值及支付尝试事件可见。隐私事件属性抽查（最近 60 条）未见 `pay_url` / `initData` / `content` / `message`。回放画面、Sentry、应用日志仍未全面验收。

### 9.1 多角色卡共用同一个 `$session_id`

测试窗口内约 10 次 `replay_chat_started` 共用同一 PostHog `$session_id`，回放列表只有一条。

根因：web `posthog-js@1.433.4` 的 `stopSessionRecording()` + `startSessionRecording(overrides)` **不轮转** `$session_id`（T4 原先只排除了 `startSessionRecording(false)`）。

修复：`startNewRecording` 在 start 前调用 `sessionManager.resetSessionId()`，不调用会丢掉 identity 的 `reset()`。

### 9.2 付费墙后 `replay_chat_ended(route_change)` 抢跑

两次 `paywall_triggered` 后，原 `replay_context_id` 在几毫秒内被 `replay_chat_ended(end_reason=route_change)` 结束，并立刻创建新 context。付费墙到充值的关联因此偶发断开。

根因：

1. `startChatReplay` 只在 `state === 'chat'` 且身份相同才复用；`enterPaywallFollowup` 之后聊天页重绑（`selectedModelId` 等）会把 `paywall_followup` 当成新聊天。
2. `enterPaywallFollowup` 原先走队列，occupancy 的 `setTimeout(0)` `endReplay('route_change')` 可能在状态切到 followup 之前看到 `state === 'chat'`。

修复：进入付费墙时同步置 `paywallHold`；同角色重绑保持原 context；`route_change` / `pagehide` 在 hold/followup 期间不结束；回到聊天页再 `reenterChatFromFollowup`，此后离开大厅才结束。

### 9.3 `order_id` 链路

| 观察                                                                                        | 结论                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 订单 A：创单 → `external_payment_open_requested` → `pending` → `payment_flow_left_observed` | 前端离开路径符合设计。`payment_flow_left_observed` 不是失败终态。                                                                                                                                     |
| 订单 B：只有创单、无打开外部支付                                                            | 充值页在 `paymentPromptConfig.enabled` 时先弹「关 VPN」对话框，确认后才 `openCreatedPayment`。关闭弹窗不会发 open 事件。若 9.2 抢跑结束了 context，后续 open 也会被 `hasActiveReplayContext()` 丢掉。 |
| 两笔均无 `payment_return_observed` / `payment_order_settled` / `payment_order_failed`       | 符合「未结算不发服务端终态」。终态只在 `complete` / 创单网关 `markFailed` 成功之后发送。Railway Preview 的 `POSTHOG_API_KEY` 仍须确认，否则结算后也不会入库。                                         |

**须用两张明确记录角色 ID 的卡重新真机录制**，在项目 `610481` 核对：独立回放（不同 `$session_id`）、paywall 的 `replay_context_id` 连续、以及 `order_id` 从创单到 open/回流/服务端终态。本轮自动化：frontend typecheck / test（116） / lint / build 通过。Production 变量仍禁止启用。

## 10. 需求方关闭 T7（2026-09-16）

需求方确认 Preview 真机验收通过，覆盖：

- 不同角色卡独立 recording（`$session_id` 轮转，`sessionManager.resetSessionId()`）
- 付费墙后同一 `replay_context_id` 连续
- Telegram `openLink` 冻结恢复、URL 不变时出现一次 `payment_return_observed(return_source=webview_resume)`，并与 status 事件同一 `order_id`
- pending 不是失败终态；服务端终态仍只在结算/明确失败落库后发送

修复提交：`05ccde3`（独立回放 + paywall hold）、`bb0ee02`（webview resume 回流）。T7 → Done。Production `NEXT_PUBLIC_POSTHOG_*` / `POSTHOG_API_KEY` 仍留空。T8 不得在代码或文档中把生产采集写成已启用。
