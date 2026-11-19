# 阶段 5 设计：experience.chat_history 瘦身

## 现状（生产只读核对，11-19；只看结构与聚合）

### 体积与增长

- 约 42 万行；堆 617MB、TOAST 23GB、索引 259MB，总 24GB（整库 26GB）。
- `history`（jsonb，发给模型的 messages）按 2% 抽样占列体积 95% 以上：均值约 53KB/行（压缩后），中位 37KB，最大 650KB。上下文越来越长：7 月均值 45KB，11-15 至 11-17 每行 100–117KB。
- 近几天每天新增 7–8.5 千行，`history` 每天新增 0.5–0.95GB，按此速度一个月约 20GB，是全库增长的主要来源。
- 累计更新是插入的约 15 倍（102 万 / 6.8 万），每轮要被多个写入方各改一次（开轮快照、首字预览、收口、计费、富回复诊断）。
- 7–8 月有约 11.3 万行没有 `session_id`/`turn_index`（会话功能之前的旧轮次），不进任何会话视图，只被统计读。

### 读写方

- 只有 `service_role`（后端经 PostgREST/RPC）读写。`postgres` 那几条是 Supabase 控制台浏览和统计任务；没有 pg_cron 任务读这张表；`cs_feed` 不读；Grafana 只经 `miniapp_analytics.chat_first_token_facts` 读 `id/status/llm_finish_reason`。
- 依赖它的视图：`current_chat_history` → `session_chat_history`（后端：改消息、长期记忆读轮次）；`chat_history_display` → `session_chat_display`（后端：上下文组装、当前轮）；`list_chat_message_page`（消息列表）读 `chat_history_display`。
- 进来的 FK 10 条（分叉、生成请求、展示投影、语音、配图、点赞、编辑覆盖、三张供应商明细）。触发器 5 个，其中 `trg_invalidate_chat_history_display`（`AFTER UPDATE OF history`）只为展示投影服务。

### `history` 的真实用途

1. 写：开轮 RPC 插入 `'[]'`；`begin_chat_generation_observation` 第一次调用写入只含 request_id 的标记（`[{role:system, content:'', request_id}]`），带计费快照的第二次调用写入完整 prompt。后端的 `setPromptHistory`/`setPendingRequestId` 已无调用方。
2. 读（数据库内）：`begin_chat_generation_observation` 比对已存标记的 request_id；同一个值也在 `chat_generation_requests.client_request_id`，函数里另有一条按它比对的检查。
3. 读（展示兜底）：`chat_history_display` 对没有展示投影（`chat_history_display_metadata`，v1）的行，现场从 `history` 前两条解析 request_id 与开场白。投影 11-11 上线后新轮次都有，**存量约 37 万行没有回填**，翻老会话时每行都要解压约 50KB。
4. 后端当前版本不再经 PostgREST 读 `history`（只读 `turn_index,user_input,assistant_reply` 等列）；pg_stat_statements 里带 `history` 列的 SELECT 是旧版本留下的累计数（发布前两次采样确认不涨）。离线脚本不读。

结论：补齐展示投影后，删掉 `history` 不改变用户看到的内容，也不改变扣费，按 CONTRACT §1.2 是 **O**，归 `ops`。registry 原计划的 `experience.chat_prompt_snapshots`（E）改为 `ops.chat_prompt_observations`。

### 其他列

- `first_token_preview`（jsonb `{kind,text}`）：`record_chat_delivery_preview` 写（同一函数已在更新 `chat_generation_requests.server_first_token_ready_ms`）；消息映射在 `assistant_reply` 为空时拿预览文本当正文显示（包括已失败的轮次，10 月起有 811 行），streaming 时显示推理预览。10 月起 6.1 万行，全部有对应的 `chat_generation_requests` 行（一一对应）。属交付状态（S）。
- `upstream_status`：最后一次写入 10-27，之后恒为 NULL；只出现在视图和消息列表的输出里，前端不读。死列。
- `rich_reply_metadata.drive_mode`：11-16 起写入（值 `active/follow/novel/plot`），只写不读；与 `choice/status/memory_rules_mode` 同为"这一轮用的指令档位"，按 registry 计划转真列。
- 索引：`idx_chat_history_user`（34MB）自统计重置 0 次扫描，与 `idx_miniapp_cohort_chat_user_created` 同列；`idx_chat_history_model`（53MB）只扫过 1 次。
- 计费 4 列：阶段 6 再迁（门禁、交付仲裁、Surplus 结算恢复都读）。

## 列分组与去向

| 列                                                                                                                                                                                                                                 | 性质        | 去向                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `id, user_id, session_id, character_id, turn_index, revision, model, user_input, assistant_reply, status, llm_finish_reason, created_at, postprocess_version, choice/status/memory_rules_mode, rich_reply_metadata, llm_charge_id` | E           | 留                                                                                        |
| `drive_mode`（新）                                                                                                                                                                                                                 | E           | 新真列，从 `rich_reply_metadata` 回填，jsonb 里去掉该键                                   |
| `history`                                                                                                                                                                                                                          | O           | `ops.chat_prompt_observations`（按保留期清理），主表列删除                                |
| `first_token_preview`                                                                                                                                                                                                              | S           | `experience.chat_generation_requests.first_token_preview`                                 |
| `upstream_status`                                                                                                                                                                                                                  | O（已不写） | 删除                                                                                      |
| `deduction_rate, llm_intended_deduction, llm_billing_snapshot, llm_billing_settled_at`                                                                                                                                             | M           | 阶段 6 → `billing.usage_charges`                                                          |
| 展示投影 `chat_history_display_metadata`                                                                                                                                                                                           | D → E       | `history` 删除后成为 request_id 与开场白的权威来源，不再可重建；去掉 `projection_version` |

## 新表

`ops.chat_prompt_observations`（O）：每个对话轮次发给模型的 messages，写一次。

- 列：`history_id uuid PK`（软引用 → `experience.chat_history`，按 CONTRACT §3 不建 FK）、`messages_snapshot jsonb NOT NULL`（数组）、`created_at timestamptz NOT NULL DEFAULT now()`；索引 `created_at`（清理用）。
- 写入方：`experience.begin_chat_generation_observation`（带计费快照、prompt 定稿那次调用；以 `service_role` 身份执行，授予 INSERT/UPDATE）。读者：人工排查（控制台），产品请求路径不读。
- 保留期与清理：**待用户决定**（见末尾），pg_cron 每天按批删除超期行。用户删号时主表级联删除，这里的快照随保留期过期清掉。
- 没有已有表维护同一事实（`ops.llm_calls` 是每次上游调用一行，阶段 6 才建；prompt 每轮一份，主备调用共用）。

## 方案

### 5a 扩展（不删数据，不依赖保留期决定）

1. 建 `ops.chat_prompt_observations`。
2. 按原文定位改 `begin_chat_generation_observation`（md5 守卫 `445ebf1f…`）：
   - prompt 定稿（带 snapshot）时写 `ops.chat_prompt_observations`（`ON CONFLICT DO UPDATE`，与原 UPDATE 语义一致：重放不改已定稿的计费快照），不再写 `chat_history.history`；只含标记的首次调用不写快照；
   - "已存 request_id 不同"的检查改读展示投影的 `request_id`；
   - 展示投影照旧从入参 `v_history` 推导（逻辑不变）。
3. `start_chat_history_turn` / `start_chat_history_regeneration` 的 INSERT 去掉 `history`（按原文替换，各恰好 1 处）；`history` 去掉 NOT NULL（只改目录）；删触发器 `trg_invalidate_chat_history_display` 与其函数（之后没人再写 `history`，留着会让 5b 的清空把投影标成失效）。
4. 展示投影回填：存量有会话标识、没有 v1 投影的约 26 万行，按批（每批 100 个 id，调用既有 `backfill_chat_history_display`，逐批 COMMIT）。完成后所有会话轮次都走投影，`chat_history_display` 的兜底分支不再被命中。
5. `chat_generation_requests` 加 `first_token_preview jsonb`（CHECK 与原列一致），按批回填 6.1 万行；`record_chat_delivery_preview` 两边都写（发布窗口里旧后端直接读主表列）；`list_chat_message_page` 与两个会话视图的 `first_token_preview` 改从 `chat_generation_requests` 取（输出列名不变，后端无感）。
6. `chat_history` 加 `drive_mode text`（CHECK `^[a-z][a-z0-9-]{0,31}$`，与偏好列一致，只改目录），按批从 `rich_reply_metadata->>'drive_mode'` 回填约 1.8 万行。
7. 删 `idx_chat_history_user`、`idx_chat_history_model`（`lock_timeout` 短等待，失败重跑）。

### 5a 后端发布

- `ConversationHistoryRepository`：删 `setPromptHistory`/`setPendingRequestId`；`finalizeTurn` 不再写 `upstream_status`；`saveRichReplyMetadata` 把 `drive_mode` 写真列、jsonb 不再带；按 id/会话直查主表的 `TURN_COLUMNS` 去掉 `upstream_status`、`first_token_preview`，预览改为内嵌 `chat_generation_requests(first_token_preview)`。
- 读视图的列清单去掉 `upstream_status`、`display_fallback`（诊断里的兜底计数一并删）。
- 类型与单测随之改；legacy 规则禁止新代码再引用 `chat_history.history` / `upstream_status` / 主表 `first_token_preview`。

### 5b 搬历史快照并释放空间（11-19 用户定：保留 7 天）

11-19 生产核对后改了做法：原方案"全表按批 `SET history = NULL`"要写约 42 万行新版本、日志量大，而且 TOAST 文件中间夹着回复正文的活块（约 670MB），尾部截断收不回多少空间。改为三步：

1. **复制 + 保留期**（`20261119_db_reorg_p5b_prompt_retention.sql`）：5a 之前、最近 7 天内带计费快照的轮次（约 4.7 万行、压缩后约 4.3GB）按 `created_at` 顺序复制进 `ops.chat_prompt_observations`，`created_at` 取轮次创建时间；没有快照的行只是开轮请求标记（≤100 字节，313 行），不复制。建 `ops.cleanup_chat_prompt_observations` 与 pg_cron `chat_prompt_observations_retention`（每小时第 17 分，删 7 天前的，每批 1000、最多 20 批）。
2. **删列**：守卫（最近 6 天带快照的轮次都在 ops；没有函数、视图引用 `history`）后 `DROP COLUMN history`。只改目录；旧值仍留在 TOAST 里，直到表重写。
3. **在线重写释放空间**：`VACUUM FULL` / `CLUSTER` 要锁表把约 1.5GB 有效数据（堆 617MB + 回复正文 TOAST 约 670MB + 索引 176MB）读写一遍，回复正文分散在 23GB TOAST 里（大厅排序统计全表读一次均值 226 秒），锁表可能数分钟，不可接受。改用 `pg_repack`（生产可装 1.5.2，Supabase 官方支持 `-k`）：只在开头和换表时短暂加锁，复制期间读写照常；被删列的旧值不会复制，换表后 23GB 立即释放。由 Database Migration workflow 新增的 repack 模式执行（会话池连接，表名白名单，生产需确认口令），先在 TEST 演练。

### 收缩（5a 发布核对后，`history` 删列等 5b 完成）

- 守卫：没有函数/视图/cron 再引用要删的列；展示投影覆盖全部会话轮次；`history` 全部为 NULL（删列前）；主表 `first_token_preview` 与新列一致（锁内按回填规则再补一次）；`drive_mode` 锁内补一次后从 jsonb 去掉该键。
- 重建 `current_chat_history`、`session_chat_history`、`chat_history_display`、`session_chat_display` 与 `list_chat_message_page`：不再输出 `history`、`upstream_status`、`display_fallback`，投影不再兜底；`record_chat_delivery_preview` 只写新列。
- 删 `extract_chat_history_display`、`backfill_chat_history_display`；删投影表 `projection_version` 列与 CHECK。
- 删 `chat_history` 的 `history`、`upstream_status`、`first_token_preview` 列。

### 锁与批次

- 加列、去 NOT NULL、删触发器、删索引都只改目录，统一 `SET LOCAL lock_timeout = '5s'`，拿不到锁就失败重跑，不排队堵读写。
- 回填与清空：迁移文件里定义过程、`CALL` 逐批 COMMIT（`apply-repo-migration.sh` 用 `psql --file` 自动提交模式执行，允许过程内提交）；每批只锁本批的行，跳过正在写的行，过程可重跑（只处理未完成的行）。
- 5b 的 WAL：清空约 1200 万个 TOAST 块的删除记录（每批几十 MB），复制保留期内数据约等于其压缩体积。

### 预期副作用

- 大厅排序统计（`features/lobby/ranking-stats.ts`，`postgres` 角色，均值 226 秒）全表扫正文判空，会解压 TOAST 里的正文；TOAST 从 23GB 降到约 1GB 后应明显变快，上线后核对。
- 翻老会话的消息列表不再逐行解压 `history`（`current_chat_history` 类旧语句均值数百毫秒）。

## 验证

`bash scripts/test-db-reorg-p5-migration.sh`（PG17 非超级用户）：生产函数原文按 md5 从历史迁移抽取做夹具；`begin_chat_generation_observation` 新旧对照（标记调用、定稿调用、重放、request_id 冲突、取消后）；投影回填与兜底一致；预览双写与视图输出一致；`drive_mode` 回填；开轮/重生成不再写 `history`；过程分批可重跑；收缩守卫拒绝与删列后各读路径正常。后端单测覆盖仓库改动。

上线核对：pg_stat_statements 里 `UPDATE chat_history SET history`、带 `upstream_status` 的收口 UPDATE、主表 `first_token_preview` 写入停涨；`ops.chat_prompt_observations` 每轮一行；消息列表 P95 不升；5b 后 `pg_total_relation_size` 下降。

## 待用户决定

prompt 快照保留多久（5b 依赖，5a 不依赖）：

- **7 天（建议）**：够查近期投诉；稳态约 5GB；历史只复制最近 7 天（约 5GB），其余约 18GB 删除。
- 30 天：稳态约 20GB；历史复制最近 30 天。
- 全部保留：复制全部 23GB，表继续每月涨约 20GB。

删除后用户对话正文（`user_input`/`assistant_reply`）不受影响，丢的只是"当时拼给模型的完整上下文"（系统提示、角色卡、记忆在那一刻的版本）。

## 5a 上线结果（11-19 凌晨）

- 03:07 生产扩展；03:17 后端发布（#956），03:20 起新轮次 `history` 为空、prompt 进 `ops.chat_prompt_observations`（与轮次一一对应）、`drive_mode` 写真列。
- 回填：原文件每次 CALL 从头按主键重走 keyset，越跑越慢（每次 1 万行掉到 1800 行），两轮后另写 `_backfill_fast`（一次扫出待补 id、按 `created_at` 顺序补，每次 6–10k 行），两轮补完后重跑原文件闭合认领（生产不能 abandon）。会话轮次投影全覆盖。
- pg_stat_statements：jsonb drive_mode 写入、带 upstream_status 的收口写入、写 history、旧主表直读（含 upstream_status）、`current_chat_history` 全部直读，发布后均停涨。
- 04:22 生产收缩（#959）：残留 jsonb drive_mode 18721 行挪进列；4 个视图与 list 函数重建、`current_chat_history` 删除；删 `upstream_status`、`first_token_preview`、`projection_version`、`backfill_chat_history_display`。收缩后新轮次正常，主服务无 error。
- 锁时长：排他锁持有约 9 秒——锁内的预览一致性检查扫全表约 3.5 秒，其余是十几条语句各约 0.22 秒的 runner↔数据库往返。凌晨低峰只让 1 轮交付多等了几秒。以后同类收缩：重的守卫一律放在锁外（锁内只查增量），锁内的 DDL 合进一个 DO 块，避免逐条往返。
- 还剩：`history` 列（约 23GB）等 5b（11-19 用户定保留 7 天，做法见上）；计费 4 列在阶段 6。
