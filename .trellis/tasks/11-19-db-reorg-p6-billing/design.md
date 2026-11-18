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

| 步   | 内容                                                                                                                                                                                                                               | 碰钱 | 后端发布 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| 6a-1 | 请求表删 6 个无读者的测速列（不新建表）；重建首字视图；删已退役的首字报告函数                                                                                                                                                      | 否   | 不需要   |
| 6a-2 | 上游调用观测，见下文"6a-2 细化"：2a 删 attempts 无读者列 → 2b 交付身份只认 attempts → 2c 建 `ops.llm_calls` 收三张明细与畅聊成本                                                                                                   | 否   | 需要     |
| 6a-3 | 语音 `latency_ms` → `ops.media_generation_calls`（配图的 `provider_prompt / base_url_host / latency_ms` 看 4b 决定）                                                                                                               | 否   | 需要     |
| 6b-0 | 对账基线：下文 R1–R7 按日（上海时区）跑一遍存档                                                                                                                                                                                    | —    | —        |
| 6b-1 | 文本：建 `billing.usage_charges`；`charge_llm_usage` 等改写新表；`chat_history` 计费 4 列、`llm_usage_charges`（成本列去 `ops.llm_calls`）、去重表并入；门禁、交付仲裁、反馈、消息列表、看板日汇总、后端结算/回捞/消费记录全部切换 | 是   | 需要     |
| 6b-2 | 语音：`chat_message_audio` 13 个计费列 → `usage_charges`                                                                                                                                                                           | 是   | 需要     |
| 6b-3 | 聊天配图：按 4b 决定，保留则同 6b-2，下线则整表删                                                                                                                                                                                  | 是   | 需要     |
| 6b-4 | 图片/视频广场：报价表 → `usage_charges`（status=quoted），attempts 钱字段 → charge_id；与视频广场负责人对齐后做                                                                                                                    | 是   | 需要     |
| 6b-5 | 消费记录统一从 `usage_charges` 读；`wallet_ledger.reference_id` 统一指向 charge                                                                                                                                                    | 是   | 需要     |

每步按"扩展 → 后端发布 → 两次采样确认旧读写停涨 → 收缩"；纯数据库内的子步（6a-1）一个迁移完成。

## 6a-1：请求表测速列清理（不新建表）

逐列核对后，原计划的 `ops.chat_generation_timings` 不需要：

| 列                                                                                  | 近 7 天       | 真实用途                                                                                                                                           | 去向 |
| ----------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `primary_timeout_ms`、`timeout_rate_target`、`fallback_timeout_ms`                  | 每行都有      | 开轮时冻结的请求参数；`fallback_timeout_ms` 还参与开轮函数的重放身份校验                                                                           | 留   |
| `fallback_triggered_ms`                                                             | 7781 行       | 与兜底调用行同锁写入；畅聊模型评估（`primary_wait_ms`）据此判断"报错转兜底"                                                                        | 留   |
| `first_token_emitted_ms`、`client_request_dispatched_ms`、`client_wait_finished_ms` | 0（10-29 起） | 后端已不写/不上报                                                                                                                                  | 删   |
| `client_first_token_received_ms`、`client_backgrounded`、`client_reported_at`       | 4.4–4.7 万行  | 只被首字视图输出、再被已退役的 `chat_first_token_report` 读；客户端首字、渲染延迟、切后台已由 Faro `roleplay.first_token` / `roleplay.render` 记录 | 删   |

`report_chat_first_token` 判断"是否在后台"用的是本次上报参数（`p_report->>'backgrounded'`），不读列；门禁、交付仲裁、取消都不读这 6 列。前端照旧上报，后端照旧透传，函数只是不再落库。

### 迁移（一个文件，纯数据库，不需要后端发布）

1. 锁外守卫：`report_chat_first_token` 里要改的那段原文恰好出现一次（已改过则跳过）；`chat_first_token_facts` 的输出列集合与生产 11-19 一致；依赖它的只有 `free_zone_turn_facts`；`chat_first_token_report` 存在则必须是生产正文（md5 `eab9f5f4…`）。
2. 锁内（一个 DO 块、一次往返；`lock_timeout 5s`）：锁两个视图与请求表 → 改 `report_chat_first_token`（按原文替换那条 UPDATE 的列清单，`pg_get_functiondef` 改写，保留 OID/属主/授权）→ 删 `chat_first_token_report` → 删并按生产定义重建两个视图（去掉 `client_backgrounded`、`client_request_dispatched_ms`、`client_first_token_received_ms`、`first_token_emitted_ms`、`client_server_residual_ms`、`client_display_delay_ms`、`client_wait_finished_ms` 7 个输出列），恢复授权（`service_role`、`first_token_metrics_reader` 只读）→ 删请求表 6 列 → 收尾守卫：没有函数正文再引用这 6 个列名 → `NOTIFY pgrst`。
3. 可重跑：列已删、函数已改、视图已是新形状时整段跳过。

### 核对

- 本地 PG17（非超级用户）：生产形状的夹具 + 生产函数正文（md5 校验）；改前改后同一组首字上报场景（observed / 超时 / 重放 / 可恢复交付的迟到上报 / 真实服务端超时释放免费额度）返回值、请求行保留列、额度收口调用一致；两个视图保留列逐行一致；锚点不匹配时整体拒绝且不留改动；重跑无变化。
- TEST → 生产；生产上线后：新轮次首字上报正常（`client_outcome` 分布连续）、畅聊模型评估每 30 分钟无报错、Grafana 01 看板畅聊两块面板有数、`chat_first_token_report` 删前再采样一次确认 grafana_cloud 调用数不涨。

### 6a-1 上线结果（11-19）

- PR #961（设计 + 迁移）；TEST 06:16、生产 06:18（北京时间）执行。生产 NOTICE：函数已改、两个视图已重建、6 列已删，首字视图近 1 天（1 小时以前）6830 行改动前后指纹一致。
- 执行前三次采样（05:55 / 06:20 / 06:25）grafana_cloud 对首字视图与报告函数都是 52 条语句、111 次，没有新调用。
- 生产核对：`report_chat_first_token` md5 与本地测试改后一致（`ecdab7e1…`）；报告函数已删；首字视图 49 列，授权（service_role、first_token_metrics_reader 只读）与 `security_invoker=false` 照旧；`free_zone_turn_facts` 近 1 天 5207 行可读。上线后新轮次首字上报、交付正常；主服务迁移后无报错。
- 第一次在 TEST 触发 workflow 时 `migration_file` 只写了文件名，被参数校验挡下（未连库）；该参数要写完整路径 `packages/shared/migrations/…`。

## 6a-2 细化（11-19 逐列核对后）

### 读者核对

- `chat_generation_attempts` 测速列：`dispatch_offset_ms / first_token_ms / observed_until_ms` 是畅聊模型评估（`primary_wait_ms`、`primary_observed_until_ms`）与 Grafana 01（`free_zone_turn_facts.primary_ttft_ms`）的输入，**留**；`headers_ms / first_chunk_ms / http_status / provider_latency_ms / provider_latency_scope（常量）/ provider_name / provider_reported_model` 只被首字视图输出、视图这些输出列已无读者（报告函数已删），后三个还与 OpenRouter 明细重复，**删**；`discarded_response`（落败调用片段，兼做 observe 的终态守卫）随明细一起迁 `ops.llm_calls.discarded_detail`。
- 三张供应商明细表在数据库里没有函数/视图读用量列（Surplus 的 `buyer_cost_micro / provider_name / prompt_tokens / cached_tokens` 进 `free_zone_turn_facts`；OpenRouter/Venice 的 `usage` 进看板日汇总）。后端读法：
  - `listRowsPendingBilling`（openrouter/venice）与 `listRowsMissingProviderIdentity`：**把明细表当交付身份**（`llm_generation_id`、两表互斥），经 PostgREST 外键嵌入；Surplus 版 `listSurplusRowsPendingBilling` 嵌入 Surplus 明细与请求表。
  - `OpenRouterChatHistoryRepository`：开轮占位 + 写 generation_id（`ensurePlaceholder / ensureGenerationId`，与交付仲裁里的插入重复）、`readGenerationDataBatch` 给回捞判断"元数据是否齐全、finish_reason 是什么"、`listRowsMissingGenerationData` 扫明细不全的行。
  - `free-zone/call-costs.ts` 读 Surplus 明细的 `request_id`。

### 拆步（替换原 6a-2a~d）

| 步    | 内容                                                                                                                                                                                                                                                                  | 后端发布 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 6a-2a | attempts 删 7 个无读者列：后端 `enrichGeneration` 只补 `finish_reason` → 发布 → 两次采样确认旧 UPDATE 停涨 → 迁移改 `observe_chat_generation_attempt`、重建首字视图（去掉对应输出列）、删列                                                                           | 需要     |
| 6a-2b | 交付身份只认 attempts：回捞的待结算/缺身份扫描改读"交付调用"（`requests.delivery_attempt_id` → attempts 的 provider 与 generation_id，用一个只读 RPC 一次取回，不靠外键嵌入）；后端不再写明细占位与 generation_id；`select_chat_generation_delivery` 不再往明细表插行 | 需要     |
| 6a-2c | 建 `ops.llm_calls`（主键 = attempt id）：三张明细的用量/原始数据、`discarded_response`、`free_zone_calls` 成本列迁入；Surplus 请求记录补查 → `ops.llm_cost_jobs`；回捞读元数据、看板日汇总、畅聊两个视图、成本补查改读 ops；删三张明细表                              | 需要     |
| 6a-3  | 语音 `latency_ms` → `ops.media_generation_calls`（配图看 4b）                                                                                                                                                                                                         | 需要     |

6a-2b 动的是结算回捞的"找哪些轮次要结算"，金额与扣费函数不变；仍按 6b 的对账口径前后各跑一次 R1/R2。

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

- 6a-1 删 `chat_first_token_report`：生产执行前再采样一次，确认 grafana_cloud 调用数不涨。
- 6b-3 聊天配图、6b-4 广场租约：等 4b / 4c 决定。
- `usage_charges` 里 `free` 状态的行（每周约 1.1 万）是否永久保留，6b-1 定稿时按消费记录是否展示免费轮再定。
