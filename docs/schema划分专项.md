# Schema 划分专项：miniapp 表盘点与 chat_history 字段审计

> 时间：2026-08-21。上游文档：`docs/ST_remove-Supabase瘦身专项.md`（粗粒度删除已收口，086–091 已执行）。
> 本文档是列级瘦身阶段的前置盘点，覆盖两件事：
> ① `miniapp` schema 下每张表的核心含义、代码依赖、表间依赖；
> ② `miniapp.chat_history` 的字段级审计与无用字段清单。
>
> **取证方式**：表结构 / FK / 触发器 / 函数体 / 列注释 / 逐列非空统计来自 **test 库
> （`zoqelpfhurwehlvypryl`）2026-08-21 实测**（086–091 之后两库 miniapp 结构已对齐）；
> 生产侧行数与列级非空数引用瘦身专项 2026-08-20 的生产实测。代码依赖来自全仓库检索
> （`.from()` / `.rpc()` / raw SQL / Prisma model，排除 migrations、docs、tests）。
> **凡是要执行删除动作，仍须按瘦身专项的规矩在生产库复核一遍再动手。**
>
> 边界：`miniapp_analytics` / `miniapp_traffic` / `cs_platform` 本轮继续不碰；
> `public` / `analytics`（旧 bot）为 B 类，不得触碰。
>
> **执行进展（2026-08-24）**：sync-job 过滤条件已止血；migration 092 已删掉
> `user_character_round` / `preset_id` / `llm_model_markup` 三列，**test 库已执行并核对，
> 生产待执行**（见 §2.4）。`chat_history` 现为 29 列。

---

## 一、miniapp schema 全景（22 表 + 1 视图）

实测 22 张表 + 1 个视图（`current_chat_history`），与生产 091 之后的形态一致。
按业务域分组如下。「代码依赖」列的是运行时的写/读入口，不含回归测试脚本
（`scripts/mvp-regression/` 会读写其中大部分表，属测试工具，不单列）。

### 1.1 用户与账户域

| 表                      | 核心含义                                                                                                                                   | 代码依赖                                                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                 | miniapp 用户主表（`tg_id` 唯一键、渠道 `source_id`、累计轮次 `total_round`；`st_handle` / `st_initialized_at` 为 ST 遗留列，列级瘦身待办） | Prisma `MiniappUser`；`lib/user.ts`（找回/创建用户，**唯一的 `st_handle` 写入方**）；`routes/growth.ts` miniapp-entry 写 `source_id` / `miniapp_entered_at`；RPC `increment_user_total_round`；触发器 `trg_miniapp_new_user_wallet_bonus`（插入时建钱包并发注册奖励） |
| `miniapp_user_settings` | 用户资料与偏好（TG 昵称/头像、自定义头像、字数偏好、自定义指令；镜像一份 `total_round`）                                                   | `MiniappUserSettingsRepository`（读写均走它）                                                                                                                                                                                                                         |
| `user_wallets`          | 钱包余额（`main_credits` / `bonus_credits`，`total_credits` 为生成列；首充/累充统计）                                                      | `MiniappWalletRepository`；余额变动全部经 RPC（见下）                                                                                                                                                                                                                 |
| `wallet_ledger`         | 钱包流水账（`entry_type` 六种；余额快照 + reference 溯源）                                                                                 | 只由库内 RPC 写入：`deduct_wallet_credits` / `complete_payment_order` / `claim_daily_checkin` / `grant_new_user_signup_bonus` / `charge_llm_usage` / `complete_wish_role`，以及运营台补发额度 RPC                                                                     |
| `daily_checkins`        | 每日签到记录（每行一次签到 + 奖励额度）                                                                                                    | RPC `claim_daily_checkin`；`MiniappWalletRepository` 读签到状态                                                                                                                                                                                                       |
| `payment_orders`        | TG Stars 充值订单（状态机 pending → paid/expired，`credits_added` 防重）                                                                   | `MiniappPaymentOrderRepository`；RPC `complete_payment_order` / `expire_payment_orders` 入账                                                                                                                                                                          |

### 1.2 角色卡与大厅域

| 表                                    | 核心含义                                                                                                                          | 代码依赖                                                                                                                                                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `characters`                          | 角色卡主表（chara_card_v2 全字段 + `raw_card`；`enabled` / `sort_order` / `archived_at` 控制上架；`last_listed_at` 记录最近曝光） | 后端 `CharacterCardRepository`；运营台角色卡管理与布局发布（admin RPC 读写）；触发器 `trg_characters_track_listing` 维护 `last_listed_at`。**生产 pg_cron job 5 每小时读 `id/name/sort_order/enabled/is_test/archived_at` 做卡位快照——列级动它前先处理 job（瘦身专项 §4）** |
| `character_favorites`                 | 用户收藏角色卡（user × character 唯一）                                                                                           | `MiniappCharacterFavoriteRepository`；RPC `set_character_favorite` / `list_character_favorites` / `get_character_favorite_counts`                                                                                                                                           |
| `character_ranking_scores`            | 大厅「推荐」排序 v3 的得分缓存表（074），定期从 `chat_history` 聚合重算                                                           | `features/lobby/ranking-stats.ts` 全量重写（INSERT/DELETE）；大厅推荐排序读取                                                                                                                                                                                               |
| `character_free_chat_quotas`          | 每用户 × 角色的免费对话余量                                                                                                       | `MiniappCharacterFreeQuotaRepository`；RPC `reserve_character_free_chat_round` / `finalize_character_free_chat_round`                                                                                                                                                       |
| `character_free_chat_quota_decisions` | 免费额度判定的逐次审计（reserve/finalize 全记录）                                                                                 | 同上（只写，排障用）                                                                                                                                                                                                                                                        |

### 1.3 对话链路域（核心）

| 表                             | 核心含义                                                                                                                                                              | 代码依赖                                                                                                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat_sessions`                | 自研引擎会话头：标题、置顶、软删除 `deleted_at`、统计缓存（`message_count` / `last_message_at` / `last_message_preview`）、上下文窗口起点 `context_window_start_turn` | `ChatSessionRepository`；RPC `start_chat_history_turn` / `start_chat_history_regeneration` / `guard_chat_session_idle` / `apply_context_window_flood`；统计缓存由 `chat_history` 上的触发器回写                                                                        |
| `chat_history`                 | **项目核心资产**：逐轮生成日志，一行 = 一个 turn 的一个 revision（ST 存量行无 session 三元组）。字段级审计见 §2                                                       | 写：RPC 起行 → `ConversationHistoryRepository.setPromptHistory/finalizeTurn` → `chat-history-logger.ts` 补计费与 LLM 元数据 → `chat-history-sync-job.ts`（30s 轮询）补拉 OpenRouter 数据；读：`ConversationHistoryRepository`（经视图）、`lobby/ranking-stats.ts` 聚合 |
| `current_chat_history`（视图） | `chat_history` 的「当前版本」投影：每 (session_id, turn_index) 取最大 revision，透传全部 32 列                                                                        | `ConversationHistoryRepository` 的上下文装配 / 消息分页 / 语音取正文均走它                                                                                                                                                                                             |
| `chat_message_audio`           | 语音消息产物（每条 assistant 回复的 TTS 结果，存 `miniapp-chat-voice` 桶，表存元数据）                                                                                | `ChatMessageAudioRepository`（voice 功能）                                                                                                                                                                                                                             |

### 1.4 LLM 计费域

| 表                       | 核心含义                                                                                                                 | 代码依赖                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm_usage_charges`      | 每轮 LLM 用量计费明细与状态机（pending → charged/waived；固定档扣费口径的 calculated/charged 金额、汇率、markup 全在这） | RPC `charge_llm_usage` / `reconcile_llm_usage`（由 logger 与 sync-job 经 `MiniappWalletRepository` 调用）；触发器 `trg_prepare_llm_usage_charge`（幂等预处理）与 `trg_retain_recent_llm_usage_charges`（超出每用户保留上限时压缩为墓碑） |
| `llm_usage_charge_dedup` | 计费幂等墓碑：明细被保留策略清掉后仍保住 `charge_key` 防重                                                               | 只由上面的 retention 触发器写入                                                                                                                                                                                                          |

### 1.5 运营与消息域

| 表                      | 核心含义                                                                     | 代码依赖                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `runtime_config`        | 全局 KV 配置（充值方案、免费额度参数、文案、模型档位等），带 `version`       | `platform/runtime-config.ts`（统一读口）、`payment/rechargeRules.ts`、`billing/free-quota.ts`；运营台配置管理 RPC 写入         |
| `notifications`         | 消息中心站内信（系统通知 + 运营外呼；`created_by` 指向运营者）               | `routes/notifications.ts`（列表/已读）；`lib/notifications.ts`（支付成功等系统通知写入）；运营台外呼补发 RPC（066）写入        |
| `notification_reads`    | 用户 × 通知的已读状态                                                        | `routes/notifications.ts`                                                                                                      |
| `support_conversations` | 客服会话头（每用户的求助会话）                                               | `routes/support.ts`（miniapp 侧）；运营台客服模块经 admin RPC 处理，`agent_user_id` 落客服身份                                 |
| `support_messages`      | 客服会话消息（用户与客服双向）                                               | 同上                                                                                                                           |
| `wish_roles`            | 许愿池：用户许愿新角色卡（`status` 状态机 awaiting_extra → …，完成时发奖励） | `MiniappWishRoleRepository`；RPC `create_wish_role` / `complete_wish_role`（奖励走 `wallet_ledger`，entry_type `wish_reward`） |

### 1.6 表间依赖（FK 实测，共 30 条）

`users` 是全 schema 的根：除 `characters`、`runtime_config`、`llm_usage_charge_dedup` 外，
**其余每张业务表都有 FK 指向 `miniapp.users(id)`**，且几乎全部 `ON DELETE CASCADE`
（`wish_roles.db_user_id` 为 SET NULL）。删除一个用户会级联清掉其钱包、流水、订单、签到、
会话、聊天记录、语音、收藏、额度、通知与客服记录。

`characters` 是第二枢纽，被 6 张表引用，删除方向各不相同——这是改角色卡数据时的主要风险面：

| 引用方                                                                                                                    | 删除行为                             |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `chat_sessions.character_id`                                                                                              | **RESTRICT**（有会话的角色卡删不掉） |
| `chat_history.character_id`                                                                                               | SET NULL                             |
| `character_favorites` / `character_free_chat_quotas` / `character_free_chat_quota_decisions` / `character_ranking_scores` | CASCADE                              |

对话链路内部的链：`chat_history.session_id → chat_sessions`（SET NULL）；
`chat_message_audio` 同时挂 `chat_history`、`chat_sessions`、`users`（全 CASCADE）。
计费链：`llm_usage_charges.debit_ledger_id → wallet_ledger(id)`（无级联，流水不可删）。

**跨 schema 依赖（列级瘦身时的库内隐形消费方）**：

- `miniapp.notifications.created_by` 与 `miniapp.support_messages.agent_user_id` → `admin.admin_users`（miniapp → admin 方向的 FK）；
- `admin` schema 的存量 RPC（角色卡管理、外呼、客服、配置）直接读写 `miniapp.characters` / `notifications` / `support_*` / `runtime_config` / `wallet_ledger`；
- 生产独有：pg_cron job 5 读 `miniapp.characters`（见 1.2）；`public.compute_daily_metrics` / `public.show_dashboard` 反向读 `miniapp.chat_history`（job 2/3 已停用但函数仍在，bot 迁出时的待断点）；`miniapp_analytics` 的 9 个视图建在库内、不在迁移里，**动 `chat_history` / `characters` 列之前必须在生产逐个核对视图定义**。

触发器全景（6 个，均已在上文各表提及）：`users` 1 个（注册礼）、`characters` 1 个（曝光时间）、
`chat_history` 2 个（轮次计数、会话统计回写）、`llm_usage_charges` 2 个（计费幂等、保留策略）。

---

## 二、chat_history 字段级审计

审计时为 32 列，092 之后为 29 列。生命周期回顾：RPC `start_chat_history_turn` / `start_chat_history_regeneration` 先落
「streaming 行」（只有 id/user/model/user_input/session 三元组/status）→ 生成结束
`finalizeTurn` 写回复与终态 → `chat-history-logger.ts` 异步补计费结果与 OpenRouter 元数据 →
`chat-history-sync-job.ts` 对 24h 内元数据不全的行每 30s 轮询补拉。

非空统计口径：test 库全量 792 行 / 其中自研行（`session_id IS NOT NULL`）388 行，2026-08-21 实测；
生产引用瘦身专项 2026-08-20 的「最近 5000 行」实测。

### 2.1 在用字段（15 个，动不得）

| 字段                                     | 业务含义                                                            | 依赖                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                     | 主键                                                                | 全链路；`chat_message_audio` FK                                                                                                                                                                 |
| `user_id`                                | 归属用户                                                            | FK CASCADE；ranking 聚合                                                                                                                                                                        |
| `session_id` / `turn_index` / `revision` | 自研会话三元组：会话、逻辑轮次、重生成版本（ST 存量行为 NULL）      | RPC 起行与并发闸门；`current_chat_history` 视图的去重键；ranking 按 (session, turn) 去重                                                                                                        |
| `model`                                  | 请求时选择的模型 id（NOT NULL）                                     | 前端消息的 `model_id`；计费入参                                                                                                                                                                 |
| `user_input`                             | 用户输入原文                                                        | 上下文装配、重生成取词、会话预览触发器                                                                                                                                                          |
| `assistant_reply`                        | 助手回复正文                                                        | 上下文装配、消息列表、语音取正文、会话预览触发器                                                                                                                                                |
| `history`                                | 本轮完整 prompt 快照（jsonb）                                       | **只剩一个读取点**：开场白提取（turn 1 的快照）与上下文装配的 opening 兜底。同时它是 **10 GB 中 97% 的来源（TOAST 9.9 GB，均值约 55 KB/行）**——列级瘦身主战场，处置方案单独立项，本文档不给结论 |
| `character_id`                           | 角色卡外键                                                          | 轮次触发器、ranking 聚合、FK SET NULL                                                                                                                                                           |
| `status`                                 | 行状态机：streaming / success / upstream_error / stream_interrupted | 并发闸门 `guard_chat_session_idle`、前端消息状态映射、计费闸门                                                                                                                                  |
| `created_at`                             | 落行时间                                                            | 排序、sync-job 24h 窗口、ranking 时间窗                                                                                                                                                         |
| `llm_finish_reason`                      | 流结束原因（stop/length/…）                                         | 计费闸门（只有 stop 扣费）、前端展示、sync-job 完整性判定                                                                                                                                       |
| `llm_generation_id`                      | OpenRouter Generation ID                                            | sync-job 补拉数据的钥匙                                                                                                                                                                         |
| `llm_charge_id`                          | 关联 `llm_usage_charges.charge_key`                                 | sync-job 对账（pending → 终态）的钥匙                                                                                                                                                           |

### 2.2 字段级审计全表（其余 17 列）

「状态」列标 **✅ 092 已删** 的三列见 §2.4。

| 字段                                                                  | 业务含义                         | 写入方                                                                    | 读取方                                                                                      | 非空情况（test 自研 388 行 / 生产近 5000 行） | 状态        |
| --------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------- |
| `preset_id`                                                           | ST 时代的预设外键                | `execute.ts` 透传 `GenerationRequest.presetId`，自研链路恒为 null         | 无                                                                                          | **0 / 0**                                     | ✅ 092 已删 |
| `llm_usage_cache`                                                     | 缓存 Token 节省金额              | logger / sync-job 写 OpenRouter `usage_cache`，实际恒为 null              | 无（sync-job 的误用已在 2026-08-24 摘除，见 §2.3 附带发现）                                 | **0 / 0**                                     | A 档待删    |
| `upstream_status`                                                     | 上游 HTTP 状态码（仅出错时有值） | `finalizeTurn` / logger                                                   | 无业务读取（回归脚本断言用）                                                                | 24 / —（错误行才有）                          | 建议保留    |
| `deduction_rate`                                                      | 本轮实际扣除星尘数               | logger / sync-job（对账后回写）                                           | 无业务读取；口径与 `llm_usage_charges.charged_amount`、`wallet_ledger` 重复                 | 388（默认 0）                                 | 见 §2.5     |
| `user_character_round`                                                | 用户 × 角色累计交互轮次          | 触发器 `tf_set_user_character_round`（**每次 insert 做一次 MAX+1 聚合**） | 无（ranking 注释里明确弃用它）                                                              | 388                                           | ✅ 092 已删 |
| `llm_intended_deduction`                                              | 应扣金额（余额不足时与实扣分离） | logger / sync-job                                                         | 无业务读取；等值数据在 `llm_usage_charges.calculated_amount`，但**该表有保留上限，见 §2.5** | 380                                           | 见 §2.5     |
| `llm_model_markup`                                                    | 计费加成倍数快照                 | logger                                                                    | 无业务读取；等值数据在 `llm_usage_charges.model_markup`                                     | 359                                           | ✅ 092 已删 |
| `llm_provider_name`                                                   | OpenRouter 实际路由的底层厂商    | logger / sync-job                                                         | 无                                                                                          | 337                                           | B 档待议    |
| `llm_usage`                                                           | 本次调用实际成本（USD）          | logger / sync-job                                                         | 无业务读取（计费用的是 API 返回的内存值，不回读列）；sync-job 过滤条件判 null               | 337                                           |
| `llm_native_tokens_prompt` / `_completion` / `_reasoning` / `_cached` | 原生 Token 四件套                | logger / sync-job                                                         | 无                                                                                          | 各 337                                        |
| `llm_latency`                                                         | 首字延迟 ms                      | logger / sync-job                                                         | 仅 sync-job 过滤条件判 null                                                                 | 337                                           |
| `llm_generation_time`                                                 | 生成总耗时 ms                    | logger / sync-job                                                         | 仅 sync-job 过滤条件判 null                                                                 | 337                                           |
| `llm_model`                                                           | OpenRouter 实际使用的模型        | logger / sync-job                                                         | 无业务读取（改名路由判定用内存值）                                                          | 337                                           |
| `llm_generation_data`                                                 | Generation 完整原始 JSON         | logger / sync-job                                                         | 仅 sync-job 过滤条件判 null                                                                 | 337，**单列体积大户候选**                     |

### 2.3 无用字段清单

**A 档 · 死字段（零读取 + 两库实测恒空，可直接进删除清单）**

| 字段              | 摘除时必须连带处理                                                                                                                            | 状态   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `preset_id`       | `GenerationRequest.presetId` 参数、`execute.ts` 透传、`ConversationHistoryRow` / 回归脚本的字段声明、视图重建（`ST_remove.md` §6 已有此待办） | ✅ 092 |
| `llm_usage_cache` | logger 与 sync-job 的写入行、`isCompleteGenerationData` 判定、视图重建（`.or()` 过滤已先行摘除）                                              | 待删   |

**B 档 · 只写不读（数据非空，删除等于放弃审计/观测数据，需产品拍板）**

按「删了损失什么」分三组：

1. **计费口径重复组**（等值数据已在 `llm_usage_charges` / `wallet_ledger`）：
   `llm_model_markup`（✅ 092 已删）、`deduction_rate`、`llm_intended_deduction`。
   **后两者的结论已细化，见 §2.5——「损失最小」对 `llm_intended_deduction` 不成立。**
2. **LLM 观测指标组**（唯一存放处，删了就没有历史观测数据；但从未有读取入口）：
   `llm_provider_name`、`llm_usage`、`llm_latency`、`llm_generation_time`、`llm_model`、
   `llm_native_tokens_prompt` / `_completion` / `_reasoning` / `_cached`、
   以及体积上最值得优先处理的 `llm_generation_data`
3. **独立评估组**：
   - `user_character_round`（✅ 092 已删）：删列同时卸掉了每次 insert 的 MAX+1 聚合触发器
   - `upstream_status`：错误诊断的唯一落点，量极小，建议保留

**附带发现（操作性 bug，与删字段直接相关）**：`llm_usage_cache` 恒为 null，
使 sync-job 的「元数据不全」过滤条件对 24h 窗口内**所有**有 generation_id 的行永远成立——
这些行每 30 秒被重复拉取 OpenRouter API 一遍直到滚出 24h 窗口。
**已于 2026-08-24 摘除**（`chat-history-sync-job.ts` 的 `.or()` 不再含 `llm_usage_cache.is.null`）。
`isCompleteGenerationData()` 里同源的 `usage_cache !== 'undefined'` 判定仍在，它只影响日志
计数（`completedCount` 恒为 0），不触发重复拉取，随 A 档删列时一起摘。

---

### 2.4 migration 092 执行记录（2026-08-24）

删 `user_character_round` / `preset_id` / `llm_model_markup` 三列。
文件：`packages/shared/migrations/092_chat_history_drop_dead_columns.sql`。

| 项             | 内容                                                                                                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 连带删除       | 触发器 `trg_set_user_character_round` + 函数 `tf_set_user_character_round`；索引 `idx_chat_history_character_user_round`（随列自动消失，大厅排序走 `idx_chat_history_character_user_created_at`，不受影响）                                                          |
| 视图           | `current_chat_history` 定义是 `SELECT *`、列已固化，必须先 DROP 再按 073 原样重建（含 `security_invoker`、grants、comment），重建后自动收敛为 29 列                                                                                                                  |
| 代码侧停写     | `GenerationRequest.presetId` 参数链（`types.ts` / `execute.ts` / `generate.ts`）、`chat-history-logger.ts` 的 `preset_id` 与 `llm_model_markup`、`ConversationHistoryRow`、回归脚本字段声明与 `normalizeHistory`                                                     |
| 回归脚本换水位 | `waitForChatHistory` 原先用 `llm_model_markup !== null` 判断 logger 是否写完，改用 `llm_intended_deduction`（`llm_charge_id` / `llm_finish_reason` 不可用：它们在更早的 `finalizeTurn` 就已写入）。「耗尽后按固定档位计费」断言改读 `llm_usage_charges.model_markup` |
| test 库        | ✅ 已执行并核对：29 列、三列消失、触发器与索引消失、视图 29 列可查；单测 213 项全绿；真实数据库 MVP 回归 7/7 通过                                                                                                                                                    |
| 生产库         | ⏳ **待执行**。执行前必须先跑迁移头部的三条核对 SQL：test 库没有 `miniapp_analytics` 的 9 个视图、没有 `cron`、`public` 函数数也不同，**这些只能在生产查**。预期只命中本迁移处理的两个对象；多出任何一个就停下来                                                     |

### 2.5 deduction_rate 与 llm_intended_deduction：产销与去留

两列都**只有写入方、没有业务读取方**，但结论不同——差别在于「等值数据是否长期存在」。

|            | `deduction_rate`                                                                                                 | `llm_intended_deduction`                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 含义       | 本轮**实扣**星尘                                                                                                 | 本轮**应扣**星尘（余额不足 / 非计费终态时与实扣分离）                    |
| 类型       | `numeric(14,1)` DEFAULT **0**                                                                                    | `numeric(10,2)` DEFAULT **NULL**                                         |
| 产生方     | `chat-history-logger.ts`（写 `charge_llm_usage` 返回的 `charged_amount`）；`chat-history-sync-job.ts` 对账后回写 | 同左，写 `billingDecision.amount`（固定档口径下即 `calculated_amount`）  |
| 消费方     | 无业务读取。仅回归脚本 `normalizeHistory` 作观测输出                                                             | 无业务读取。**092 之后新增一个**：回归脚本用它作 logger 完成水位（§2.4） |
| 库内等值列 | `llm_usage_charges.charged_amount`                                                                               | `llm_usage_charges.calculated_amount`                                    |

**关键差异：`llm_usage_charges` 有保留上限。** 触发器 `retain_recent_llm_usage_charges`
只保留每个用户最近 **100** 条完整计费行，更早的行被压缩进 `llm_usage_charge_dedup`，
而 dedup 只留 `charge_key / generation_id / user_id / charged_amount / status / processed_at`
——**`charged_amount` 活下来了，`calculated_amount` 没有。**

test 库实测（742 行带 `llm_charge_id`）：完整计费行仍在的 513 条，**已被压缩进 dedup 的 218 条**，
两边都查不到的孤儿 11 条。也就是说：

- `deduction_rate` 可以经 `llm_charge_id = charge_key` 从 `llm_usage_charges` 或 dedup **恢复**；
- `llm_intended_deduction` 一旦对应计费行被压缩，就是**应扣金额的唯一存放处，删了不可恢复**。
  「本月因余额不足 / 非计费终态放弃了多少收入」这类问题只能靠它回答。

**结论**：

- **`llm_intended_deduction` 不建议删。** 它是唯一存放处，且已被回归脚本用作完成水位。
- **`deduction_rate` 可删，但收益接近零，建议连着 B 档一起处理、不单独排期。**
  理由：① 体积上是定长 numeric，18 万行合计约 1–2 MB，对 10 GB 无意义；
  ② 它和其他列在 logger 的**同一条 UPDATE** 里写出，删了不省任何一次查询
  （这点和 `user_character_round` 不同——那列删掉能卸掉一个 per-insert 聚合触发器）；
  ③ 真正的删除理由不是省空间而是**消除双份记账**：`deduction_rate` 的 DEFAULT 0 会把
  「未扣费」「logger 还没写」「写失败」三种情况混成同一个 0（上面那 11 条孤儿就是活样本），
  日后有人拿 `chat_history` 算收入必然算错。

**执行顺序建议**（更新）：A 档剩下的 `llm_usage_cache` → B 档 LLM 观测指标组
（优先 `llm_generation_data`，它是这批里唯一有体积意义的）+ `deduction_rate` 同批。
每步仍按瘦身专项的规矩：先 test 后 production，逐库核对结果形态。
