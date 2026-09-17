# 用户行为回放系统：实施计划

本文件描述经审阅后才可执行的产品代码工作。当前任务仍为 `planning`；不得仅凭此文件运行 `task.py start` 或开始实现。

## 0. 实施前阻塞门禁

- [x] 隐私负责人批准完整聊天正文进入 PostHog Session Replay，且同步批准对 `.trellis/spec/frontend/app/api-dataflow-and-state.md` 的受控例外/更新。书面记录：`research/t1-decision-record.md`。
- [x] 确认 PostHog 区域、最小访问角色、访问审计/删除责任人与到期自动删除**策略**（US Cloud；产品+工程；责任人与隐私责任人同一人）。**当前 Free 套餐最长 30 天**，不得按 60 天验收。项目级 DPA、30 天开关与套餐截图互证放 T7。
- [x] 依据 PostHog 当前官方文档确认 `posthog-js` 版本、Next.js/Telegram WebView 兼容性、手动录制 API 与 browser-side masking。结论：`research/t4-posthog-sdk-record.md`。web 使用 `startSessionRecording` ingestion override，而不是 RN/移动端的 `(false)`。项目级 100% 采样与 **30 天**保留开关互证仍放 T7。
- [x] `user_cohort` 本期跳过（后期精细化检索待办）。T2 不得包含该字段；用户标签仅 `is_paid_user` 与 `total_chat_rounds`。
- [x] 确认 idle 超时为 15 分钟；流式生成与 `external_payment_pending` 不计 idle。
- [x] 2026-09-15 需求方撤回「隔离 test 项目」：无单独 test 项目；US Cloud 项目 `610481` 用于 Preview 真机验收与日后生产，接受初期遗留数据。真实 key 只进 gitignored 本地 env 与托管平台 Preview 变量，不入库。**Production PostHog 变量仍禁止启用**，直到 T7 截图与 Preview 矩阵通过。
- [x] 在 PostHog 项目级验证 Session Replay 采样率为 100%，并确认手动录制不被 ingestion control 丢弃；若不能满足，先修改 PRD，不得自行降采样。开启录制后 decide/`array` config 已返回 recording 对象且 `sampleRate=null`、无 URL/flag/event trigger。需求方 2026-09-16 确认 Preview 真机 recording 与检索矩阵通过；仓库不存放含密钥的控制台截图。
- [x] 在目标项目确认套餐为 Free、Session Replay 保留期为 **30 天**；不得按 60 天验收。升级付费套餐前此项不改为 60 天。需求方确认控制台设置为 30 天；仓库不存放套餐截图。Production PostHog 变量仍留空。

任一项未完成时停止于规划，不以“先打开全量录制再补治理”的方式上线。`user_cohort` 已跳过，不阻塞契约实现。

## 1. 复用调研结论

| 类别           | 已检索资产                                                               | 结论                                                                                           |
| -------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 前端启动与身份 | `app/providers.tsx`、Sentry `setTelegramUser`                            | 扩展 Telegram 就绪后的初始化，不平行解析 initData。                                            |
| 聊天会话       | `use-chat-session.ts`、`chat/[characterId]/page.tsx`                     | 在已有 session/character 生命周期挂录制 context，不重写路由会话语义。                          |
| 流式对话       | `use-conversation-turn.ts`、`lib/api/conversation-stream.ts`             | 在 turn hook 的生命周期打点；不逐 delta 打点，不新增 SSE parser。                              |
| 余额不足       | `lib/recharge-redirect.ts`                                               | 作为四个调用方共用的付费墙事件出口，避免散落同名事件。                                         |
| 订单流程       | `recharge/page.tsx`、`recharge/[orderId]/page.tsx`、`lib/api/payment.ts` | 复用 order ID、订单轮询和终态；不前端推断结算。                                                |
| 支付结算       | `routes/payment.ts`、`PaymentSettlement.ts`、既有失败落库点              | 在既有订单终态持久化后发送非关键分析事件；不新建结算入口或改变订单状态机。                     |
| 共享契约       | `shared/src/api/payment.ts`、`wallet.ts`                                 | 新跨进程 replay context、订单 `settled_by` 和受限事件枚举先定义在 shared；SDK 内部类型不外泄。 |
| telemetry 清理 | `shared/src/telemetry/sanitize.ts`、Sentry replay                        | 只复用作日志/Sentry 清理；PostHog DOM/属性屏蔽必须独立实现和验证。                             |
| 数据库/分析    | `miniapp_analytics` 架构边界                                             | 不新增 migration，不将 PostHog 写入分析 schema。                                               |

拒绝的过度设计：自建 rrweb 服务、事件队列、analytics database、运营后台播放器、全局 API 拦截打点、逐字 SSE 事件和新的支付状态机。

## 2. 执行顺序

### I1：锁定契约与安全数据模型

1. 搜索所有可能提供 `is_paid_user`、注册时间/用户分群、累计聊天轮数的既有安全 DTO；确认是否可完整复用。
2. 新增最小 `packages/shared/src/api/telemetry.ts`，将 PostHog 作为外部数据消费者的 browser-safe 事件属性定义收口；该文件不是 HTTP DTO，不暴露 SDK 类型：

- replay context 的 Zod request/response schema；
- PostHog 事件的受限联合类型、事件名与安全属性枚举；
- 不包含聊天正文、`pay_url`、完整 initData、支付凭据、内部数据库 row。

3. 扩展 `PaymentOrder`、对应 Zod schema（如有）和 `toPaymentOrder()`，兼容性新增 `settled_by: PaymentSettlementSource | null`。订单详情与订单列表必须使用同一映射。
4. 在 `packages/shared/src/index.ts` 导出新增契约，并为 schema/type 增加针对非法属性、联合值和 `settled_by` 映射的测试。
5. `user_cohort` 本期跳过，不写入契约或服务端计算。

### I2：最小 Backend context 与订单终态关联

1. 新增受 `requireTelegramAuth` 保护的 `GET /api/telemetry/replay-context`，保留附近的 `@frontend-ready` 注释；Frontend 仅通过 `src/lib/api/` 的 React Query hook 调用它。
2. 由既有 `app_core.users`/钱包事实源取最少字段：稳定 analytics identity、Telegram 用户 ID、`is_paid_user` 和 `total_chat_rounds`。不得由前端从免费额度、日期或本地状态猜测。本期不计算、不返回 `user_cohort`。
3. 将当前订单 read DTO 的 `settled_by` 透出给客户端。不得为此新增数据库字段、跨域直接 SQL join、支付状态或结算入口。
4. 在既有订单终态持久化之后发送服务端事件：`PaymentSettlement` 成功且幂等地写入 completed 后发送 `payment_order_settled`；所有既有 `markFailed` 成功写入 failed 的调用点共用同一 observer，发送 `payment_order_failed`。事件用同一 analytics identity 与 `order_id` 关联，不依赖用户回到 MiniApp；它是非关键观测，不得延迟或回滚订单写入。
5. Backend adapter 使用 Node 22 原生 `fetch` 调用 PostHog ingestion，避免为单一非关键 capture 引入 `posthog-node`；通过 `platform/config.ts` 取得专用 PostHog host/key 配置，调用有明确短超时、无无限重试；失败仅以安全摘要 Pino 记录。不得把浏览器 token、支付 URL、通知正文、initData 或错误 body 送往 PostHog。
6. 为 route 和 adapter 记录 allowlist 请求字段、结果摘要、耗时和链路 context；原始错误用 `{ err }`。
7. 使用既有 Backend 测试风格覆盖鉴权、合法 shape、终态事件只在成功结算后发送、重复结算不产生业务副作用，以及 telemetry 超时/失败不影响支付。

### I3：PostHog adapter 与配置

1. 将 `posthog-js` 作为 `@miniapp/frontend` 依赖安装，固定 lockfile 版本；保留现有 Sentry Session Replay，不关闭、不降采样、不替换它，也不引入第三个 replay SDK 或全局 analytics 框架。
2. 新建客户端 adapter，封装：

- HTTPS host 与公开 key 校验；
- 单例懒加载、初始化、`identify`、session properties；
- 显式事件的 runtime schema 校验和去重；
- start-new/stop recording，失败 no-op；
- 标准化的安全错误码和无内容日志。

3. 在 `app/providers.tsx` 的 Telegram 用户就绪后初始化/identify；不把 initData、start_param、完整 URL 或聊天正文传给 SDK。
4. 默认关闭 PostHog 自动 recording 与网络/console body 采集；仅由聊天生命周期及其显式付费墙延续手动开始。
5. 建立并测试 `ph-no-capture`/输入与文本屏蔽策略。除获批准的聊天消息区外，屏蔽支付、账号、验证码、URL 和所有敏感字段。
6. 在根 README 或既有前端环境文档记录变量名、公开性质、允许环境和空配置降级；Frontend 当前没有 `.env.example`，不得新建未被项目采用的平行模板，也不得写真实 key。

### I4：聊天生命周期与事件

1. 在根 `Providers` 所拥有的专用 replay lifecycle owner 中维护单一状态机，不能将 recording 的 start/stop 放在会随路由卸载的 `use-chat-session.ts` cleanup 中。状态至少区分 `idle`、`chat`、`paywall_followup`、`external_payment_pending` 与 `ended`。
2. 聊天页在拿到真实 session ID 后创建 replay context，附角色卡、会话和模型标签；会话尚未创建时不得伪造 session ID。自定义语音路由同样必须恢复该 context。
3. 正常离开聊天、`pagehide` 和 idle timeout 都结束 context；但由余额不足进入充值、邀请、订单结果页，或打开外部支付的 route/visibility 变化不得结束它。打开外部支付前必须先原子地把 lifecycle state 置为 `external_payment_pending`，再调用 `openPaymentUrl()`，防止 `pagehide` 竞争性结束 context。外部支付回来时可以产生新的 PostHog recording，但必须以稳定 `replay_context_id`、`order_id` 和 identity 关联；不得宣称物理上是一段连续录像。
4. 明确定义 idle：只在用户没有输入、点击、滚动、可见页面活动或正在流式生成的情况下计时；流式回复和 `external_payment_pending` 不触发 idle 结束。超时时长已确认为 **15 分钟**（见 `research/t1-decision-record.md`）。
5. 在 `use-conversation-turn.ts` 记录发送、流开启、成功、业务失败、网络失败、超时、重生成和重生成结果；事件不含用户/模型文本与错误正文。禁止对每个 SSE `delta` 打点。
6. 当前产品没有“编辑消息”或自动重试操作：本任务不新增这些功能，也不提供“重试次数 > 2”筛选。异常检索改用现有的 stream failure、reply-stalled 与重生成次数。
7. 保留页面当前的临时流式 state、Abort 和 Query cache 收敛；分析失败不得影响用户可见错误处理。
8. 为每次成功的模型切换建立 context 更新点；属性更新失败不阻断模型选择，也不得把用户级模型误写成历史轮次的模型。

### I5：付费墙、邀请与支付关联

1. 在 `recharge-redirect.ts` 记录余额不足来源及跳转充值，并建立不写入 URL 的短生命周期 paywall continuation context，保持现有错误码兼容。四个既有调用点（聊天 SSE、聊天语音、自定义语音、模型切换）必须传入可枚举触发源。
2. 充值页记录余额不足提示展示/关闭、邀请入口、套餐/方式选择、订单创建、外部支付拉起请求和不能拉起的安全失败类别；`/profile/invite` 是 paywall continuation 的允许录制页面，不得被通用 profile 排除。
3. 移除 `pay_url` 在 router URL、回放和事件属性的暴露：以 order ID 为 key 使用受控短生命周期 `sessionStorage` 保存重开支付所需 URL，并在打开外部链接前完成 context state 与存储写入、保持现有 `openPaymentUrl()` 再 `router.push()` 的顺序。若存储不可用或 URL 不存在，等待页只展示订单状态与安全的重新下单路径，不得把 URL 放回 query。
4. 同一个受控存储条目保存 `returnTo`、`replay_context_id` 和创建时间；订单终态或 TTL 后清理。Telegram 重新拉起导致存储缺失时，回退到订单详情/订单列表，并用 `order_id` 与服务器终态事件关联，不能虚构原聊天返回地址。
5. 订单详情页和 `PaymentReturnRedirect` 都记录回流；必须覆盖带 order ID 的详情回流和无 order ID 的 `/profile/orders?payment=returned` 回流。订单页根据服务端状态记录 pending/failed/expired/completed、`settled_by` 和已观测时长；相同 `order_id + state + settled_by` 每个 browser context 只记录一次。
6. 不在 unload/pagehide 时写“最终放弃”。仅发送 `payment_flow_left_observed`（最后已观测动作、pending 状态）；“abandoned”筛选定义为该事件后在约定观察窗口内没有相同 order ID 的 server `payment_order_settled` 或新的继续事件。支付成功优先于先前的离开事件，`expired` 也不是不可逆终态，因为现有结算会重开迟到付款订单。
7. 同一 flow 的最终类别由 PostHog 查询按事件顺序导出，而非由前端覆写一个可变属性：`payment_completed` 取 server 成功结算；`payment_failed` 取 server 明确失败；`invite` 记录用户选择但不会阻止之后支付成功覆盖最终结果；没有选择即离开才可标为观察窗口内的 `abandoned`；其余为 `unknown`。
8. 保持 Backend `PaymentSettlement`、轮询及所有四条结算入口不变；不让 PostHog 事件决定 UI 成功态、余额或订单结算。

### I6：验证、上线与回滚

1. 执行自动化检查，按实际影响范围至少包括：

```bash
 pnpm --filter @miniapp/shared typecheck
 pnpm --filter @miniapp/shared test
 pnpm --filter @miniapp/backend typecheck
 pnpm --filter @miniapp/backend test
 pnpm --filter @miniapp/frontend typecheck
 pnpm --filter @miniapp/frontend test
 pnpm --filter @miniapp/frontend lint
 pnpm --filter @miniapp/frontend build
 pnpm -r typecheck
 pnpm lint:imports
```

T8（2026-09-16，HEAD `bb0ee02`）复跑全部通过：shared typecheck + test（8 files / 57）；backend typecheck + test（51 files / 435）；frontend typecheck + test（26 files / 132）+ lint + build；`pnpm -r typecheck`；`pnpm lint:imports`。

2. 在对 `dev` 的 PR Preview（同一 PostHog 项目 `610481`）验证：100% 手动启动均有录制、聊天进出生成新 recording、同一 paywall context 的多段 recording/order ID 关联、SSE 可见节奏、重生成、网络失败、余额不足、邀请、付款跳转、回流、失败/超时订单和观察窗口内放弃路径。需求方 2026-09-16 确认真机通过。Production 变量保持关闭。
3. 在真实 Telegram WebView、常规移动浏览器、窄屏、软键盘、前后台切换、外部支付打开/返回和弱网验证；外部收银台仅验证关联事件与回流，不要求画面。需求方 2026-09-16 确认。
4. 在 PostHog UI 检索验收维度；事件抽查未见 `pay_url`/`initData`/`content`/`message`。套餐 Free、Session Replay 30 天以需求方控制台确认为准；仓库不存放含密钥截图。
5. 发布顺序为 shared → Backend PR 环境 → Frontend **Vercel Preview**（100% 手动录制，同一 PostHog 项目）→ 生产配置启用。Preview 已用；**Production 变量仍留空**，打开生产采集是 T8 之后的独立运维步骤。
6. 回滚首先关闭 PostHog 项目 token/受控采集开关，使 adapter no-op；不回滚支付/聊天业务。已收集的内容依批准流程在 PostHog 侧删除/过期，不宣称应用关闭即可删除历史数据。

## 3. 风险与恢复矩阵

| 风险                        | 预防                                                                                                  | 降级或恢复                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| SDK/网络失败                | 懒加载、短超时、有限安全重试、no-op adapter                                                           | 聊天/支付继续；记录无内容健康事件。                          |
| 外部支付导致 recording 断段 | 用 `replay_context_id`/order ID关联多段 recording，不依赖 pagehide 送达事件                           | 回来后新段继续关联；未回来时由 server payment event 补终态。 |
| 双重录制/成本与暴露面       | 已接受：PostHog 负责产品检索，Sentry Replay 维持现有 100% 排障录制；PostHog 仅聊天/付费墙延续手动启停 | 回滚只关闭 PostHog 配置；不得借回滚改动 Sentry Replay。      |
| 聊天/支付敏感数据泄露       | browser-side selector 屏蔽、URL 改造、审批与真实回放检查                                              | 停止采集，执行 PostHog 删除/访问撤销流程。                   |
| 外部支付盲区                | order ID 关联、打开/回流/服务端终态事件                                                               | 报告为不可观测，不推断收银台原因。                           |
| 事件重复/乱序               | context ID、订单状态去重、服务端订单为准                                                              | 保留时间与来源，分析侧按唯一键聚合。                         |
| 用户标签错误                | 服务端最小 context、规则版本                                                                          | 修正规则后以新版本属性发布，不覆盖历史解释。                 |
| `pay_url` 暴露              | 不写 URL/事件；改受控临时存储或暂停 recording                                                         | 阻断生产启用并清理受影响 replay。                            |

## 4. 可审阅的文件范围（预估）

- `packages/shared/src/api/telemetry.ts`（新增，若需跨层 context/event contract）
- `packages/shared/src/index.ts`
- `packages/backend/src/routes/telemetry.ts`、`features/payment/*`、`platform/config.ts` 与对应 tests
- `packages/frontend/package.json`、`pnpm-lock.yaml`
- `packages/frontend/src/app/providers.tsx`
- `packages/frontend/src/lib/telemetry/*`（新增）
- `packages/frontend/src/hooks/use-chat-session.ts`
- `packages/frontend/src/hooks/use-conversation-turn.ts`
- `packages/frontend/src/lib/recharge-redirect.ts`
- `packages/frontend/src/app/chat/[characterId]/page.tsx`
- `packages/frontend/src/app/chat/[characterId]/voice/[messageId]/page.tsx`
- `packages/frontend/src/app/(main)/profile/recharge/page.tsx`
- `packages/frontend/src/app/(main)/profile/recharge/[orderId]/page.tsx`
- `packages/frontend/src/app/(main)/profile/invite/page.tsx`
- `packages/frontend/src/app/(main)/profile/orders/page.tsx`
- `packages/frontend/src/components/chat/chat-model-switcher.tsx`
- 根 README 或现有前端环境文档（Frontend 当前没有 `.env.example`，不得创建未被项目采用的平行模板）
- 受影响 spec 与测试文件

实际范围须以实施前的 contract/source 调研为准；不因这份预估创建 migration、Admin/CS Platform 代码或产品功能。
