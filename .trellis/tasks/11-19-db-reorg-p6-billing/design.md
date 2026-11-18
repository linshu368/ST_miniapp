# 阶段 6 设计：观测外迁 + 计费统一

## 现状（生产只读核对，11-19；只看结构与聚合）

### 体积与近 7 天流量

| 表                                             | 总大小 | 近 7 天                                                                                               |
| ---------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `experience.chat_generation_requests`          | 59MB   | 4.8 万行（每轮一行，10-23 起）                                                                        |
| `experience.chat_generation_attempts`          | 40MB   | 5.6 万行：OpenRouter 2.1 万、Surplus 3.4 万、Venice 436；落败调用快照 4843                            |
| `experience.openrouter_chat_history`           | 309MB  | 1.8 万行（每轮最多一行，只记交付的那次调用）                                                          |
| `experience.venice_chat_history`               | 6MB    | 217 行                                                                                                |
| `experience.surplusintelligence_chat_history`  | 107MB  | 3.4 万行（每轮一行，含落败调用；带请求记录补查状态）                                                  |
| `miniapp_features.free_zone_calls`             | —      | 2.6 万行（畅聊多路调用，带成本补查）                                                                  |
| `billing.llm_usage_charges`                    | 185MB  | 1.8 万行：charged 5598（84,916 星尘）、free 11,418、failed 1222、pending 3；**每用户只留最近 100 条** |
| `billing.llm_usage_charge_dedup`               | 140MB  | 38 万行，旧表删掉的扣费键永久留在这里防重复                                                           |
| `experience.chat_history` 计费 4 列            | —      | 4.8 万轮里 4.77 万有报价快照（全部 `fixed_tier`）、7 千轮实扣，合计 106,836 星尘                      |
| `experience.chat_message_audio`                | 4MB    | 152 行（付费 2 行）                                                                                   |
| `experience.chat_message_images`               | 6MB    | 0 行（9-29 起关闭，4b 待用户决定）                                                                    |
| `media_plaza.image_plaza_attempts` / `_quotes` | <1MB   | 136 次生成（106 次扣费，9,810 星尘）/ 报价 1403 条                                                    |
| `media_plaza.video_attempts` / `video_quotes`  | <1MB   | 4 次（460 星尘预留）/ 26 条                                                                           |

`wallet_ledger` 近 7 天文本扣费 7000 笔、106,866 星尘，与 `chat_history.deduction_rate` 合计一致（差 30 星尘是 7 天窗口边界）；`llm_usage_charges` 因按用户删旧只剩 84,916。**对账以流水为准，不能拿 `llm_usage_charges` 当全量。**

### 读写方

数据库函数（`prosrc` 引用）：

- 计费：`billing.charge_llm_usage`（写 `llm_usage_charges`、读 `chat_history.llm_billing_snapshot`）、`reconcile_llm_usage`、`refund_llm_usage_charge`；触发器 `prepare_llm_usage_charge`（查去重表拒重复）与 `retain_recent_llm_usage_charges`（写去重表、删该用户第 101 条以后）；`chat_delivery_billing_gate`（读请求表交付事实 + 报价快照）。
- 语音/配图/广场：`charge_voice_usage`、`settle_voice_generation`、`settle_image_generation`、`settle_image_plaza_generation`、`share_image_plaza_artifact`、`reserve_media_plaza_video`、`refund_media_plaza_video`、`share_media_plaza_video`。
- 生成过程：`begin_chat_generation_observation`（建请求行与主调用行）、`prepare_chat_generation_fallback`（写 `fallback_triggered_ms`、建兜底调用行）、`observe_chat_generation_attempt`（写调用测速列）、`select_chat_generation_delivery`（交付仲裁；**顺带往 OpenRouter/Venice 明细表插一行 generation_id**，Surplus 走 `record_surplusintelligence_call`）、`report_chat_first_token`（客户端首字上报，写 `client_*`）、`record_chat_delivery_preview`、`cancel_chat_generation`。
- Surplus：`prepare_surplusintelligence_call`、`record_surplusintelligence_call`、`claim_surplusintelligence_request_record`。
- 展示/反馈：`list_chat_message_page`（输出 `deduction_rate`）、`save_chat_reply_feedback`（读报价快照）。
- 看板：`miniapp_analytics.refresh_grafana_core_day`（pg_cron 17 / 23，读 `llm_usage_charges` 的实扣与成本、报价快照里的型号、两张明细表的 usage）。

视图：`miniapp_analytics.chat_first_token_facts`（请求 + 主/兜底/交付调用 + 轮次）→ `free_zone_turn_facts`（再 join Surplus 明细，Grafana 01 看板读）；`free_zone_call_costs`（`free_zone_calls`）。`chat_first_token_facts` 由后端畅聊模型评估每 30 分钟读一次（Prisma，`features/free-zone/repository.ts`），用 `delivery_role / business_status / business_finish_reason / primary_end_reason / primary_wait_ms / primary_observed_until_ms / server_first_token_timeout`。Grafana 05 看板已清空（首字监控改走 Faro/OTel），`miniapp_analytics.chat_first_token_report` 没有现行调用方（11-19 基线：grafana_cloud 对该视图累计 102 次、报告函数 4 次，都是旧面板；下一次采样不涨即确认）。

后端（PostgREST / Prisma）：

- 文本结算：`features/generation/settle.ts`（扣费前落报价快照 → `applyLlmCharge` → 回写 `deduction_rate / llm_intended_deduction / llm_billing_settled_at` → 写供应商明细）、`sync-job.ts` 每 30 秒回捞 24 小时内未结算或明细不全的轮次（`sync-record-recovery / sync-charge-recovery / fixed-provider-recovery / surplus-billing-recovery`，后者经 PostgREST **按外键嵌入** Surplus 明细与请求表）。
- `MiniappWalletRepository.listSpending`：消费记录 = `llm_usage_charges` 最近 100 条 + `wallet_ledger` 媒体扣费最近 100 条（`wallet-spending.ts`）+ 文本退款流水。
- `GenerationObservationRepository.enrichGeneration`：按 generation_id 更新调用行的 `provider_latency_ms / provider_name / provider_reported_model / finish_reason`。
- `ConversationHistoryRepository` 与 `conversation-history-*`：读写计费 4 列。
- 免费专区：`free-zone/call-ledger.ts`（写 `free_zone_calls`）、`call-costs.ts`（成本补查，读 Surplus 明细）。

### 关键发现

1. **金额只由定档报价决定**（快照全部 `fixed_tier`）。OpenRouter 用量统计只在一处参与计费：SSE 没拿到 finish_reason 时用统计里的 finish_reason 判"是否自然收尾"。这个值落在 `chat_generation_attempts.finish_reason`（S，保留），所以供应商明细表本身是 O。
2. 交付身份重复存了两份：`chat_generation_requests.delivery_attempt_id` + `chat_generation_attempts.generation_id` 已经唯一确定交付的那次调用；`select_chat_generation_delivery` 再往 OpenRouter/Venice 明细表插 generation_id 只是旧结构的遗留。
3. `llm_usage_charges` 被当成"用户消费记录"用，所以按用户只留 100 条，再靠 38 万行的去重表防重复扣费——两张表合起来才是完整的扣费键集合。统一后一行一次计费、永久保留，去重表随之删除。
4. 死列：请求表 `first_token_emitted_ms`、`client_request_dispatched_ms`、`client_wait_finished_ms` 自 10-29 起全为空（后端已不上报/不写）；调用表 `provider_latency_scope` 恒为同一个值。
5. ops 不建外键（契约规则），PostgREST 不能再按外键嵌入；凡是嵌入明细表的后端查询，外迁时都要改成两次查询或 RPC。
6. 视频广场（`media_plaza.video_*`）由他人迭代中，`.trellis/tasks/11-18-video-spending-records`（codex，本地进行中，未推送）在改视频消费记录展示——广场的钱字段放到最后，动之前对齐。

## 拆步

先观测外迁（6a，不碰钱），再计费统一（6b）。6b 依赖 6a-2 建好的 `ops.llm_calls`（`llm_usage_charges` 的成本列要迁过去）。

| 步    | 内容                                                                                                                                                                                                                               | 碰钱 | 后端发布 |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| 6a-1  | 请求表测速列 → `ops.chat_generation_timings`；删 3 个死列；重建首字视图；删无人调用的报告函数                                                                                                                                      | 否   | 不需要   |
| 6a-2a | 调用表测速列 → `ops.llm_calls`（每次上游调用一行，主键 = attempt_id）；删常量列 `provider_latency_scope`；`enrichGeneration` 改写 ops                                                                                              | 否   | 需要     |
| 6a-2b | OpenRouter / Venice 明细 → `ops.llm_calls`（`raw_usage` / `raw_generation`）；交付仲裁不再插明细行；sync-job 的"明细不全"扫描改读 ops；看板日汇总改读 ops 成本                                                                     | 否   | 需要     |
| 6a-2c | Surplus 明细 → `ops.llm_calls`，请求记录补查状态 → `ops.llm_cost_jobs`；`surplus-billing-recovery` 改按 `attempts.generation_id` 取交付身份（不再嵌入）；`free_zone_turn_facts` 改读 ops                                           | 否   | 需要     |
| 6a-2d | `free_zone_calls`：调用身份并入 `chat_generation_attempts`（畅聊多路调用即多次 attempt），成本列 → `ops.llm_calls` / `ops.llm_cost_jobs`；`free_zone_call_costs` 改读 ops                                                          | 否   | 需要     |
| 6a-3  | 语音 `latency_ms` → `ops.media_generation_calls`（配图的 `provider_prompt / base_url_host / latency_ms` 看 4b 决定）                                                                                                               | 否   | 需要     |
| 6b-0  | 对账基线：下文 R1–R7 按日（上海时区）跑一遍存档                                                                                                                                                                                    | —    | —        |
| 6b-1  | 文本：建 `billing.usage_charges`；`charge_llm_usage` 等改写新表；`chat_history` 计费 4 列、`llm_usage_charges`（成本列去 `ops.llm_calls`）、去重表并入；门禁、交付仲裁、反馈、消息列表、看板日汇总、后端结算/回捞/消费记录全部切换 | 是   | 需要     |
| 6b-2  | 语音：`chat_message_audio` 13 个计费列 → `usage_charges`                                                                                                                                                                           | 是   | 需要     |
| 6b-3  | 聊天配图：按 4b 决定，保留则同 6b-2，下线则整表删                                                                                                                                                                                  | 是   | 需要     |
| 6b-4  | 图片/视频广场：报价表 → `usage_charges`（status=quoted），attempts 钱字段 → charge_id；与视频广场负责人对齐后做                                                                                                                    | 是   | 需要     |
| 6b-5  | 消费记录统一从 `usage_charges` 读；`wallet_ledger.reference_id` 统一指向 charge                                                                                                                                                    | 是   | 需要     |

每步按"扩展 → 后端发布 → 两次采样确认旧读写停涨 → 收缩"；纯数据库内的子步（6a-1）一个迁移完成。

## 6a-1：请求表测速列 → `ops.chat_generation_timings`

### 列去向

| 列                                                                                  | 近 7 天       | 去向                        |
| ----------------------------------------------------------------------------------- | ------------- | --------------------------- |
| `primary_timeout_ms`、`timeout_rate_target`、`fallback_timeout_ms`                  | 每行都有      | ops（开轮时冻结的测速配置） |
| `fallback_triggered_ms`                                                             | 7781 行       | ops                         |
| `client_first_token_received_ms`、`client_backgrounded`、`client_reported_at`       | 4.4–4.7 万行  | ops                         |
| `first_token_emitted_ms`、`client_request_dispatched_ms`、`client_wait_finished_ms` | 0（10-29 起） | 删除                        |

留在请求表的都是交付状态与计费依据：`first_token_deadline_ms`、`delivery_attempt_id`、`requires_visible_token`、`user_stop_billing_enabled`、`recoverable_delivery`、`first_token_timeout`、`server_timeout_stage`、`server_first_token_ready_ms`、`first_token_preview`、`billing_rejected`、`client_outcome`、`client_reason`、`client_delivery_failed`、`client_first_token_visible_ms`、`measurement_method` 等（门禁与首字上报的判断都只读这些）。`report_chat_first_token` 判断"是否在后台"用的是本次上报参数，不读 `client_backgrounded` 列。

### 新表

```sql
ops.chat_generation_timings(
  chat_history_id uuid PRIMARY KEY,          -- 软引用 experience.chat_generation_requests
  primary_timeout_ms integer NOT NULL,
  timeout_rate_target numeric NOT NULL,
  fallback_timeout_ms integer,
  fallback_triggered_ms numeric,
  client_first_token_received_ms numeric,
  client_backgrounded boolean,
  client_reported_at timestamptz,
  created_at timestamptz NOT NULL            -- = 请求行 created_at，按它清理
)
```

RLS 开启，`service_role` 授 SELECT/INSERT/UPDATE（三个写入函数是 SECURITY INVOKER，由 service_role 调用）；视图是 owner 权限，读者不需要直接授权。保留 180 天；最早的数据是 10-23，2027-04 前没有可删的行，清理任务与 5b 的 prompt 快照清理合成一个 `ops` 每日清理任务一起建。

### 迁移（一个文件）

1. 锁外：建表；全量回填（6.8 万行，INSERT…SELECT）。
2. 锁内（一个 DO 块，一次往返）：`lock_timeout 5s` 锁请求表 → 补近 1 天的增量（`ON CONFLICT DO UPDATE`，客户端上报和兜底都在开轮几秒内）→ 按原文定位改 3 个函数（每个锚点必须恰好匹配一次，已改过的跳过；用 `pg_get_functiondef` 改写，保留 OID、属主、授权）：
   - `begin_chat_generation_observation`：请求行不再写 3 个配置列，同语句块里插 timings 行；
   - `prepare_chat_generation_fallback`：`fallback_triggered_ms` 改写 timings；
   - `report_chat_first_token`：请求表只更新交付相关列，`client_first_token_received_ms / client_backgrounded / client_reported_at` 改写 timings，两个死列不再出现；
     → 重建 `chat_first_token_facts`（LEFT JOIN timings；去掉 `client_request_dispatched_ms`、`first_token_emitted_ms`、`client_server_residual_ms`、`client_wait_finished_ms` 四个输出列）与依赖它的 `free_zone_turn_facts`，恢复原授权（`service_role`、`first_token_metrics_reader` 只读）→ 删 `chat_first_token_report`（确认无调用后）→ 删请求表 10 列（7 列已迁 + 3 个死列）。
3. 守卫：
   - 锁外：生产 3 个函数的 md5 必须是采集时的值（`211f5c49…` / `cb47e2c3…` / `2ca9d83c…`），否则拒绝（TEST 不同构时另写前置）；
   - 锁内：每个请求行都有 timings 行；改完后没有函数正文再引用被删的列名；
   - 自检：改动前后对 `chat_first_token_facts` 近 3 天、改动前已存在的行，按保留列算聚合指纹（行数 + 各列 sum/count），必须一致，否则整体回滚。
4. 回放核对：本地 PG17 用生产函数正文（按 md5 从历史迁移抽取）建夹具，跑开轮 → 兜底 → 交付 → 首字上报 → 门禁，比较改前改后视图输出与门禁结果；TEST 跑一轮真实生成（Railway development 免登录）后看视图行。

上线后核对：新轮次的 timings 行与请求行一一对应；畅聊模型评估（每 30 分钟）无报错、指标连续；Grafana 01 看板畅聊两块面板有数。

## 6a-2 / 6a-3 要点（各自开工前再细化）

- `ops.llm_calls`：每次上游调用一行，主键 `id` = `chat_generation_attempts.id`（attempts 出现之前的旧明细行用原明细行 id，`attempt_id` 为空）；列：`chat_history_id`、`provider`、测速（`dispatch_offset_ms / headers_ms / first_chunk_ms / first_token_ms / observed_until_ms / http_status / provider_latency_ms`）、供应商回报（`provider_name / provider_reported_model / native_tokens_* / prompt/completion/cached/reasoning tokens / cost_usd / generation_time_ms`）、`raw_request / raw_usage / raw_generation / discarded_detail`（jsonb，键在 registry 登记）、`created_at / updated_at`。保留 180 天。
- 落败调用快照 `discarded_response` 现在兼做"这次调用已终结"的守卫，随测速列一起迁，守卫在 `observe_chat_generation_attempt` 里改读 ops。
- sync-job 的扫描源：`listRowsMissingGenerationData`（OpenRouter 明细不全）改读 ops；计费回捞的三个 provider 扫描仍以 `chat_history` 报价快照为准，6b-1 后改为 `usage_charges.status='pending'`。
- `select_chat_generation_delivery` 去掉对两张明细表的写入后，"同一轮不能同时有 OpenRouter 与 Venice 交付"的检查由 `delivery_attempt_id` 唯一性本身保证。

## 6b：`billing.usage_charges` 草案（6b-1 开工前定稿）

```text
billing.usage_charges(
  id uuid PK,                    -- 即 charge_id（文本沿用 llm_charge_id，语音沿用 audio id 作为幂等键）
  user_id uuid NOT NULL,
  kind text NOT NULL,            -- chat_text / chat_voice / chat_image / plaza_image / plaza_video
  subject_id uuid NOT NULL,      -- 软引用业务行（轮次、语音、配图、广场 attempt）
  status text NOT NULL,          -- quoted / reserved / pending / charged / free / failed / waived / refunded
  billing_mode text,             -- fixed_tier / paid / free_trial / legacy_free …
  wallet_policy text,
  quoted_credits numeric,        -- 报价应付（已含 VIP 折扣）
  charged_credits numeric NOT NULL DEFAULT 0,
  debit_ledger_id uuid, refund_ledger_id uuid,
  quote jsonb NOT NULL,          -- 冻结报价的其余字段：原价、折扣率、VIP 有效期、配置版本、型号、创作者分成…（键登记）
  quote_expires_at timestamptz, settled_at timestamptz,
  created_at, updated_at
)
```

- 永久保留（文本每周约 1.8 万行，一年约 100 万行、几百 MB）；消费记录按 `user_id, created_at` 索引取最近 100 条，不再删旧，去重表删除。
- `chat_history` 只留 `llm_charge_id`；门禁读 `usage_charges` 的 `status / billing_mode / quoted_credits`；`deduction_rate` 由 `charged_credits` 提供（消息列表经视图 join）。
- 免费额度决定（`character_free_chat_quota_decisions`）与免费试用（`feature_free_trials`）保持独立（M），仍按 charge_id 关联。

### 按日对账口径（6b 每步前后都跑，上海时区，已结束的日子必须完全一致）

- R1 文本：`wallet_ledger`（`chat_debit / llm_usage`）笔数与金额 = 实扣轮次数与金额（改前读 `chat_history.deduction_rate`，改后读 `usage_charges` kind=chat_text）。
- R2 免费额度：`character_free_chat_quota_decisions` 按状态计数。
- R3 语音：流水 `voice_usage` = 语音实扣。
- R4 图片广场：流水 `image_plaza_generation` = 广场实扣；分享返利笔数。
- R5 视频广场：流水 `media_plaza_video_reserve` 与退款 = 视频预留/退款。
- R6 创作者分成：流水 `creator_reward` 笔数与金额。
- R7 退款：`wallet_refunds` 与退款流水。

## 待定

- 6a-1 删 `chat_first_token_report`：等下一次采样确认 grafana_cloud 调用数不涨。
- 6b-3 聊天配图、6b-4 广场租约：等 4b / 4c 决定。
- `usage_charges` 里 `free` 状态的行（每周约 1.1 万）是否永久保留，6b-1 定稿时按消费记录是否展示免费轮再定。
