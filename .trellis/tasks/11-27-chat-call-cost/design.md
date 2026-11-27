# 技术设计

## 现状（2026-11-27 生产实测，只读数据源 fg1oltvmm56v4b）

- **`ops.llm_calls`**：约 49 万行，每次上游调用一行，覆盖收费轮每个 attempt、畅聊每个并发槽位、兜底、落败或取消、重写。
  - 成本由 call-costs 任务事后补：OpenRouter 按 generation id，Surplus 按请求号，约 10–30 分钟到位，最长查 24 小时、7 天后终结。
- **`analytics.llm_call_costs` / `analytics.llm_turn_costs`**：已经是「每轮 = 全部调用之和」的口径。
  - 模型按业务模型：畅聊取 candidate_id，付费取 chat_history.model。
  - 待补的成本是 NULL，unavailable 按 0。中转渠道没有美元换算时是 NULL。
- **直接查 14 天会超时**：按小时汇总 `llm_call_costs` 14 天的 EXPLAIN ANALYZE 超过 15 秒语句上限，`llm_turn_costs` 是全表 GROUP BY、过滤推不下去。聊天 lane 也没有 dispatched_at 索引，只有面板 lane 的部分索引。所以看板不能直接读视图。
- **成本缺口（近 3 天）**：
  - 畅聊 Surplus 首发：14350 次里 3238 次 unavailable。主要是被取消 1888 次、报错 1093 次（多为 404 派不出单，本不收费）、首字超时 231 次。
  - **畅聊 Surplus 重写：191 次里 186 次 unavailable，正常写完的 100 次全部缺。** 原因：`stream-recovery` 只读 `x-si-request-id` 响应头。首字兜底那一路读不到它时会再读 `x-request-id`，重写少了这一步。重写行不占 attempt 行，只能按请求号补查，没有请求号就记 unavailable。
  - 付费 venice 首发：取消的 89 次 unavailable。

## 落位（CONTRACT §3.2）

### 1. `analytics.chat_turn_costs`（D，派生）

每次聊天调用（一条回复）一行，主键 `chat_history_id`，软引用 experience.chat_history。

| 列                                                          | 含义                                             |
| ----------------------------------------------------------- | ------------------------------------------------ |
| `turn_at`                                                   | 该轮第一次派发上游的时间                         |
| `lane`                                                      | chat / free_zone                                 |
| `model_id`                                                  | 业务模型，同 llm_call_costs 取法；空记 `unknown` |
| `calls`、`primary_calls`、`fallback_calls`、`rewrite_calls` | 调用次数；首发含并发槽位                         |
| `total_cost_usd`                                            | 已知成本之和                                     |
| `primary_won_cost_usd`                                      | 胜出的首发                                       |
| `primary_lost_cost_usd`                                     | 首发其余：落败、取消、超时、报错                 |
| `fallback_cost_usd`                                         | 首字兜底，胜出与落败都算                         |
| `rewrite_cost_usd`                                          | 出字后重写                                       |
| `estimated_cost_usd`                                        | 其中按输入 token 估算的部分                      |
| `known_calls`、`pending_calls`、`unavailable_calls`         | 成本状态计数：已知、待补、补不到                 |
| `prompt_tokens`、`completion_tokens`                        | token 合计                                       |
| `refreshed_at`                                              | 刷新时间                                         |

- **写入**：只由 `analytics.refresh_chat_costs(p_since)` 写，pg_cron 调度。
- **读者**：Grafana（first_token_metrics_reader）。
- **保留**：180 天，同 ops.llm_calls，刷新时顺手删。
- **同一事实**：`llm_turn_costs` 是同口径视图，这张表是它的物化切片，多出成本结构与成本状态列，不另立事实。不改那个视图，经营核心等读者照旧。

### 2. `analytics.chat_model_prices_hourly`（D，派生）

每小时 × lane × role × provider × 上游模型一行，主键是这五列。

| 列                                               | 含义                        |
| ------------------------------------------------ | --------------------------- |
| `calls`                                          | 调用次数                    |
| `priced_calls`                                   | 成本已知且 token > 0 的调用 |
| `cost_usd`、`prompt_tokens`、`completion_tokens` | 只算 priced_calls           |
| `refreshed_at`                                   | 刷新时间                    |

- **单价** = cost / (prompt + completion) × 1e6，单位美元 / 百万 token。输入输出混合价，受输入输出比例影响，口径说明里写明。
- 写入、读者、保留同上。

### 3. `analytics.refresh_chat_costs(p_since timestamptz) RETURNS boolean`

- SECURITY DEFINER，`search_path=pg_catalog`。只授 owner（cron），REVOKE PUBLIC / anon / authenticated / reader。
- 拿不到建议锁 `pg_try_advisory_xact_lock(20261127, 30)` 就返回 false，防并发。
- **按轮**：取 `llm_call_costs` 中 `dispatched_at >= p_since - 5 分钟` 的调用，按 chat_history_id 分组，只保留 `min(dispatched_at) >= p_since` 的组，upsert。
  - 一轮的调用都在 110 秒执行上限内，所以这些组是完整的；跨在 p_since 前后的轮在更早的刷新里已经算过。
- **按小时**：删掉 `[date_trunc('hour', p_since), now)` 的小时行再重算，整点对齐，不留半小时。
- 删 180 天前的行。
- `p_since` 只允许最近 8 天内，防误调全表。迁移里的首次回填直接执行同样的 SQL，不受这条限制。

### 4. 索引

`ops.llm_calls (dispatched_at) WHERE lane IN ('chat','free_zone')`，用 CONCURRENTLY 在事务外建，沿用面板 lane 部分索引的做法。供刷新函数按时间窗取调用。

### 5. cron（生产有 pg_cron；TEST 没有就只建表和函数，记 NOTICE）

- `chat_costs_recent_15m`：每 15 分钟（`*/15`），刷最近 26 小时。成本最长 24 小时内补到；`statement_timeout` 10s、`lock_timeout` 1s、禁并行。
- `chat_costs_week_daily`：每天 20:23 UTC（北京 04:23），刷最近 8 天，接住 7 天终结窗口内的晚到成本；`statement_timeout` 60s。

### 6. 首次回填

迁移末尾从 2026-11-19 16:00 UTC（北京 11-20 00:00）起回填，即重组 6a-2c-3 归一化记账之后。语句上限 120s。之前的数据口径不全，不回填。

## 美元口径

- 全部读 `llm_call_costs.cost_usd`（美元）。
- OpenRouter、Surplus 原生是美元；Venice 原值是微美元，记账时已换算。
- 中转渠道（packy / onexmodel）按运营配置 `llm_relay_provider_config` 的 `usd_per_cny` 在记账时折成美元，没有换算的是 NULL，计入待补、不当 0。
- 看板所有金额列标 `$`，不出现人民币。

## 后端修复

1. **`stream-recovery.ts`**：请求号读法同首字兜底，`x-si-request-id ?? x-request-id`。
2. **`safe-log.ts` 白名单**：
   - NUMBER_FIELDS 加 `added_chars`、`reasoning_chars`；
   - BOOLEAN_FIELDS 加 `reset`；
   - TEXT_FIELDS 加 `fallback_model`（模型名，不是敏感信息）。

## 看板（docs/grafana/st-chat-cost.json → Grafana uid st-chat-cost，folder ag1okgop6om4gb）

- **变量**：`lane`（付费 / 畅聊，多选）、`model`（来自 chat_turn_costs 的 distinct model_id，多选、含全部）。
- **时间**：默认 now-7d，北京时区。所有面板排除最近 30 分钟（成本还在补），口径说明里写明。
- **面板**：
  - 第一行数字：调用次数、总成本、每千次调用成本、成本已知占比，都按平台拆开；
  - 模型明细表；
  - 每千次调用成本走势：付费、畅聊各一张；
  - 上游单价走势：Surplus 一张、OpenRouter / Venice 一张；
  - 成本结构走势：按天堆叠；
  - 口径说明 + 最近刷新时间。
- **链接**：01、02、03 互链，01、02 的 links 加 03，用 patch 改。

## 复用调研

- **复用**：
  - `analytics.llm_call_costs`：成本语义唯一来源，含中转渠道与 unavailable 规则。
  - `analytics.core_daily` 的 cron 与刷新函数写法：建议锁、cron 内 SET 限时、TEST 无 pg_cron 时跳过。
  - 面板 lane 部分索引的 CONCURRENTLY 做法。
  - 本地 PG17 测试脚本骨架：`scripts/test-panel-llm-calls-migration.sh`。
  - 看板 JSON 约定：数据源占位、北京日界、显式别名。
- **不复用**：
  - 物化视图：每次 REFRESH 要全量聚合 49 万行，超出 cron 时限。
  - Prometheus 计数器：成本 10–30 分钟后才补到，与调用时间错位，也没有历史。

## 可靠性

- **刷新失败**：表里保留上一次结果，看板显示「最近刷新时间」。cron 失败记录在 cron.job_run_details。
- **超时**：cron SQL 有 10s / 60s 上限；看板查询走新表，单面板目标 < 2s；数据源 1 连接排队。
- **幂等**：upsert 与按小时删后重算可以重跑；建议锁防止两个刷新撞车。
- **锁与容量**：只读 ops.llm_calls，不锁业务表。新表约 7 千行/天，180 天约 130 万行，turn_at 有索引。
- **不在产品路径**：产品请求不读这些表，刷新坏了不影响对话和计费。

## 演进与恢复

- **顺序**：
  1. 迁移 TEST；
  2. 迁移生产：建表、函数、索引、cron，回填；
  3. 后端 PR（重写请求号 + 日志白名单）→ dev → release → main；
  4. 发布看板 JSON；
  5. 01、02 加链接。
     看板只读新表，与后端发布互不依赖。
- **回滚**：`cron.unschedule` 两个任务 → DROP 函数与两张表 → DROP INDEX CONCURRENTLY；后端 revert。都不碰源数据。
- **停止条件**：生产回填超过 120s 或报错，整体回滚。cron 首日失败率 > 0，先停 cron 查原因。

## 拒绝的设计

- 不改 `llm_turn_costs` 视图的列：有外部读者，改了要动经营核心。
- 不做按输入、输出分开的单价：表里没有分项价格，只能混合价；以后真需要再拆。
- 不估算 unavailable 的成本：单列「成本未知次数」，不偷偷补数。
