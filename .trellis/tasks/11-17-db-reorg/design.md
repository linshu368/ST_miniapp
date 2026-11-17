# 设计：数据库契约与分阶段重组

规则与目标结构见 `docs/db/CONTRACT.md`。每张表的去向与阶段见 `docs/db/registry.yaml`。本文只写**顺序、风险、外部协同和验证**。

## 现状证据（2026-11-17，生产只读结构 + origin/dev 92d05b27）

- 12 个带对象的 schema，ARCHITECTURE 的地图只覆盖 9 个；本仓库拥有 95 张表。
- 字段插入重灾区（迁移中累计加列）：
  - `chat_history`：28 列，10 次迁移，23 GB；
  - `payment_orders`：16 列；
  - `miniapp_user_settings`：16 列，10 次；
  - `chat_message_audio`：12 列；`chat_message_images`：10 列，共 46 列；
  - `chat_generation_requests`：8 列，共 34 列。
- 同一类"上游调用记录"分散在 5 张表：`chat_generation_attempts`、3 张供应商表、`free_zone_calls`。
- `admin` 有 24 个 `*_before_*` 包装函数（每加一个 managed key 包一层）。
- 外部读者：
  - 客服仓库运行时读 7 张表（users、miniapp_user_settings、user_wallets、payment_orders、vip_memberships、chat_sessions、chat_history）；
  - 两个旧客服角色 `cs_outreach_reader_v1`、`cs_persona_reader` 对几乎全库有 SELECT；
  - Grafana 读 `analytics_grafana`；指标读者直接读 `experience.chat_generation_requests`。
- 计费耦合：`billing.chat_delivery_billing_gate`、`experience.report_chat_first_token`、`experience.select_chat_generation_delivery` 读写 `chat_history` 的计费列和 `chat_generation_requests` 的交付列。这些列名字像测速，实为计费依据，在 registry 中标了 `billing_input`。

## 阶段总览

| 阶段 | 内容                                                                                                                           | 动钱         | 风险  | 外部协同          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | ------------ | ----- | ----------------- |
| 0    | 契约、registry、AGENTS 落位卡、契约 lint（警告）                                                                               | 否           | 低    | 无                |
| 1    | 地基与清理：建 `ops`、`cs_feed`；客服切视图并收回旧授权；`analytics_grafana` 并入；删死表、死列、死配置、包装链                | 否           | 低-中 | 客服仓库、Grafana |
| 2    | 观测外迁：所有 O 进 `ops`；上游调用合并为 attempts（身份）+ `ops.llm_calls`（明细）                                            | 间接         | 中    | Grafana、指标读者 |
| 3    | 用户与状态拆分：users / settings / characters 拆分，`user_marks`、`user_chat_stats`、`user_attributions`、`character_listings` | 否           | 中    | 客服视图同步      |
| 4    | 任务字段外迁：各 `*_jobs` 表                                                                                                   | 支付对账间接 | 中    | 无                |
| 5    | 对话热表瘦身：`history` 进 `chat_prompt_snapshots`；`first_token_preview` 进交付表；`drive_mode` 改真列                        | 否           | 中-高 | 无                |
| 6    | 计费统一：`billing.usage_charges` 收编 4 处计费字段和报价；删 dedup 压缩                                                       | 是           | 高    | 客服视图、看板    |

**为什么这样排序**：

- 先建地基（`ops`、视图层），后搬数据，这样搬的时候外部不受影响。
- 先搬不碰钱的，最后统一钱。
- 阶段 2 先把上游调用"身份"和"明细"拆开。这样阶段 6 计费只依赖身份（experience），不依赖 `ops`。

## 每阶段通用执行纪律

1. 每个阶段一个子任务（`--parent 11-17-db-reorg`），各自写 design / implement，并过规划门禁（mobile_performance、logging_integration）。
2. migration 一次一个文件，测试库验证后再执行生产；生产执行沿用 `Database Migration` workflow。
3. **非资金数据**走最简路径：
   - 新表 + 数据搬运 + 改代码 + 删旧列，放在同一次发布；
   - 不双写，不留兼容视图（外部读者除外，外部读者走 `cs_feed` / `miniapp_analytics`）；
   - 出问题 forward-fix。
4. **资金数据**（阶段 4 的支付对账、阶段 6 全部）：
   - 先建新表并回填；
   - 对账脚本逐条核对新旧一致后再切读写；
   - 旧列保留一个观察窗口再删；
   - 回滚说明写到"恢复到旧列读写"的粒度。
5. 发布顺序：
   - 结构变化：迁移先于后端，后端先于前端；
   - 删旧列：后端切读新表并确认生产无旧列读写之后，用单独的 migration 删。
6. 每阶段完成，同一个 PR 回写 registry：被迁移的表改为 `active` 或删除条目，目标表从 `planned` 改为 `active`。

## 阶段要点

### 阶段 0：契约（PR #870，已含 lint）

- 文档：`docs/db/CONTRACT.md`、`docs/db/registry.yaml`、AGENTS 落位卡，旧 spec 和 ARCHITECTURE 改为指针。Claude Code 已会加载 AGENTS.md，不另建 CLAUDE.md。
- lint：`scripts/db-contract-lint.mjs`（`pnpm lint:db-contract`）。
  - CI 中只查相对 base 新增或修改的 migration，按 CONTRACT §7 规则对照 registry；
  - 输出 GitHub Actions `::warning` 注释；脚本自身故障也只告警，退出码恒为 0；
  - 已接入 `Quality Gate`；固定样例测试见 `scripts/db-contract-lint.test.mjs`。
  - 对 11 月存量 migration 试跑，命中的正是本任务要拆的插入点（供应商表、free_zone_calls、drive_mode 加列等），无误报。

### 阶段 1：地基与清理

- `ops` schema：service_role 读写；Grafana 与指标读者不授权，只通过 `miniapp_analytics` 视图读。
- `cs_feed` 视图：按客服仓库实际读取的列建 5 个视图，授权给 `cs_runtime_v1`。客服仓库改为读视图并上线后：
  - 收回 `cs_runtime_v1` 对业务表的直接 SELECT；
  - 确认 `cs_outreach_reader_v1`、`cs_persona_reader` 没有使用者后，撤销或删除这两个角色。
- `analytics_grafana` 的视图和物化视图移到 `miniapp_analytics`（`ALTER ... SET SCHEMA`），授权同步。用 Grafana MCP 批量改面板 SQL，前后对比面板数值。
- `miniapp_analytics.drama_survey_responses` 移到 `miniapp_features`。
- `botlinks` 两个大写列改为小写。
- 删除：
  - `users.st_handle` / `st_initialized_at`；
  - `wish_roles`（先导出归档）；
  - `cs_platform`（所有者 2026-11-17 已确认可删；先导出归档）；
  - 空的 `miniapp`、`public` 残留函数；
  - runtime_config 中确认无人读取的 key（registry `drop_candidates` 逐个复核）。
- `admin` 包装链：建 `admin.managed_config_keys(key, value_kind, …)` 登记表，`is_managed_config_key` / `validate_managed_config_value` 改为查表，删除 24 个 `*_before_*`。

### 阶段 2：观测外迁

- 建 `ops.llm_calls`（attempt*id 主键）、`ops.llm_cost_jobs`、`ops.chat_generation_timings`、`ops.media_generation_calls`、`ops.payment_events`、`ops.alert*\*`、`ops.drama_playback_observations`、`ops.free_zone_events`。
- 上游调用合并：
  - 畅聊多路调用写入 `experience.chat_generation_attempts`，补 candidate_id 和 slot 列；
  - 3 张供应商表和 `free_zone_calls` 的明细、成本写入 `ops.llm_calls`；
  - `select_chat_generation_delivery`、`conversation-history-billing`、`surplus-billing-recovery`、`free-zone/call-costs` 改为从 attempts 读身份。
- `chat_generation_requests` 的纯测速列移到 `ops.chat_generation_timings`。动手前逐列对照三个读取函数确认，以函数为准，不以列名为准。
- 看板与指标视图在 `miniapp_analytics` 中改为读 `ops`；`first_token_metrics_reader` 收回对 `experience` 的直接授权。
- 核对：迁移前后同一时间窗的首字 P95、超时率、畅聊成本、支付告警，数字一致。

### 阶段 3：用户与状态拆分

- `miniapp_user_settings` 拆成 4 份：
  - 资料列移到 `app_core.users`；
  - 偏好列保留，整表改名为 `app_core.user_preferences`；
  - 一次性标记移到 `miniapp_features.user_marks`（由 `growth_prompt_states` 泛化）；
  - `total_round` 移到 `experience.user_chat_stats`（和 users 那份合并）。
- `users` 的归因列移到 `miniapp_traffic.user_attributions`。
- `characters` 的上架列移到 `app_core.character_listings`。
- 同步改：Prisma 模型、`claim_instruction_slot_modes`、`share_image_plaza_artifact`、邀请轮数奖励函数、`cs_feed` 视图、分析视图。

### 阶段 4：任务字段外迁

- 建 `experience.chat_image_jobs`、`media_plaza.image_plaza_jobs`、`billing.payment_reconcile_jobs`，照 `story_memory_jobs` 的领取/提交模式。
- 支付对账属于资金相邻改动：先双读核对一个对账周期，再删旧列。

### 阶段 5：对话热表瘦身

- `chat_history.history` 移到 `experience.chat_prompt_snapshots`。
  - 13 个 RPC 引用这一列，逐个改；
  - 搬运按批次在线执行，避免长锁 23 GB 表；
  - 删列后 `VACUUM FULL` 或 `pg_repack`，需要评估窗口。
- `first_token_preview` 移到 `chat_generation_requests`；`rich_reply_metadata.drive_mode` 改为真列。
- 核对：消息列表、重生成、分叉、展示回填的人工场景；发送与列表接口的 P95。

### 阶段 6：计费统一（单独详细设计，所有者评审后才执行）

- 设计 `billing.usage_charges`：
  - 一次可计费动作一行；
  - 记录 feature 与引用、价格快照、生命周期 quoted → reserved → charged / waived / refunded、debit_ledger_id。
- 收编：
  - `llm_usage_charges`（我方成本列移到 `ops.llm_calls`）；
  - `chat_history` 的 4 个计费列；
  - audio、images 各 12-13 个计费列；
  - `image_plaza_attempts` 计费列；
  - `image_plaza_quotes`。
- 改写：`chat_delivery_billing_gate`、`charge_llm_usage`、`select_chat_generation_delivery`、语音、图片、广场结算 RPC，以及 Surplus 结算恢复。
- 先回填，再逐条对账（新旧扣费金额、状态、流水 id 完全一致），然后切换，旧列观察期结束后删除。删除 `llm_usage_charge_dedup`。

## 候选项（不在本任务范围，需单独评估）

- 角色卡内容统一：官方卡读 `characters` 的内容列，创作卡读 `character_versions`。改为"内容一律进版本表，`characters` 只留身份和当前版本指针"，会触及生成引擎取卡逻辑。

## 风险与停止条件

- 任一阶段核对时，扣费、余额、看板数字出现不一致 → 停止该阶段发布，先查清原因。
- 客服仓库没切到 `cs_feed` 之前，不搬客服读取的表（阶段 3、6 依赖阶段 1 的客服切换）。
- 23 GB 表的搬运和清理必须先在测试库实测耗时与锁，再定生产窗口。
