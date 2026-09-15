# T7 验收记录（进行中）

记录时间：2026-09-15  
分支：`dev_posthog`  
执行人：qj  
状态：**Doing / 生产配置禁止启用**（Preview 真机验收未完成）

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

未勾选即未验证：

- [ ] 进入聊天开始新 recording；再进另一个聊天是新段，不与历史合并
- [ ] SSE 可见节奏 + Markdown（画面允许正文；事件属性不允许正文）
- [ ] 重生成、网络失败、reply-stalled
- [ ] 四类 triggerSource：`chat_sse` / `chat_voice` / `custom_voice` / `model_switch`
- [ ] 充值、邀请、创单、外部支付拉起、回流有 order ID、回流无 order ID（`/profile/orders?payment=returned`）
- [ ] 失败/超时订单；观察窗口内离开（`payment_flow_left_observed`）；expired 不是不可逆失败
- [ ] 未回流时仍能按 `order_id` 看到服务端 `payment_order_settled` / `payment_order_failed`
- [ ] 同一 paywall 的多段 recording 用 `replay_context_id` + `order_id` + identity 关联
- [ ] Telegram WebView、常规移动浏览器、窄屏、软键盘、前后台、外部支付打开/返回、弱网
- [ ] 外部收银台不要求画面

静态单测（不能替代 Preview 真机）：

- 缺配置 / 非 HTTPS → adapter no-op
- `startSessionRecording({ sampling, linked_flag, url_trigger, event_trigger })`
- 事件 schema 拒绝 `content` / `pay_url` / initData 类键
- URL/网络录制剥离 query 与 body/header
- 等待页路径不再带 `pay_url`

## 5. 敏感数据搜索

| 通道                        | 本轮                                              |
| --------------------------- | ------------------------------------------------- |
| PostHog 回放 URL / 事件属性 | **未做**（待 Preview 真机后在项目 `610481` 检索） |
| Sentry Replay UI            | **未做**                                          |
| Preview / 应用日志          | **未做**                                          |
| 自动化单测                  | 已覆盖禁止属性与 URL 脱敏；不足以上线             |

## 6. 按序发布记录

| 步                             | 环境                                   | 配置                                                                                              | smoke      | 下一步 / 回滚点                                              |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------ |
| shared 契约                    | 本分支                                 | 无密钥                                                                                            | I6 pass    | 随 PR 合并                                                   |
| Backend context + 支付终态     | Railway `pr-{n}`（复制 `development`） | Preview 才加 `POSTHOG_*`；Production 留空                                                         | 待 PR      | 去掉 `POSTHOG_API_KEY` → capture no-op                       |
| Frontend Preview 100% 手动录制 | Vercel Preview                         | Preview 加 `NEXT_PUBLIC_POSTHOG_*`；Telegram WebApp 指向 Preview；API URL 指向 `stminiapp-pr-{n}` | 待真机矩阵 | 去掉公开变量 → adapter no-op                                 |
| 生产配置启用                   | Vercel Production + Railway production | **禁止**，直到 §3 截图 + §4 矩阵 + §5 检索齐                                                      | —          | 同一套变量留空即关；不回滚聊天/订单/结算；不改 Sentry Replay |

关闭应用 **不能** 删除 PostHog 历史；初期 Preview 数据按需求方接受留在项目 `610481`。

## 7. 给 T8 的结论

**生产配置不允许启用。** 允许推 `dev_posthog`、对 `dev` 开 PR，在 Preview 做真机验收。T8 不得把 Production PostHog 写成已开。
