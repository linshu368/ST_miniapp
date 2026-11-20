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
6. 视频生成（视频广场，`media_plaza.video_*`）：用户 11-19 定**直接并入**统一计费，不再等视频广场负责人或其消费记录任务（`.trellis/tasks/11-18-video-spending-records`）对齐；动 media_plaza 前仍先看最近提交与 PR，避免冲突。**短剧（drama）是另一个模块，长期不收费，不在计费统一范围内**，别和视频生成混淆。

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
| 6b-4 | 图片广场与视频生成：报价表 → `usage_charges`（status=quoted），attempts 钱字段 → charge_id，租约列拆到任务表（4c 并入此步）；不再等视频广场负责人，直接做                                                                          | 是   | 需要     |
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

### 6a-2a 上线结果（11-19）

- PR #963（后端 + 迁移）→ 发布 #964（只带 `GenerationObservationRepository.ts` 与其集成测试；第一次只带运行文件，集成测试旧调用写法导致发布分支类型检查失败，补带测试文件后通过）→ 同步 #965。Railway 6 个应用服务 06:41 部署到 `fcfbdd47`，无报错。
- 旧 UPDATE（`finish_reason` + 三个供应商列）发布后两次采样（06:45、07:02）都是 35170 次不再增长，新 UPDATE（只写 `finish_reason`）同期 2 → 10。
- TEST 07:02、生产 07:41 执行迁移（中间因额度暂停）。生产 NOTICE：observe 已改、两个视图已重建、7 列已删；首字视图近 1 天 6823 行改动前后指纹一致。生产 observe md5 与本地测试改后一致（`3a7ef089…`），首字视图 35 列，授权与 reloptions 照旧。

### 6a-2b 方案与核对（11-19）

- 新只读函数 `experience.list_chat_settlement_candidates`：四种扫描（openrouter / venice / surplus / missing_identity）的筛选与旧后端一致，身份只取交付调用；后端三个扫描改调它，删 `surplus-billing-recovery.ts`，单测改测"RPC 行 → 回捞行"映射与冲突判定，筛选语义由 PG17 测试覆盖。
- 生产只读对照（近 7 天 47674 个有报价的轮次，不看是否已结算）：新旧候选集合、计费供应商、冲突判定一致；唯一差别是 21 个没被交付的 Surplus 落败调用不再带落败 generation_id（均未成功、未扣费）。生产 EXPLAIN 约 18ms。
- 近 7 天另有 34 个已结束未结算的轮次（OpenRouter 24、Surplus 10），回捞只看 24 小时，超窗的会一直挂着——6b-1 改成 `usage_charges.status='pending'` 扫描时一并处理。
- 留给 6a-2c：OpenRouter 元数据补齐扫描（`listRowsMissingGenerationData`）仍从 OpenRouter 明细取 generation_id、用 Venice 明细是否存在判冲突；`select_chat_generation_delivery` 仍往明细表插行。

### 6a-2b 上线结果（11-19）

- PR #967（后端 + 迁移）；TEST 08:05、生产 08:06 先执行只读函数（只授 service_role）；发布 #968（带 `backend/src/infrastructure/repositories/` 下 5 个文件，含测试）08:12 合并，Railway 6 个应用服务部署到 `45ee55f5`，无报错；同步 #969。
- 发布后两次采样（08:18、08:27）：四条旧的嵌入扫描（62986 / 62986 / 62985 / 25566）不再增长；OpenRouter 元数据补齐扫描按设计继续（6a-2c 改）；新函数 108 次、平均约 22ms。
- 部署后 6 个有报价的轮次全部结算（2 个实扣），没有未结算积压。

## 6a-2c 设计：`ops.llm_calls`（11-19 采集）

### 现状

| 来源                                          | 行数（能对上交付调用 / 10-23 前旧行）         | 写入方                                                                                                    | 读取方                                                                                                                  |
| --------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `experience.openrouter_chat_history`          | 3.6 万 / 33.7 万（7–10 月，原始数据约 110MB） | 交付仲裁插身份行；结算 `OpenRouterChatHistoryRepository.upsert`；回捞补齐 `updateKnownGenerationMetadata` | 回捞 `readGenerationDataBatch`（判断元数据是否齐全）、`listRowsMissingGenerationData`（补齐扫描）；看板日汇总读 `usage` |
| `experience.venice_chat_history`              | 2172 / 2772                                   | 交付仲裁插身份行；结算 `VeniceChatHistoryRepository.upsert`                                               | 看板日汇总读 `llm_usage`（÷1e6）                                                                                        |
| `experience.surplusintelligence_chat_history` | 3.4 万 / 0（全部 11 月，含落败调用）          | `prepare_ / record_surplusintelligence_call`、`claim_surplusintelligence_request_record`                  | `free_zone_turn_facts`、`free-zone/call-costs.ts`（request_id）、Surplus 请求记录补查                                   |
| `miniapp_features.free_zone_calls`            | 2.6 万 / 0（全部 11 月）                      | `free-zone/call-ledger.ts`（Prisma）、`call-costs.ts` 成本补查                                            | `free_zone_call_costs` 视图                                                                                             |
| `chat_generation_attempts.discarded_response` | 近 7 天 4843 行                               | `observe_chat_generation_attempt`（兼终态守卫）                                                           | 无                                                                                                                      |

### 目标形状

```text
ops.llm_calls(
  id uuid PK,                 -- = chat_generation_attempts.id；10-23 前的旧明细行沿用原行 id
  attempt_id uuid UNIQUE,     -- 旧行为空
  chat_history_id uuid NOT NULL,
  provider text NOT NULL,     -- openrouter / venice / surplus
  generation_id text, request_id text,
  provider_name text, model text, finish_reason text, call_status text, error_code text, http_status int,
  prompt_tokens bigint, completion_tokens bigint, cached_tokens bigint, reasoning_tokens bigint,
  cost_usd numeric, cost_source text,       -- OpenRouter usage / Venice usage÷1e6 / Surplus buyer_cost_micro÷1e6
  latency_ms numeric, generation_time_ms numeric,
  raw_request jsonb, raw_usage jsonb, discarded_detail jsonb,   -- 键在 registry 登记
  created_at, updated_at
)
ops.llm_cost_jobs(call_id PK, kind, status, attempts, next_retry_at, updated_at)   -- Surplus 请求记录补查、畅聊成本补查
```

保留 180 天（旧行到 2027 年初自然清掉）；与 5b 的 prompt 快照清理合成一个 `ops` 每日清理任务。后端写读都走 `experience` 下的 RPC（`ops` 不对 PostgREST 暴露，照 4a 的 `billing.record_payment_event` 做法）。

### 拆步

| 步      | 内容                                                                                                                                                                                                                                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6a-2c-1 | 建 `ops.llm_calls`；OpenRouter / Venice：结算与回捞补齐改调 `record_llm_call_metadata`（按交付调用定位 attempt）、回捞读 `read_llm_call_metadata`、补齐扫描并入 `list_chat_settlement_candidates`（新扫描 `openrouter_metadata`）；看板日汇总改读 ops；交付仲裁不再插明细行；旧明细按批复制（含 10-23 前旧行）→ 收缩删两表 |
| 6a-2c-2 | Surplus：`prepare_ / record_` 写 ops，请求记录补查状态进 `ops.llm_cost_jobs`，`free_zone_turn_facts` 与 `call-costs.ts` 改读 ops → 收缩删表                                                                                                                                                                                |
| 6a-2c-3 | 畅聊调用成本：`free_zone_calls` 的成本列进 `ops.llm_calls` / `ops.llm_cost_jobs`（调用身份是否并入 attempts 届时再定：attempts 现在每轮最多 primary + fallback 各一，畅聊是多路多槽）；`discarded_response` 迁 `discarded_detail`，observe 的终态守卫改看 `end_reason`                                                     |

每步：扩展（建表/RPC/双写或回填）→ 后端发布 → 两次采样确认旧读写停涨 → 收缩。看板日汇总在每步前后对比近 14 天的 `recorded_cost_usd` / `known_cost_requests` 一致。

### 6a-2c-1 上线结果（11-19）

- PR #972（扩展迁移 + 后端）→ TEST 08:50、生产 08:52 扩展：复制 OpenRouter 374131 行、Venice 4944 行（38432 行对上交付调用），近 14 天成本新旧逐项一致（OpenRouter 24646 行 / 89.212002 美元，Venice 627 行 / 1.579572 美元）；`ops.llm_calls` 265MB。
- 发布 #973（`backend/src` 下 14 个文件）08:57 合并，Railway 6 个应用服务部署到 `2877f4c2`、无报错；同步 #974。两次采样（09:03、09:09）旧的明细表 PostgREST 读写全部不再增长，新 RPC 写入 18 → 46、读取与缺口扫描 11 → 23。
- 收缩 #975：TEST 09:10、生产 09:11 执行。第一段改交付仲裁（不再插明细行）与看板日汇总（成本读 `ops.llm_calls`）；第二段补复制 29 行增量，43984 个已结算轮次成本新旧逐轮一致，删两张明细表。生产函数 md5 与本地测试一致，没有函数再引用旧表，迁移前后主服务无报错。
- 发现：Venice 目录单价是每百万 token，`llm_usage` 一直存的是微美元（看板 ÷1e6 抵消）；`ops.llm_calls` 统一存美元，后端注释已写明。

### 6a-2c-2 设计：Surplus 明细（11-19 采集）

- `experience.surplusintelligence_chat_history`：3.4 万行（全部 11 月），每轮一行、对应一次 Surplus 调用（`attempt_id` 外键 → attempts，`chat_history_id` 唯一），20 多个列约束；请求参数 / 响应元数据合计约 72MB。
- 写入方全在数据库：`prepare_surplusintelligence_call`（建行、冻结请求参数）、`record_surplusintelligence_call`（补 generation_id / 用量 / 成本 / 请求记录状态，交付仲裁也调它）、`claim_surplusintelligence_request_record`（请求记录补查的领取与退避）。三个函数正文都带 `\r\n`。
- 读取方：后端 `SurplusIntelligenceChatHistoryRepository` 经 PostgREST 读 4 处（prepare 后回读请求参数、补 generation_id 后回读、补查候选扫描、按需读响应元数据）；`free-zone/call-costs.ts`（Prisma）读 `request_id`；视图 `free_zone_turn_facts`（Grafana 01）读 `provider_name / buyer_cost_micro / prompt_tokens / cached_tokens`。
- 列去向：调用事实进 `ops.llm_calls`（`buyer_cost_micro ÷ 1e6` → `cost_usd`，`cost_source = 'surplus_buyer'`；`usage_usd` 另存；`request_parameters` → `raw_request`、`response_metadata` → `raw_usage`；`metadata_capture_status` 进 `call_status` 旁的新列或 `raw_usage` 元信息，实现时定）；请求记录补查状态（`request_record_status / attempts / next_retry_at`）进 `ops.llm_cost_jobs`。

做法（与 2c-1 不同：写入方都在库里，过渡期用触发器镜像，三个函数在过渡期不动）：

1. 扩展：补齐 `ops.llm_calls` 缺的列、建 `ops.llm_cost_jobs`；旧表加 AFTER INSERT/UPDATE 触发器，把每次写入镜像到 ops（同事务）；复制存量；新 RPC：回读请求参数 / generation_id、补查候选扫描、读响应元数据（都读 ops）。
2. 后端发布：4 处 PostgREST 读改走 RPC；`call-costs.ts` 改查 `ops.llm_calls`。
3. 两次采样确认旧表 PostgREST 读停涨。
4. 收缩：三个函数改为直接写 ops（按原文替换表名与列名，或整体重写并守卫生产 md5），`free_zone_turn_facts` 改读 ops，删触发器与旧表（同 2c-1 分两段事务）。

### 6a-2c-2 上线结果（11-19）

- PR #978（扩展迁移 + 后端）→ TEST 01:58、生产 02:00 扩展：复制 Surplus 34312 行调用、34312 行补查任务，买方成本 19.730074 美元新旧一致；旧表加镜像触发器，三个写入函数未动。
- 发布 #979（Surplus 仓库 4 处读改走 RPC、`call-costs.ts` 改查 ops）02:04 合并，Railway 6 个应用服务部署到 `60981bb1`、无新增报错；同步 #980。确认旧表 PostgREST 读停涨后收缩。
- 收缩 #981：TEST 02:24、生产 02:26 执行。三个函数守卫为生产原文后改为直接读写 `ops.llm_calls` + `ops.llm_cost_jobs`，`free_zone_turn_facts` 改读 ops；自检 34344 行在 ops 里相同或更新后删镜像触发器、触发器函数与旧表。
- 核对（05:14）：旧表、触发器函数已不存在，没有函数或视图再引用旧表；三个函数 md5 与迁移文件一致；收缩后新增 Surplus 调用 123 次，全部有补查任务、成本均已补齐；`free_zone_turn_facts` 正常出数；主服务唯一报错是剧情记忆压缩 too_long，与本次无关。

## 6a-2c-3 设计：每次模型调用一行 + 逐次成本（11-19 采集；用户要求推广到全部模型）

用户 11-19："目前只有畅聊有成本列，后面想把所有模型调用的成本机制都搞出来——收费模型也有兜底，单次调用成本对业务分析有重要价值。"原计划只把畅聊成本列挪进 ops，现扩为全部调用。

**要交付的指标（用户口径）**：每轮成本 = 这一轮所有上游调用的成本之和，包括首发和兜底，也包括没交付、被取消的调用，统一换成美元。不分供应商，不需要业务方看供应商明细；按供应商分别补成本只是内部实现。

- 看板按日给"每轮平均成本"（收费轮、畅聊分开，可按模型下钻），并附"每轮里兜底带来的额外成本占比"。
- 每次调用一行、按供应商补成本，都是为了把这个数算准。

### 现状（生产只读）

- 畅聊：`miniapp_features.free_zone_calls`（13MB，约 2.75 万行，Surplus 1.8 万 / OpenRouter 0.95 万）每个槽位一次调用一行（`UNIQUE (chat_history_id, role, slot)`），读写全在后端 Prisma（`free-zone/call-ledger.ts` 插入；`free-zone/call-costs.ts` 每 10 分钟补成本）。补成本规则：
  - Surplus 按 `request_id` 对账单（`surplus_bill` / `surplus_bill_matched`）；
  - OpenRouter 查 generation（每轮最多 60 次，单条最多 8 次）；
  - 拿不到的按同类均价估（`estimated`，`cancelled` / `first_token_deadline` 单独算均价），最后 `unavailable`。
  - 只有分析视图 `free_zone_call_costs` / `free_zone_turn_costs` 读它。
- 收费轮：`chat_generation_attempts` 每轮最多主 + 兜底各一次。`ops.llm_calls` 只有交付调用的元数据（OpenRouter / Venice）和 Surplus（每轮一行，唯一索引 `llm_calls_surplus_turn_idx`）。**没交付的调用没有成本**：被取消的 OpenRouter 兜底 2420 次、OpenRouter 主 1542 次、Venice 456 次都没有 `llm_calls` 行，每轮实际成本被低估。
- 落败片段 `attempts.discarded_response`：7369 行 / 554KB。`observe_chat_generation_attempt` 以它非空作终态守卫。

### 目标

- **`ops.llm_calls` = 每次上游调用一行**：收费轮每个 attempt（id = attempt id）加畅聊每个槽位（id = 原 free_zone_calls.id）。
  - 新增列：`lane`（chat / free_zone）、`role`（primary / fallback）、`slot`、`candidate_id`、`dispatched_at`、`end_reason`、`delivered`。
  - Surplus 每轮唯一索引限定 `lane = 'chat'`（畅聊每轮多路多槽）。
- **`ops.llm_cost_jobs` 通用化**：
  - `kind` 加 `call_cost`；状态 pending / complete / estimated / unavailable；带次数上限与退避。
  - 畅聊的 `cost_attempts`、`cost_source IS NULL` 语义迁入这里。
- **成本补查任务通用化**：从 `free-zone/call-costs.ts` 抽到 generation 域，覆盖两条通道。
  - Surplus 走账单；OpenRouter 走 generation，与 sync-job 的元数据补齐合用预算。顺带修复：约 106 个 OpenRouter 轮次永远缺 `finish_reason`，一直占着每轮 9 次的预算。改为成本拿到即完成，`finish_reason` 不再作为补查条件。
  - Venice 交付调用用 usage，未交付按估价；估价按 provider × 模型 × 结束原因的同类均价。
- **分析视图**：
  - `miniapp_analytics.llm_call_costs`：每次调用一行。
  - `llm_turn_costs`：每轮合计，拆主 / 兜底、交付 / 未交付。
  - 畅聊两个视图改读它们；Grafana 加"单次调用均成本 / 每轮成本"面板。
- **落败片段**：`discarded_response` 迁到 `ops.llm_calls.discarded_detail`，observe 的终态守卫改看 `end_reason`。

### 文本对话模型调用的逻辑归一化（11-19 用户补充："顺便对文本对话场景下模型的调用做逻辑归一化"）

现状是同一件事好几套写法：

- **调用记录**：收费轮 Surplus 走 `prepare_/record_surplusintelligence_call`（建行时冻结请求参数），OpenRouter / Venice 由 sync-job 事后补元数据（`record_llm_call_metadata`），畅聊另写 `free_zone_calls`（Prisma）。
- **成本**：
  - 收费轮：Surplus 取响应里的 `buyer_cost_micro`（`surplus_buyer`），OpenRouter 取 generation（`openrouter_usage`），Venice 取 usage（`venice_usage`）；
  - 畅聊：Surplus 对账单（`surplus_bill*`），OpenRouter 查 generation，其余估价或标 `unavailable`。
- **补查任务**：sync-job（结算 + 元数据缺口 + Surplus 请求记录）与 `free_zone_call_costs` 两个任务、两套预算。缺口定义里的 `finish_reason IS NULL` 让永远缺它的 OpenRouter 轮次一直占预算。

发调用与首发/兜底竞速已是同一模块（`first-token-fallback.ts`），两条通道共用，不动。

归一化后：

1. **一个入口记账**：竞速模块每次调用结束都发 `onCallSettled`（现在只有畅聊接），改为所有轮次都接，统一写 `ops.llm_calls`。每次调用一行：
   - 代表 attempt 的那一路（胜出者，或全部失败时最后结束的那一路，即竞速模块里的槽位归属）沿用 attempt id 那一行；
   - 其余并发路另起一行（`attempt_id` 为空）。
   - Surplus 的预备/记录函数照旧写同一行（它们与结算、请求记录补查绑定，不动），只是不再是唯一的 Surplus 入口。
2. **一个成本口径（11-19 用户补充："确实不返回的可以不计算，尤其 Surplus，本来就便宜，不影响大局"）**：
   - Surplus：只用响应里的 `buyer_cost_micro`（`surplus_buyer`）；没返回的标 `unavailable`、汇总按 0。**不再拉 Surplus 账单对账**，补查任务也就不依赖 Surplus 用量接口。
   - OpenRouter（兜底几乎都是它，且贵）：
     - 交付调用用 generation 元数据（`openrouter_usage`）；
     - 未交付但有 generation_id 的去查（`openrouter_usage`，次数记 `ops.llm_cost_jobs` kind `call_cost`，上限 8 次）；
     - 中途停下（`cancelled` / `first_token_deadline`）又查不到的，按近 7 天同类已知成本的均价记 `estimated`（沿用畅聊现行规则）；
     - 一发出就失败的标 `unavailable`。
   - Venice：交付调用用 usage（`venice_usage`），未交付的 `unavailable`（量小，约 250 次/周）。
   - `cost_source IS NULL` 表示待补，补查只看最近 7 天；历史数据照搬现有成本，不重算。
3. **一个补查任务**：畅聊的 `call-costs` 抽到 generation 域，覆盖全部通道，只保留 OpenRouter 查询与估价两条路。sync-job 只留与扣费相关的部分（结算回捞、Surplus 请求记录）。元数据缺口去掉 `finish_reason` 条件，修预算被占满的问题。
4. **一个分析口径**：`miniapp_analytics.llm_call_costs`（每次调用）/ `llm_turn_costs`（每轮总成本 = 首发 + 兜底全部调用之和）；畅聊两个视图改为它们按 lane 过滤的子集。

历史合并（只读核对，11-19）：

- 畅聊旧表与 attempt 按 generation_id 一一对上（带 generation_id 的 100% 唯一匹配）；不带的，绝大多数轮次该角色只有一路；剩约 340 个有歧义的 attempt 本身没有成本，不影响每轮合计。
- 两边都有成本时：OpenRouter 8494 条完全一致；Surplus 10561 条里 82 条不同（账单比响应报告少 0.037 美元），按账单为准。

### 拆步

| 步          | 内容                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3a 扩展     | `llm_calls` 加列与 lane、Surplus 唯一索引限 chat；`llm_cost_jobs` 通用化；复制 `free_zone_calls` 全部行（lane=free_zone，成本与补查状态照搬）；为近 7 天全部 attempts 补建调用行（已有行只补列；新行成本待补，7 天前不补）；`discarded_response` 复制到 `discarded_detail`；observe 函数在 attempt 首次观测时建调用行（按原文 md5 守卫） |
| 3b 后端发布 | `call-ledger` 写 `ops.llm_calls`；成本任务通用化覆盖收费轮；sync-job 预算修复；分析视图与 Grafana 面板                                                                                                                                                                                                                                   |
| 3c 收缩     | 删 `free_zone_calls`、`attempts.discarded_response`；observe 终态守卫换 `end_reason`；旧视图改读新视图                                                                                                                                                                                                                                   |

核对：

- 畅聊每轮成本新旧逐轮一致（`free_zone_turn_costs` 前后对比）；
- 收费轮交付调用的成本与看板日汇总一致；
- 未交付调用的成本单列新增，不进入扣费（只观测，不碰钱）。

### 6a-2c-3 上线结果（11-19～11-20，时间为 UTC）

- **扩展** `20261119_db_reorg_p6a2c3_call_ledger_expand.sql`：
  - 新增列、两个索引并发建（Surplus 唯一索引改为 `attempt_id IS NOT NULL`）、搬近 7 天收费轮调用与畅聊调用、复制落败片段，并建两个视图 `llm_call_costs` / `llm_turn_costs`。
  - 后端发布后 force_rerun 补搬增量：收费轮补 59 行、新建 1 行，畅聊并入 21523 行，落败片段 2 行。
- **后端** #1000、发布 #1001（11:21）、同步 #1003：所有轮次统一记账（`generation/call-ledger.ts`），补查任务移到 `generation/call-costs.ts`。`free_zone_calls` 11:22:38 停写，此后每轮都有调用行。
- **事故与热修** #1005：
  - 畅聊并发 Surplus 槽位让同一轮出现多条 Surplus 行，4 个按"轮次 + Surplus"取一行的函数报 P0003（11:22–11:27 共 16 次）。
  - 交付环节也调用了它，有 2 个畅聊轮次交付记录没存上，用户看到回复中断（畅聊免费、未扣费，收费轮不受影响）。
  - `free_zone_turn_facts` 重复计数。
  - 四个函数与视图加 `attempt_id IS NOT NULL` 后恢复，视图 41557 行 = 41557 轮。
  - 教训：放宽唯一索引前，先 grep 所有依赖"单行"语义的函数和视图。
- **收缩（一）** #1002（11:49）：
  - 删 `free_zone_calls`，畅聊两个视图改为新视图 `lane = free_zone` 的子集。
  - 停写前的 27672 行调用一一对应。成本合计新增 $0.087，来源两项：32 行由新任务补上成本（+$0.049）；82 次 Surplus 调用改用响应 buyer_cost、不再用账单匹配值（+$0.037）。
- **收缩（二）** #1004（11:58）：落败片段只写 `ops.llm_calls.discarded_detail`（observe md5 `00305dbb…`），补搬 2 条后删 `attempts.discarded_response`。片段 7377 → 7379。
- **日汇总口径**（11-20）：
  - #1008 / #1035：`refresh_grafana_core_day` 的成本改为每轮全部调用之和（同 `llm_turn_costs`），按轮次 id 关联，有调用待补的轮次不计已记录。补标窗口边缘残留 31 行，重刷 14 天。11-18 已记录成本由 $17.31（5615/7867 轮）变为 $28.84（7852/7867）。
  - #1035 的由来：生产执行前发现原补标条件会命中 7–8 月照搬的 5.4 万行历史调用，收窄后才执行。
  - #1036：重刷暴露实扣星尘取自"每用户只留 100 条"的扣费记录、一直少算，改取每轮 `deduction_rate`（14 天逐日与钱包流水一致）。
  - 生产核对：11-07～11-20 实扣星尘与扣星尘请求逐日等于钱包流水 `chat_debit / llm_usage`（如 11-19 28892 / 1896）；请求数、充值实收与改前相同。
- **Grafana 01**（第 12、13 版）：新增"每轮平均成本"面板，按天分收费聊天 / 畅聊，列出含估算与不含估算的每轮均价、首发 / 兜底拆分、超时兜底% / 报错兜底%、合计和待补轮次；顶部口径说明与今日成本卡片同步更新。11-19 收费聊天每轮 $0.0079（不含估算 $0.0047），畅聊 $0.0029（$0.0012）。

**待用户定：被取消的 OpenRouter 调用怎么估**（11-20 发现，暂按原规则运行）

- 现规则"停下查不到按同类均价估"取近 7 天停下且有真实成本的调用均价。样本只有 10 个，其中两个是 30 万 token 的超长输入，均价被拉到 $0.024–0.031，是兜底完整调用均价（$0.005）的 5～6 倍。
- 结果：收费聊天每轮成本里估算部分约占四成，扩展搬入的 970 个收费轮待补调用按 $0.031 估，合计 $30。
- 有真实成本的停下调用全是已吐出 token 的；首字前就取消的，OpenRouter 连续 8 次、跨 24 小时都 404，没有生成记录，很可能不计费。
- 被取消调用的真实花费约等于输入 token × 模型输入单价，例如 deepseek-v4.1-flash-1017 约 $0.30/百万。
- 两个选项：
  - (a) 首字前取消且查不到的记 unavailable，即不算；
  - (b) 按"本轮输入 token × 该模型单价"估，需归一带日期的模型名。
- 定了之后一条迁移即可重算估算行，估算值本来就是暂存。

## 6a-3：语音耗时列（11-20 核对后改为直接删列）

- 原计划把 `chat_message_audio.latency_ms` 挪进新建的 `ops.media_generation_calls`。聊天配图已下线，媒体调用观测只剩这一列。
- 核对：没有视图或函数读它，后端只写不读；耗时已经在后端日志 `voice.generate.done` / `voice.generate.failed` 等事件里。与 6a-1 同样处理：不建表，直接删列，登记表撤掉 `ops.media_generation_calls`。
- 写入方有两个语音扣费函数：`charge_voice_usage` / `settle_voice_generation` 会把 `p_metadata.latency_ms` 写回本列，只是赋值，与金额无关。
- 步骤：
  1. 后端停写，不再传这一列（发布）；
  2. 迁移去掉两个函数里的 4 处赋值（md5 守卫）；
  3. 提交后等 5 秒，再确认近 15 分钟无新写入、没有函数引用，然后删列。
- 验证：本地测试四条扣费路径（settle 付费、charge 付费、免费体验、免费体验无效），补丁前后的状态、扣费额、钱包、流水完全一致。

### 6a-3 上线结果（11-20，UTC）

- #1038（后端 + 迁移）、发布 #1040（07:45 合并，Railway `601eac66` 07:47 部署成功，旧部署下线）、同步 #1041。
- 迁移 TEST、生产执行（约 07:55）：两个语音扣费函数 md5 变为 `aaf7970d…` / `44fa84e5…`，`latency_ms` 已删，没有函数再引用。部署后生产 0 报错。
- 语音对账执行前后一致：近 14 天 4 笔、57 星尘，流水 = 语音表。

### 6b-0 对账基线（11-20 采集，11-07～11-20，上海时区，按流水日期分桶）

| 项 | 流水笔数 / 金额 | 业务表笔数 / 金额 | 不符天数 |
| --- | --- | --- | --- |
| R1 文本扣费（`chat_debit / llm_usage` ↔ `chat_history.deduction_rate`） | 14518 / 220888 | 14518 / 220888 | 0 |
| R3 语音扣费（`voice_usage` ↔ `chat_message_audio.debit_ledger_id`） | 4 / 57 | 4 / 57 | 0 |
| R4 图片广场扣费（↔ `image_plaza_attempts.debit_ledger_id`） | 143 / 13320 | 143 / 13320 | 0 |
| R4 分享返利（↔ `image_plaza_share_rewards.reward_ledger_id`） | 10 / 285 | 10 / 285 | 0 |
| R5 视频预留（↔ `video_attempts.debit_ledger_id`） | 7 / 700 | 7 / 700 | 0 |
| R5 视频退款（↔ `video_attempts.refund_ledger_id`） | 2 / 160 | 2 | 0 |
| R6 创作者分成（↔ `character_creator_rewards.grant_ledger_id`） | 5099 / 31534.8 | 5099 / 31534.8 | 0 |
| R7 退款（`wallet_refunds` ↔ 退款流水） | 2 / 160 | 2 / 160 | 0 |

- R2 免费额度：`character_free_chat_quota_decisions` 自 10-26 起没有新行。额度只对目录里标为免费的模型生效，10-26 后已没有这类模型，免费聊天改由畅聊承担（不扣费）。按设计停用，不涉及多收费。6b 时与用户确认是否退役这套额度（两张表、两个函数、一个配置 key）。
- 对账查询的写法：流水按 `created_at` 的上海日期分桶，业务表按流水 id（或 `llm_charge_id`）关联。6b 每步前后各跑一次，已结束的日子必须完全一致。

## 6b：`billing.usage_charges` 草案（6b-1 开工前定稿）

```text
billing.usage_charges(
  id uuid PK,                    -- 即 charge_id（文本沿用 llm_charge_id，语音沿用 audio id 作为幂等键）
  user_id uuid NOT NULL,
  kind text NOT NULL,            -- chat_text / chat_voice / plaza_image / plaza_video（聊天配图 11-19 下线）
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

### 6b-1 定稿草案（11-20 采集，待用户确认后开工）

**现状（生产只读）**

- 写入：`billing.charge_llm_usage`（16KB）、`reconcile_llm_usage`、`refund_llm_usage_charge`；`llm_usage_charges` 上有两个触发器：`prepare_llm_usage_charge` 写去重表，`retain_recent_llm_usage_charges` 每用户只留 100 条。
- 读方：
  - 门禁 `chat_delivery_billing_gate`；
  - 交付仲裁 `select_chat_generation_delivery`、开轮观测 `begin_chat_generation_observation`；
  - 结算回捞 `list_chat_settlement_candidates`、元数据缺口 `list_llm_call_metadata_gaps`；
  - 首字上报 `report_chat_first_token`、反馈 `save_chat_reply_feedback`、消息列表 `list_chat_message_page`；
  - 三个展示视图（`chat_history_display` / `session_chat_display` / `session_chat_history`）、看板日汇总；
  - 后端约 15 个文件：`MiniappWalletRepository` 消费记录，`conversation-history-*` 读写扣费额与快照，sync / recovery 任务。
- `chat_history` 上的 4 个计费列：
  - `deduction_rate`（实扣，= 钱包流水）；
  - `llm_billing_snapshot`（开轮冻结的报价）；
  - `llm_billing_settled_at`；
  - `llm_intended_deduction`：41 万行有值，**只写不读**。
- `llm_usage_charges` 12.5 万行，按状态：free 80391、charged 35034、historical 4977、failed 4408、pending 1654（07-26～09-29 卡住的遗留）、reconciled 53、partial 9。另有去重表 41 万行。
- 消费记录取每人最近 100 条、不按状态过滤，免费轮显示"本次免费"，所以免费行要保留。

**目标**

- 文本一轮 = `usage_charges` 一行：`kind = chat_text`、`id = llm_charge_id`、`subject_id = chat_history.id`。
- 开轮时建行，状态 `quoted`：`quote` 存冻结报价，原 `llm_billing_snapshot`；`quoted_credits` 存应扣，原 `llm_intended_deduction`。
- 结算后变为 charged / free / failed …，写 `charged_credits` / `debit_ledger_id` / `settled_at`。
- 永久保留，去掉去重表和"留 100 条"的触发器。
- `chat_history` 只留 `llm_charge_id`，`deduction_rate` 等改经视图 join 取得。

**拆步**（碰钱：每步前后跑 R1 并逐轮比对）

1. **6b-1a 扩展**：
   - 建表；
   - 回填：以 `chat_history`（全部有 `llm_charge_id` 的轮次）为主，补上 `llm_usage_charges` 的明细和流水 id；
   - 三个写入函数在同一事务里镜像写新表（守卫生产原文 md5）；
   - 核对：每一轮 `usage_charges.charged_credits` = `chat_history.deduction_rate`，去重表里每个 key 在新表都有行。
2. **6b-1b 读方切换**：门禁、交付、回捞、消费记录、视图、看板、反馈、消息列表，以及后端改读新表（发布）。
3. **6b-1c 收缩**：写入函数停写旧表和旧列，删两个触发器、去重表、`llm_usage_charges`，以及 `chat_history` 的 4 列。

**待用户确认**

- Q1 免费行永久保留（建议保留：行小，消费记录要展示）。
- Q2 遗留状态（pending 1654 / historical / reconciled / partial）原样迁移，不改金额（建议原样）。
- Q3 角色卡免费额度自 10-26 起停用（目录里没有免费模型），是否在 6b-1 一并退役两张表、两个函数和一个配置 key。

### 6b-1a 详细方案（11-20 生产只读核对后补充）

**三方关系核对**（`chat_history` 有 `llm_charge_id` 的 41.4 万轮 ↔ `llm_usage_charges` ↔ 去重表）：

- 能对上扣费记录或去重表的轮次，`charged_amount` = `deduction_rate` 全部一致；付费轮全部能对上，没有遗漏。
- 两边都没有记录的 9013 轮全是 0 扣费：8449 轮已结算（免费或失败）；562 轮未结算，其中 390 中断、139 报错、31 成功，另有 2 轮正在进行。
- 没有对应轮次的扣费记录 5216 条：historical 4977（7 月）、failed 229、free 9、charged 1。它们会出现在消费记录里，要迁移。
- 只在去重表、也没有对应轮次的 key 12344 个：historical 11287、failed 1031、free 23、charged 3。

**回填映射**（每个 `llm_charge_id` / `charge_key` 一行，`kind = chat_text`）：

| 来源 | status | charged_credits | 其他 |
| --- | --- | --- | --- |
| 有扣费记录 | 原 status | `charged_amount` | 型号、汇率、加价、初始额、计算额、兜底、元数据进 `quote.charge`；`debit_ledger_id`；`reconciled_at` |
| 只在去重表 | 去重表 status | 去重表 `charged_amount` | `debit_ledger_id` 从流水按 `reference_id` 找 |
| 两边都没有、已结算 | free（扣费为 0） | 0 | — |
| 两边都没有、未结算、超过 1 天 | 失败轮记 failed，成功轮记 free | 0 | `quote.legacy = 'unsettled_no_charge'` |
| 两边都没有、未结算、1 天内 | quoted | 0 | 结算时由镜像触发器更新 |

- 有轮次的行另写：`subject_id = chat_history.id`；`quote.snapshot = llm_billing_snapshot`；`quoted_credits = llm_intended_deduction`；`settled_at = llm_billing_settled_at`。
- 没有轮次的行 `subject_id` 为空（软引用，只为保住消费记录和幂等）。

**镜像（过渡期，同事务）**：

- `llm_usage_charges` AFTER INSERT/UPDATE → upsert 新表的扣费字段；
- `chat_history` AFTER INSERT/UPDATE OF 4 个计费列和 `llm_charge_id` → upsert 新表的报价、实扣、结算时间；
- 不镜像删除："留 100 条"的删除不影响新表。

不改 16KB 的 `charge_llm_usage`，三个写入函数原样不动。

**核对**：

- 回填后每一轮新表 `charged_credits` = `deduction_rate`；
- 扣费记录、去重表的每个 key 在新表都有行；
- R1 按日一致；
- 镜像运行一天后再比一次。

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
- 6b-3 不做（聊天配图 11-19 下线）；6b-4 图片广场与视频生成都直接做（含 4c 租约列），不再等视频广场负责人。短剧不收费、不在范围内。
- `usage_charges` 里 `free` 状态的行（每周约 1.1 万）是否永久保留，6b-1 定稿时按消费记录是否展示免费轮再定。
