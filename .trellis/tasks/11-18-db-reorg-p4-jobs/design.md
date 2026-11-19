# 阶段 4 设计

## 4a 支付对账任务表 + 退避 + 支付事件迁 ops（生产只读核对，11-18）

### 现状与 bug

- `billing.payment_orders` 1190 单（completed 308 / expired 610 / failed 269 / pending 3）。对账调度列 4 个：`next_reconcile_at`（NOT NULL，默认 now()+1 分钟）、`last_reconciled_at`、`reconcile_attempts`、`reconcile_locked_until`。当前后端只用 `next_reconcile_at`；另外 3 列只有旧版本写过（pg_stat 里 50 次 UPDATE、3.3 万次带锁 SELECT，均为历史计数，发布前两次采样确认不再涨）。
- 对账 worker（Railway `stminiapp-payment-reconcile-cron`，`fast_reconcile`；payment-cron 的 `expiry_reconcile` 走同一函数）：每 30 秒取 7 天内未入账的易支付单（pending + expired，后者用于捕获迟到支付），每单先把 `next_reconcile_at` 推后 30 秒再查单。**没有退避**：一张放弃支付的单在 7 天里被查约 2 万次。
- 实测（近 24 小时，只看聚合）：12 张单被查约 3 万次——11 张已过期、平台已建单、用户从未确认去支付；同一张单交替返回平台 500（`provider_unavailable`）与 unpaid，像是被高频查单打出来的限流；1 张未在平台建单的 pending 单每次都失败，7 天里一直挂在 pending。`payment_operation_events` 每天涨约 3 万行，266,830 行 / 156MB，其中绝大部分是这类对账噪音。支付告警只扫最近 1 小时最新 2000 条事件，噪音会把真实事件挤出窗口。

### 读写方

- `payment_operation_events`（O）：后端经 PostgREST upsert（`event_key` 去重）；`PaymentAlertMonitor` 经 PostgREST 读近 1 小时；客服仓库文档把它当排查入口（人看，不在运行时读）。
- `payment_orders.checkout_confirmed_at / last_checkout_confirmed_at / checkout_confirm_count`：只有 `billing.record_checkout_confirmation` 写，它的调用方在 11-03 换收款渠道时已删除（`76f4b847`），pg_stat 19 次为历史；当前代码不读这三列。同一事实已作为 `checkout_confirmation` 事件进事件表。
- 依赖 `payment_orders` 的视图：`traffic_daily_stats`（amount_cents/status/user_id）、`cs_feed.user_profiles`（paid_at/status/user_id），都不涉及要删的列。

### 方案

| 对象                                                                                                              | 处理                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billing.payment_reconcile_jobs`（J，新）                                                                         | 每张可对账订单一行：`order_id` PK/FK 级联、`attempts`、`next_attempt_at`、`last_attempt_at`、`created_at`。插单触发器建行（下一次查单 = 1 分钟后，与原默认一致）；扩展时为 7 天内可对账订单回填（attempts=0）                                                           |
| `billing.claim_payment_reconcile_jobs(p_now, p_window_start, p_limit, p_base_delay_seconds, p_max_delay_seconds)` | 一个事务里：删掉已入账/已终结/出窗口订单的任务行；按 `next_attempt_at` 取到期任务（`FOR UPDATE SKIP LOCKED`），`attempts+1`、下一次 = now + min(base·2^attempts, max)，返回订单行。退避参数由后端常量传入（30s 起、封顶 2 小时）：7 天内每单约 90 次查单（原约 2 万次） |
| 后端对账                                                                                                          | `listRecentUnsettled` + `scheduleReconciliation` 换成一次 `claim` RPC；查单、入账、本地过期逻辑不变；用户主动查单（user_poll / return）与 webhook 不受影响                                                                                                              |
| `billing.payment_operation_events` → `ops.payment_events`                                                         | 整表 `SET SCHEMA` + 改名（数据、索引、约束、序列、授权随表走），旧位置留同名兼容视图供旧后端读写（ON CONFLICT 经视图可用，见 2b）。ops 不经 PostgREST 暴露，新后端改用 Prisma 原生 SQL 读写（与 2b 告警表一致）                                                         |
| `billing.record_checkout_confirmation`                                                                            | 无调用方，扩展步删除                                                                                                                                                                                                                                                    |
| 收缩                                                                                                              | 删兼容视图；删 `payment_orders` 的 4 个对账列与 3 个结账确认列、`idx_payment_orders_due_reconcile`、`idx_payment_orders_checkout_confirmed_at`、`payment_orders_checkout_confirm_count_nonnegative`；守卫：无函数/视图再引用                                            |

发布窗口：旧 worker 用 `next_reconcile_at`、新 worker 用任务表，部署交替的几分钟里可能各查一次，结算本就幂等，不需要同步。

退避取舍：迟到支付的兜底主要靠已验签回调与用户返回/轮询的即时查单；对账只兜回调丢失。30s 起翻倍，回调丢失的已付单最晚在"距下单时间的一倍"内被补账（例如下单 20 分钟后付款且回调丢失，约 40 分钟内到账），封顶后每 2 小时一次直到 7 天。

不做：1 张未在平台建单的 pending 单仍按原规则（不批量过期未知单），退避后每 2 小时查一次，到 7 天自然出窗口；不清理历史噪音事件（保留期另议，`ops.payment_events` 登记 365 天）。

### 验证

`bash scripts/test-db-reorg-p4a-migration.sh`（PG17 非超级用户）：回填只覆盖可对账订单；插单自动建任务行；claim 的退避序列、封顶、并发互斥（两个会话 SKIP LOCKED 不重复领取）、清理已入账/出窗口任务；事件表搬家后旧写法（经兼容视图 upsert 去重）与新写法（ops 直写）都可用、告警读取一致；收缩守卫与删列；可重跑。后端单测覆盖退避调用与 Prisma 读写。

上线核对：发布后 1 小时内 `ops.payment_events` 里 `fast_reconcile` 每小时事件数从约 1250 降到个位数；pg_stat 旧的 `next_reconcile_at` 更新语句停涨；告警 heartbeat 正常。

## 4b / 4c（待 4a 上线后设计）

- 4b：`experience.chat_message_images` 的 `lease_owner / lease_expires_at / next_attempt_at / stage / provider_request_id` → `experience.chat_image_jobs`。
- 4c：`media_plaza.image_plaza_attempts` 的 `lease_owner / lease_expires_at / provider_request_id` → `media_plaza.image_plaza_jobs`；视频广场 `video_attempts.lease_*` 与 `video_quotes`（钱）随视频分支现状另评估。
