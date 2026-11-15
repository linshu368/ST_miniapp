# 设计

## 1. 复用调研

| 检索对象                                                                               | 结论                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_core.users.total_round`（`increment_user_total_round`，生成成功结算后 +1）        | 复用为「累计轮数」，跨角色、跨设备，服务端权威。                                                                                                     |
| `routes/community.ts` 入口查询（claim / exclusion）与 `readOfficialCommunityConfig`    | 复用：抽出 `readCommunityFacts` 供入口与弹窗资格共用，避免两套口径。                                                                                 |
| `miniapp_features.telegram_community_update_receipts`                                  | 复用为「是否已在群里」「是否欢迎过」的事实来源（最新一次成员状态 / 历史入群）。                                                                      |
| 发奖 webhook（@join_bonus_bot → 主后端，`grant` 幂等）                                 | 复用：欢迎语挂在发奖结果之后；退群重进 `already_rewarded`/`ignored` 自然不发。                                                                       |
| `lib/telegram-links.ts buildMiniappDeepLink`                                           | 复用拼「回到秘境」深链 `startapp=community`。`record_app_entry` 只在 botlinks 存在时改归因，`community` 不在其中，只多一条入口事实，不污染渠道统计。 |
| `readVipStrategy`、`vipCheckinBonusCredits`、`isVipActiveAt`                           | 复用取月卡价格/赠送/签到额与 VIP 有效期判断。                                                                                                        |
| `billing.user_wallets.first_paid_at`                                                   | 复用判断「充过值/买过」。                                                                                                                            |
| 前端 `useCommunityEntryQuery`（未领时 15s 轮询 + 回前台刷新）、`openTelegramCommunity` | 复用：点进群后启用它等待到账；打不开时沿用复制账号兜底文案。                                                                                         |
| `conversation-stream.ts` onDone（已用于新人引导计轮）                                  | 复用同一钩子给本次打开累加轮数。                                                                                                                     |
| `components/ui/dialog.tsx`（Radix）                                                    | 复用焦点管理与无障碍，覆盖样式为礼券卡。                                                                                                             |
| `afterEntryBackground` / providers 中的延迟挂载                                        | 复用：弹窗宿主与资格请求都在入口后台阶段之后。                                                                                                       |
| `onboarding/creator-invitation.tsx`                                                    | 扩展：接入「本次打开只弹一个」。                                                                                                                     |
| 不复用：`notifications` 站内信、客服触达                                               | 弹窗是即时界面提示，不需要消息记录。                                                                                                                 |

## 2. 数据模型（migration `20261113_growth_prompt_states.sql`，domain: miniapp_features）

**`miniapp_features.growth_prompt_states`**：每个用户每种增长弹窗的展示与处理记录。

- 列：`user_id uuid → app_core.users(id) on delete cascade`、`prompt text check in ('community','vip')`、`shown_count int ≥0`、`first_shown_at`、`last_shown_at`、`last_action text check in ('accepted','dismissed')`、`last_action_at`、`created_at`、`updated_at`；PK `(user_id, prompt)`。
- 不变量：展示次数与间隔上限由数据库函数原子判定，多设备同时触发也不会超额。权威写入方：Backend `/api/growth/prompts/events`。
- 归属：判定流程第 7 问——随「增长弹窗」功能上线/下线，产品运行时读取它决定是否弹（不是纯看数，不进 analytics）；不记钱（星尘仍走 `billing`），不是共享根数据（不进 `app_core`）。
- 生命周期：随用户删除级联；功能下线可整表删除；无历史保留要求。
- 跨 schema 依赖：仅 FK 到 `app_core.users`。
- 函数 `miniapp_features.record_growth_prompt_event(p_user_id, p_prompt, p_event, p_max_shows, p_min_interval_seconds) → jsonb {recorded, shown_count}`：`shown` 用一条带条件的 upsert（未达上限且距上次 ≥ 间隔才 +1）；`accepted/dismissed` 只更新已有行。SECURITY DEFINER、`search_path=pg_catalog`、只授 service_role。
- 权限：RLS 开、REVOKE PUBLIC/anon/authenticated；service_role SELECT（读状态）；写只经函数（不授 INSERT/UPDATE）。迁移内 `$verify$` 校验。
- 容量：每用户最多 2 行，PK 即查询路径，无需额外索引。

## 3. 资格规则（Backend `features/growth/prompt-rules.ts`，纯函数）

|          | 进群                                                                                   | VIP                                          |
| -------- | -------------------------------------------------------------------------------------- | -------------------------------------------- |
| 触发轮数 | 13                                                                                     | 50                                           |
| 前置     | 社群开启（chat_id、started_at 齐全）；未领奖；不在活动前名单；最近一次成员状态不是在群 | 购买开启且月卡配置有效；当前不是有效 VIP     |
| 上限     | 2 次，间隔 ≥24h                                                                        | 3 次，间隔 ≥72h；`first_paid_at` 非空则 1 次 |

轮数门槛不在服务端拦：GET 返回 `total_rounds` 与各弹窗 `at_rounds`，前端用「服务端轮数 + 本次打开新完成的轮数」判断时机，免得每轮请求一次。上限、状态在 GET 与 `shown` 写入时都由服务端判定。

## 4. 接口（shared `api/growth-prompts.ts`）

- `GET /api/growth/prompts` → `{ total_rounds, prompts: GrowthPrompt[] }`，按优先级排序，只含当下满足前置与上限的弹窗。
  - community：`{ kind, at_rounds, reward_credits, telegram_url, fallback_handle }`
  - vip：`{ kind, at_rounds, price_cents, duration_days, bonus_credits（专项+通用合计）, checkin_daily_credits }`
  - 并行读：用户行、社群配置与事实、VIP 有效期、`first_paid_at`、弹窗状态、VIP 策略；任一失败整体 503，前端静默不弹。
- `POST /api/growth/prompts/events {kind, event: shown|accepted|dismissed}` → `{ recorded }`。`shown` 时服务端按规则重算上限后调用函数。
- pino：`growth.prompts.read`（数量、耗时）、`growth.prompt.event`（kind/event/recorded）。不记 Telegram 名称。
- 两条路由都保留 `@frontend-ready: true`。

## 5. 群欢迎语（Backend `features/community/welcome.ts`）

- 发奖 webhook 在结果为 `rewarded` 后 `void` 发送：`🎉 欢迎 <用户名> 加入秘境社群！入群奖励 N 星尘已到账，回去就能接着聊。` + URL 按钮「回到秘境继续聊 ›」。
- 匹配不到账号（unmatched）且该 Telegram 用户此前没有任何入群收据：发不带星尘的欢迎与「进入秘境 ›」。
- `already_rewarded`、`ignored`、重复入群：不发。
- HTML 模式，用户名转义并截断 24 字，用 `tg://user?id=` 点名；`disable_notification`；模块内记住上一条欢迎语 id，发新的后删除旧的（失败忽略；进程重启最多残留一条）。
- 走 `TELEGRAM_COMMUNITY_BOT_TOKEN`（即 @join_bonus_bot），5s 超时，不重试（sendMessage 非幂等）；失败只记 warn，不影响 webhook 2xx。

## 6. 前端

- `lib/api/growth-prompts.ts`：`useGrowthPromptsQuery(enabled)`（后台优先级、5s 超时、不重试、本次打开内不过期）与 `recordGrowthPromptEvent`（发后不管，成功后失效查询）。
- `lib/growth/prompt-visit.ts`：模块级小状态——本次打开新完成的轮数、是否已弹过一个；`useSyncExternalStore` 订阅。
- `components/growth/growth-prompt-host.tsx`（providers 中 `backgroundReady` 后动态挂载）：
  - 时机：数据就绪后 1.5s、每完成一轮后 1.2s、路由切换后 0.8s 各评估一次。
  - 平静条件：页面可见、路由在白名单、无聚焦输入框、无其它 `role=dialog`、本次打开尚未弹过。
  - 选第一个「服务端轮数 + 本次轮数 ≥ at_rounds」的弹窗；弹出即占位并上报 `shown`。
- `components/growth/growth-prompt-card.tsx`：居中礼券（对比稿 B）。主按钮金色渐变 + 一次性光泽；「以后再说」暗色小字；遮罩 `bg-black/60` 无模糊。
  - 进群：主按钮 `openTelegramCommunity` → 上报 `accepted` → 关闭；打不开时卡片内显示群账号。之后宿主启用 `useCommunityEntryQuery`，状态变成 `rewarded` 时轻提示「500 星尘已到账」+ 成功震动，并失效钱包与消息未读。
  - VIP：主按钮上报 `accepted` → `router.push('/vip?returnTo=<当前路径>')`。
- `creator-invitation.tsx`：本次打开已弹过增长弹窗则不弹；创作邀请弹出时占用同一个位。

## 7. 可靠性

- 超时：GET/POST 5s；Telegram sendMessage/deleteMessage 5s。
- 重试：GET 不重试（下次打开再取）；POST 不重试（丢一次 `shown` 至多多弹一次，可接受）；Telegram 不重试。
- 幂等/并发：展示上限由单条条件 upsert 保证；发奖幂等沿用既有 `grant`；欢迎语只挂在首次 `rewarded` 与首次 unmatched 上。
- 降级：任何读取失败 → 不弹；社群配置关闭 → 不弹进群；VIP 购买关闭 → 不弹 VIP；欢迎语失败 → 只记日志。
- 容量：GET 每次打开一次，7 个轻量并行读（均按主键/唯一键）；POST 每次弹出最多 2 次。
- 可观测：路由日志 + 表内 `shown_count/last_action` 可直接算转化（展示→进群收据/订单）。

## 8. 演进与发布

TEST migration → 验证 → 生产 migration（独立确认）→ Backend → Frontend。旧后端不读新表；前端先上而后端未上时 GET 404 → 静默不弹。回滚：回退应用即可，表保留；数据库缺陷 forward-fix。

## 9. 拒绝的方案

- 只用 localStorage 记次数：Telegram WebView 会清理、换设备会重弹，违背「最多 3 次」。
- 每完成一轮请求一次资格接口：多余请求；改为打开时取一次 + 本地累加。
- 让群管 bot（mijing-community-bot）发欢迎语：它不知道发奖结果，需要跨服务密钥与新接口，且其规则要求群内静默。
- 星尘用完时改为弹窗：用户未要求，保留现有充值跳转。
