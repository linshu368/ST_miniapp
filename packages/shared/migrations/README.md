# 2026-11-18 视频提示词5000字（本地候选，远端未执行）

`20261118_media_plaza_message_prompt_5000.sql`：消息content CHECK从1–2000扩为1–5000，validated已知shape守卫与目标重放，事务5秒锁/30秒语句上限，RLS/ACL/其他约束不变。先TEST及同名tests/postflight，再独立确认production，之后发布消费者；图片API仍2000。回滚应用时保留5000存储约束，不能截断已保存长内容。具体步骤见[视频运行手册](../../../docs/video-plaza-stream.md#视频提示词5000字)。

# 2026-11-17 广场视频 Stream（本地候选，TEST未执行）

必须按 delivery扩展 → 已核验的test_assets数据切换 → 新应用发布/核验 → contract收缩 顺序逐文件执行，不能按字典序批跑。三文件及回滚/容量/锁/权限说明见[运行手册](../../../docs/video-plaza-stream.md)。数据迁移恰好13行CAS，固定TEST身份，保留封面/业务主键/账务；源MP4清理是应用验收后的独立步骤。新J表RLS/service-only，发布/退款同一attempt锁及租约token；5s锁/30-60s语句预算，未知结果不重放或删除。生产不在本次执行范围。

# SQL 迁移文件

## 2026-11-19 数据库重组阶段 6a-2c-3 收缩（二）：落败片段只在 `ops.llm_calls`（本地 PG17 非超级用户验证）

`20261119_db_reorg_p6a2c3_discarded_contract.sql`（不需要后端发布）：

- `observe_chat_generation_attempt` 把竞速落败调用的片段写进 `ops.llm_calls.discarded_detail`（attempt 那一行，缺行就建，只补空值）。终态守卫改看 ops 里是否已有片段，语义不变。守卫生产原文 md5 `3a7ef089…`，三处替换，结果 `00305dbb…`。
- 提交后等 5 秒，补复制扩展之后新写的片段，删 `attempts.discarded_response`。
- 生产核对：没有视图依赖这一列，只有 observe 函数读写。
- 验证：`bash scripts/test-db-reorg-p6a2c3-discarded.sh`，11 项：清洗、截断与拒绝照旧；终态；缺行建行；补搬；删列；重跑；漂移拒绝。

## 2026-11-19 数据库重组阶段 6a-2c-3 收缩（一）：删畅聊调用台账 `free_zone_calls`（本地 PG17 非超级用户验证）

`20261119_db_reorg_p6a2c3_free_zone_calls_contract.sql`（后端发布 #1001 核对、`force_rerun` 重跑扩展文件补搬增量后执行）：

- 守卫：近 15 分钟旧表没有新行；旧表每一行在 `ops.llm_calls` 都有对应（`lane = free_zone` + 角色 + 槽位）。
- 畅聊两个成本视图改为 `llm_call_costs` / `llm_turn_costs` 中 `lane = free_zone` 的子集（列名不变，授权照旧），删旧表。
- 并入 attempt 行的 OpenRouter 调用，`provider_model` 变为带日期版本名；本步不改每轮总成本（扩展时已有 106 轮 Surplus 调用改用响应金额）。
- 验证：`bash scripts/test-db-reorg-p6a2c3-contract.sh`（两种拒绝、视图前后一致、删表、授权、重跑）。

## 2026-11-19 数据库重组阶段 6a-2c-3 热修：Surplus 函数只认代表 attempt 的那一行（本地 PG17 非超级用户验证）

`20261119_db_reorg_p6a2c3_surplus_owner_fix.sql`：

6a-2c-3 起，畅聊并发的每一路 Surplus 调用各占 `ops.llm_calls` 一行，一轮可有多条 Surplus 行。原先按"轮次 + Surplus"取一行的地方会取到多行：

- `record_surplusintelligence_call` 报 P0003，畅聊胜出那一路的 Surplus 元数据记不上（11-19 11:26 起，只记日志，不影响回复与扣费）；
- prepare / claim / `read_surplus_call` 可能取错行；
- `free_zone_turn_facts` 把畅聊多路轮次重复计数。

修法：四个函数各一处加 `attempt_id IS NOT NULL`（生产原文 md5 守卫，结果 md5 核对），视图关联加同样条件。验证：`bash scripts/test-db-reorg-p6a2c3-surplus-owner.sh`（复现 P0003，修后只更新代表行、视图每轮一行；重跑无操作；漂移拒绝）。

## 2026-11-19 数据库重组阶段 6a-2c-3 扩展：文本对话模型调用归一化 + 每轮总成本（本地 PG17 非超级用户验证）

`20261119_db_reorg_p6a2c3_call_ledger_expand.sql`（扩展，**后端发布前执行**；只增补不覆盖）。计划见 `.trellis/tasks/11-19-db-reorg-p6-billing/design.md`（6a-2c-3）。

- `ops.llm_calls` 加 `lane`（chat / free_zone）、`role`、`slot`、`candidate_id`、`dispatched_at`、`end_reason`：约束 NOT VALID 后单独 VALIDATE。Surplus 每轮唯一索引改为只约束代表 attempt 的那一行（`attempt_id IS NOT NULL`），与待补成本索引一起 CONCURRENTLY 建。`ops.llm_cost_jobs` 加 kind `call_cost`、次数上限 8。
- 搬数据：
  - 近 7 天收费轮 attempt 补 role、派出时间、结束原因，未交付调用建待补行；
  - 畅聊 `free_zone_calls` 里代表 attempt 的那一路并入 attempt 行（按 generation_id，否则取胜出者），其余各路另起行；
  - 落败片段复制到 `discarded_detail`（7 天前的只搬片段）。
- `list_llm_call_metadata_gaps` 去掉 `finish_reason` / latency / generation_time 条件（原文 md5 守卫），修 sync-job 预算被永远缺这些字段的轮次占满。
- 新视图 `miniapp_analytics.llm_call_costs`（每次调用）/ `llm_turn_costs`（每轮总成本 = 首发 + 兜底全部调用，统一美元），授权同畅聊成本视图。
- 验证：`bash scripts/test-db-reorg-p6a2c3-migration.sh`（16 项，含畅聊每轮总成本前后逐轮一致、重跑无变化、缺口函数漂移拒绝）。
- 生产只读预估（11-19）：收费轮补全约 5.35 万行、新建 1539 行；畅聊 27604 行中 21455 行并入 attempt 行、6149 行另起行；落败片段 7374 条。

## 2026-11-19 数据库重组阶段 5b 第三步：pg_repack 在线重写 `chat_history`（本地 PG17 演练）

`20261119_db_reorg_p5b_pg_repack_extension.sql`：建 `pg_repack` 扩展（可用版本必须是 1.5.2，否则拒绝且不建；已装则只核对版本）。之后在 Database Migration workflow 选 `mode=repack`、`repack_table=experience.chat_history`：从 tag `ver_1.5.2`（提交 `9f36c65b`）编译同版本客户端，经 Supavisor 会话端口 5432 执行 `pg_repack -k --no-order --no-kill-backend --wait-timeout=120`，只在开头和换表时短暂加锁、拿不到就放弃不杀连接，复制期间读写照常；被删除的 `history` 旧值不会复制，换表后约 23GB 立即释放。执行前后打印表/TOAST/索引大小，残留触发器视为失败。演练：`bash scripts/rehearse-pg-repack.sh`。**11-19 已执行：TEST 63MB → 7.2MB；生产 `chat_history` 24GB → 1.3GB、整库 30GB → 7.8GB，无残留，主服务无报错。**

## 2026-11-19 数据库重组阶段 5b 第二步：删 `chat_history.history`（本地 PG17 非超级用户验证）

`20261119_db_reorg_p5b_drop_history.sql`：守卫（近 1 天没有写 history；最近 6 天带计费快照的轮次都在 `ops.chat_prompt_observations`；没有函数按列名读写 history，生产正文核对零误报；视图依赖由 DROP COLUMN 自身拒绝）后 `ALTER TABLE experience.chat_history DROP COLUMN history`（只改目录，锁等待 5 秒）。旧值仍占 TOAST 约 23GB，第三步用 pg_repack 在线重写释放。验证：`bash scripts/test-db-reorg-p5b-drop-history.sh`。**11-19 TEST 首次被旧守卫（近 1 天窗口）拒绝、#994 改固定切换点后，TEST 与生产均已执行（生产 10:23 UTC），主服务无报错。**

## 2026-11-19 数据库重组 4b：聊天配图下线（本地 PG17 非超级用户验证）

`20261119_db_reorg_retire_chat_images.sql`（**代码发布后执行**）：功能 9-29 起关闭，用户 11-19 确认下线。同一 PR 的代码删除配图 worker（每约 3 秒空轮询 `claim_chat_image_jobs`）、`/api/v1/images/*` 与会话配图接口、聊天页配图入口、运营台「图片生成配置」页与图片文本模型测试接口。迁移在一个 DO 块里：守卫没有未结束任务与租约；15 个配图配置 key 退役，删其 `runtime_config` 生效行（含模型 API Key；草稿是发布记录的来源，与发布历史一起保留）；`admin.validate_managed_config_value` 去掉这些 key 的死分支（守卫生产原文 md5 `969279…`，结果 `f23fce…`）；删 `claim_chat_image_jobs`、`billing.settle_image_generation`、两个配图校验函数；`experience.chat_message_images` 收回 API 角色权限、只读归档（274 行与扣费流水、存储桶都保留）。验证：`bash scripts/test-db-reorg-retire-chat-images.sh`。**11-19 代码发布 #986 后执行：TEST 首次因删草稿撞外键整体回滚（#988 修正、abandon 后重跑），TEST 与生产均为 15 key 退役 / 15 行配置删除 / 4 函数删除，生产核对通过、空轮询已停。**

## 2026-11-19 数据库重组阶段 5b 第一步：prompt 快照保留 7 天（本地 PG17 非超级用户验证）

`20261119_db_reorg_p5b_prompt_retention.sql`：建清理函数 `ops.cleanup_chat_prompt_observations(保留期, 每批, 最多批数)` 与 pg_cron `chat_prompt_observations_retention`（每小时第 17 分，保留 7 天；TEST 无 pg_cron 只建函数）；把 5a 之前最近 7 天带计费快照的 `chat_history.history` 按批复制进 `ops.chat_prompt_observations`（`created_at` = 轮次时间，已有行不动）。约 50 秒一轮，没复制完报错，按原文件重跑。不改 `chat_history`。计划见 `.trellis/tasks/11-19-db-reorg-p5-chat-history/design.md`（5b）。验证：`bash scripts/test-db-reorg-p5b-retention.sh`。**11-19 TEST（14 行）、生产（6 轮共复制 46864 行，ops 合计 48392 行 / 4.5GB，最近 7 天带快照的轮次无遗漏）已执行，清理任务已启用。**

## 2026-11-19 数据库重组：删卡片位次快照（本地 PG17 非超级用户验证）

`20261119_db_reorg_drop_card_position_snapshot.sql`：停 pg_cron 任务 `card_position_hourly_snapshot`（生产 jobid 5，TEST 无 pg_cron）并删 `miniapp_analytics.card_position_snapshot`（约 176MB，无视图 / 函数 / 代码读者，用户 11-19 确认）。一个 DO 块，停任务与删表同进同退；还有别的任务写这张表或有视图 / 函数读它时拒绝；重跑只打印已完成。验证：`bash scripts/test-db-reorg-drop-card-position-snapshot.sh`。**11-19 TEST（表本来不存在）、生产（停 jobid 5 并删表）已执行并核对。**

## 2026-11-19 数据库重组阶段 6a-2c-2：Surplus 调用明细镜像进 `ops`（本地 PG17 非超级用户验证）

`20261119_db_reorg_p6a2c2_surplus_expand.sql`（扩展，**后端发布前执行**）。计划见 `.trellis/tasks/11-19-db-reorg-p6-billing/design.md`（6a-2c-2）。

- 第一段：`ops.llm_calls` 补列（total_tokens / reported_cost_usd / capture_status）与 Surplus 每轮唯一索引；建 `ops.llm_cost_jobs`（请求记录补查状态）；旧表 `experience.surplusintelligence_chat_history` 加 AFTER INSERT/UPDATE 镜像触发器（三个写入函数过渡期不动）；读 RPC `read_surplus_call` / `list_surplus_request_record_candidates`。第二段：复制存量（与触发器并发时以触发器的新值为准）。成本 `cost_usd = buyer_cost_micro ÷ 1e6`。
- 后端（同一 PR）：Surplus 仓库 4 处 PostgREST 读改走 RPC；`free-zone/call-costs.ts` 改查 `ops.llm_calls`。
- 验证：`bash scripts/test-db-reorg-p6a2c2-migration.sh`（三个写入函数为生产原文；存量复制一致、之后每次写入同事务原样镜像、读 RPC、补查候选与旧扫描逐行一致、权限、重跑不重复）。
- 发布：TEST → 生产执行扩展 → 后端发布 → 两次采样确认旧表 PostgREST 读停涨 → 收缩（三个函数直接写 ops、`free_zone_turn_facts` 改读 ops、删触发器与旧表）。**11-19 扩展（#978）、发布（#979）、收缩（#981）均已在 TEST 与生产执行并核对。**
- `20261119_db_reorg_p6a2c2_surplus_contract.sql`（收缩，后端发布 #979、旧表 PostgREST 读停涨后执行）：第一段把 prepare / record / claim 改为直接读写 `ops.llm_calls` + `ops.llm_cost_jobs`（规则逐条照旧，旧表列约束改在写入前统一校验、违反仍报 23514；守卫为生产原文 md5 或已是新版本），`free_zone_turn_facts` 改读 ops，提交后等 5 秒；第二段自检旧表每行在 ops 里相同或更新，删镜像触发器、触发器函数与旧表。验证：`bash scripts/test-db-reorg-p6a2c2-contract.sh`（同一段 43 步脚本分别经生产原文函数 + 镜像与改写后的函数执行，每步结果码与最终调用 / 任务行完全一致；看板畅聊视图一致；自检不通过时拒绝并保留旧表，重跑完成）。

## 2026-11-19 数据库重组阶段 6a-2c-1：OpenRouter / Venice 调用元数据迁 `ops.llm_calls`（本地 PG17 非超级用户验证）

`20261119_db_reorg_p6a2c1_llm_calls_expand.sql`（扩展，**后端发布前执行**）。计划见 `.trellis/tasks/11-19-db-reorg-p6-billing/design.md`（6a-2c）。

- 建 `ops.llm_calls`（每次上游调用一行，id = attempt id；预留 Surplus 列；RLS，只授 service_role）与三个 RPC：`record_llm_call_metadata`（按轮次 + generation_id 定位调用，generation_id 为空取交付调用，只补空值；Venice 微美元 ÷1e6）、`read_llm_call_metadata`（交付的 OpenRouter 调用，字段名同旧明细表）、`list_llm_call_metadata_gaps`（交付调用缺元数据的已结束轮次，新的在前）。
- 一个事务内复制两张明细表全部行：能对上交付调用的用 attempt id，10-23 前旧行沿用原行 id、attempt_id 为空；成本统一美元，非法数值丢弃。不改交付仲裁、看板日汇总，不删表。
- 后端（同一 PR）：新 `LlmCallRepository` 取代 `OpenRouterChatHistoryRepository` / `VeniceChatHistoryRepository`；结算、回捞补齐、批量读、补齐扫描全部改走 RPC；Venice 元数据改用中性字段名。
- 验证：`bash scripts/test-db-reorg-p6a2c1-migration.sh`（复制映射与换算、写入只补空值与拒绝、读与缺口扫描、权限、重跑不重复）。
- 发布：TEST → 生产执行扩展 → 后端发布 → 两次采样确认旧的明细表 PostgREST 读写停涨 → 收缩迁移（补复制窗口增量、交付仲裁不再插明细行、看板改读 ops、删两表）。**11-19 扩展、发布（#973）、收缩均已在 TEST 与生产执行并核对。**
- `20261119_db_reorg_p6a2c1_llm_calls_contract.sql`（收缩，后端发布 #973、旧读写停涨后执行）：第一段改 `select_chat_generation_delivery`（去掉 OpenRouter / Venice 明细插入，按原文替换）与看板日汇总（成本读 `ops.llm_calls`），提交后等 5 秒；第二段补复制扩展之后的增量（只补空值）、自检 14 天前到 36 小时前每轮成本新旧一致、最后删两张明细表（外键会短暂锁 chat_history）。第二段失败时第一段已生效，按原文件重跑即可。验证：`bash scripts/test-db-reorg-p6a2c1-contract.sh`（成本不一致拒绝且不留痕、重跑跳过第一段并完成、增量只补空值、看板日汇总逐行一致、交付仲裁行为不变）。

## 2026-11-19 数据库重组阶段 6a-2b：结算回捞候选只认交付调用身份（本地 PG17 非超级用户验证）

`20261119_db_reorg_p6a2b_settlement_candidates.sql`：只新增只读函数 `experience.list_chat_settlement_candidates(p_scan, p_since, p_limit, p_identity_before)`，不改表、不改既有函数，**先于后端发布执行**。计划见 `.trellis/tasks/11-19-db-reorg-p6-billing/design.md`（6a-2 细化）。

- 回捞任务的待结算（openrouter / venice / surplus）与缺身份扫描不再经 PostgREST 外键嵌入三张供应商明细表，身份取 `chat_generation_requests.delivery_attempt_id → chat_generation_attempts(provider, generation_id)`；后端删 `surplus-billing-recovery.ts`。
- 生产 11-19 近 7 天 47674 个有报价的轮次新旧两种来源逐行一致，只差 21 个没被交付的 Surplus 落败调用（不再把落败调用的 generation_id 挂到这一轮；均未成功、未扣费）。生产 EXPLAIN 约 18ms，与旧嵌入查询（9–21ms）相当。
- 验证：`bash scripts/test-db-reorg-p6a2b-migration.sh`（四种扫描的入选与排除、交付身份、落败调用不外泄、预算 1..50、只 service_role 可执行、重跑不变）。
- 发布：TEST → 生产执行迁移 → 后端发布 → 核对回捞无报错、未结算轮次不积压。**11-19 已执行（TEST/生产）并发布（#968）、核对。**OpenRouter 元数据补齐扫描仍读明细表，6a-2c 随 `ops.llm_calls` 一起改。

## 2026-11-19 数据库重组阶段 6a-2a：生成调用表删 7 个无读者的列（本地 PG17 非超级用户验证）

`20261119_db_reorg_p6a2a_attempt_columns.sql`，**后端发布、旧写入停涨之后执行**。计划见 `.trellis/tasks/11-19-db-reorg-p6-billing/design.md`（6a-2 细化）。

- 删 `experience.chat_generation_attempts` 的 `headers_ms / first_chunk_ms / http_status / provider_latency_ms / provider_latency_scope（常量）/ provider_name / provider_reported_model`：只被首字视图输出、这些输出列已无读者；首包/首块耗时在 OTel，供应商名/延迟/型号与 OpenRouter 明细重复。留调用身份、畅聊评估读的 3 个耗时、落败快照（6a-2c 迁 ops）。
- 后端（同一 PR）：`enrichGeneration` 只补 `finish_reason`；`observe` 只把 RPC 存的字段发过去。
- 迁移：`observe_chat_generation_attempt` 按原文删 6 行赋值（三段锚点要么全在要么全不在）；首字视图去掉 14 个输出列（35 列）与畅聊视图一起重建；删 7 列。一个事务、一个 DO 块；先删视图再锁 attempts；首字视图指纹前后一致；可重跑。
- 验证：`bash scripts/test-db-reorg-p6a2a-migration.sh`（先执行 6a-1 作为起点；observe 原文 md5 核对；单锚点漂移、多出读 attempts 的视图时拒绝且不留痕；8 步观测场景前后保留列、终态、拒绝一致；两个视图逐行一致；畅聊评估查询照常；重跑无变化）。
- 发布：后端发布 → 两次采样确认旧的 attempts 供应商列 UPDATE 停涨 → TEST → 生产。**11-19 已发布（#964）并在 TEST 与生产执行、核对。**

## 2026-11-19 数据库重组阶段 6a-1：生成请求表删 6 个无读者的测速列（本地 PG17 非超级用户验证）

`20261119_db_reorg_p6a1_request_timing_cleanup.sql`，纯数据库、不需要后端发布。计划见 `.trellis/tasks/11-19-db-reorg-p6-billing/design.md`。

- 删 `experience.chat_generation_requests` 的 `first_token_emitted_ms / client_request_dispatched_ms / client_wait_finished_ms`（10-29 起全空）与 `client_first_token_received_ms / client_backgrounded / client_reported_at`（只剩已退役的首字报告在读，客户端首字/渲染/切后台已由 Faro 记录）。门禁、交付仲裁、取消不读它们；冻结的请求参数与 `fallback_triggered_ms` 保留。
- `report_chat_first_token` 按原文替换那条 UPDATE 的列清单（只是不再落库这 5 列）；删 `miniapp_analytics.chat_first_token_report`；按生产定义重建 `chat_first_token_facts`（去掉 7 个输出列）与 `free_zone_turn_facts`，授权与 reloptions 照旧。
- 一个事务、一个 DO 块：守卫（锚点恰好一次、视图输出列与生产一致、依赖只有畅聊视图、属主）→ 改动前算首字视图指纹 → 改函数、删视图（只锁视图本身，不 LOCK 视图以免递归锁 chat_history）→ 锁请求表 → 重建视图 → 删列 → 指纹一致、无函数再引用这 6 列。可重跑。
- 验证：`bash scripts/test-db-reorg-p6a1-migration.sh`（夹具为生产函数与视图原文、md5 核对；锚点漂移与多出依赖视图时拒绝且不留痕；11 个首字上报场景前后返回值、保留列、免费额度释放、计费门禁判定一致；两个视图逐行一致；后端畅聊评估查询照常；重跑无变化）。
- 发布：TEST → 生产（执行前再采样一次确认 grafana_cloud 不再调用报告函数）→ 核对新轮次首字上报、畅聊评估、Grafana 01 畅聊面板。**11-19 已在 TEST 与生产执行并核对。**

## 2026-11-19 数据库重组阶段 5a：chat_history 瘦身——扩展与回填（本地 PG17 非超级用户验证）

`20261119_db_reorg_p5_chat_history_expand.sql`（扩展，只改目录与函数）+ `20261119_db_reorg_p5_chat_history_backfill.sql`（回填，扩展之后执行）。计划见 `.trellis/tasks/11-19-db-reorg-p5-chat-history/design.md`。

- `history`（发给模型的 messages，占表 95% 以上、每天新增 0.5–1GB）属观测：新表 `ops.chat_prompt_observations`（history_id 软引用），`begin_chat_generation_observation` 定稿时写它、不再写主表；已存 request_id 的比对改读展示投影。开轮/重生成不再写 `history`，列去掉 NOT NULL，删投影失效触发器。
- `first_token_preview` 归交付状态 `chat_generation_requests`（发布窗口两边都写）；`drive_mode` 从 `rich_reply_metadata` 转真列；删两个没人用的索引。
- 回填：存量会话轮次补齐展示投影（之后展示不再现场解析 history）、预览与 drive_mode 复制、校验两个 CHECK。文件不包事务、不依赖会话状态（经 Supavisor 事务池执行）：持久过程 + `\gexec` 多次 CALL，每次约 50 秒、逐批提交；投影或预览没做完就报错，重跑本文件继续。
- 验证：`bash scripts/test-db-reorg-p5-migration.sh`（夹具为生产函数与视图原文、md5 核对；同一场景扩展前后结果一致，只差 prompt 与预览的存放处；锚点不符拒绝且不留痕；可重跑；回填跳过被锁行、报未完成、重跑完成；收缩前后消息列表/会话展示/会话历史读到的结果一致，四种守卫拒绝不留痕，暖会话执行，收缩后准入/预览/重生成结果不变，可重跑）。
- 发布：TEST 扩展 → TEST 回填 → 生产扩展 → 生产回填 → 后端发布 → 核对 → 5b（按保留期搬历史快照并清空释放空间）→ 收缩。回滚：扩展不删列不删数据，旧后端照常工作。
- `20261119_db_reorg_p5_chat_history_backfill_fast.sql`：提速补充。原回填在生产每次 CALL 都按主键从头重走 keyset，完成越多重走越慢（每次从约 1 万行掉到约 1800 行），且按 UUID 顺序读 TOAST 是随机读。原文件有失败认领（生产不能 abandon），不改原文件：本文件先做预览与 drive_mode，再一次扫出全部待补投影、按 created_at 顺序补；做完后重跑原文件（剩余为 0）闭合认领。
- `20261119_db_reorg_p5_chat_history_contract.sql`（收缩，5a 后端上线、旧写入停涨后执行）：先按行锁把残留的 jsonb drive_mode 挪进列；主事务按读者顺序锁视图再锁表，守卫投影全覆盖、预览一致、list 函数为已知原文、无 cron 读；删 list_chat_message_page 与 4 个视图，重建 chat_history_display / session_chat_display（不再输出 upstream_status、display_fallback，不再从 history 现场解析，预览读 chat_generation_requests）、session_chat_history（直接建在主表上，current_chat_history 删除）与同签名的 list_chat_message_page；record_chat_delivery_preview 只写新列；投影去掉 projection_version；删 backfill_chat_history_display、chat_history.upstream_status / first_token_preview。history 列等 5b。可重跑。

## 2026-11-18 数据库重组阶段 4a：支付对账任务表 + 退避，支付事件迁 ops（本地 PG17 非超级用户验证）

`20261118_db_reorg_p4a_payment_reconcile_jobs.sql`（扩展）+ `20261118_db_reorg_p4a_payment_reconcile_jobs_contract.sql`（收缩，后端发布后执行）。计划见 `.trellis/tasks/11-18-db-reorg-p4-jobs/design.md` 4a。

- 修 bug：对账 worker 对 7 天内未入账的易支付单每 30 秒查一次、连查 7 天（实测每天约 3 万次查单/事件，平台查单接口被打出间歇 500）。新表 `billing.payment_reconcile_jobs`（插单触发器建行、回填可对账订单）+ `billing.claim_payment_reconcile_jobs`：领取时清掉已入账/已终结/出窗口任务，按 30s·2^n（封顶 2 小时）排下一次；多实例 SKIP LOCKED。7 天内每单约 90 次查单。
- `billing.payment_operation_events` 整表迁 `ops.payment_events`（约束/索引同步改名），旧位置留兼容视图；ops 不经 PostgREST，新后端用 Prisma 原生 SQL 读写。删无调用方的 `billing.record_checkout_confirmation`。
- 收缩：删兼容视图；删 `payment_orders` 的 4 个对账调度列与 3 个结账确认列（无读者）及其索引/约束。守卫：无函数/视图再引用。
- `20261118_db_reorg_p4a_record_payment_event.sql`：补丁。后端发布后发现对账 worker / payment-cron 两个 Railway 服务的 `DATABASE_URL` 与主服务不同（事务池 6543），Prisma 写 ops 全部失败（只丢事件，对账与退避正常）。加 `billing.record_payment_event`（SECURITY DEFINER，经 PostgREST 调用写 `ops.payment_events`，event_key 去重），后端事件写入改走它。
- 验证：`bash scripts/test-db-reorg-p4a-migration.sh`（回填范围、插单建任务、退避序列与封顶、清理、并发互斥、旧视图 upsert 去重、新后端原生 SQL、收缩守卫与删列、可重跑）。
- 发布：TEST 扩展 → 生产扩展 → 后端发布 → 核对（`fast_reconcile` 事件每小时从约 1250 降到个位数、旧调度更新语句停涨）→ TEST/生产收缩。回滚：扩展步不删列、兼容视图在，回退后端即可。

## 2026-11-18 数据库重组阶段 3d：配置校验链压成一层（本地 PG17 非超级用户验证）

`20261118_db_reorg_p3d_flatten_config_validator.sql`（单文件，无后端改动）。计划见 `.trellis/tasks/11-17-db-reorg-p3-user-state/design.md` 3d。

- `admin.validate_managed_config_value` 从 16 层（最外层 + 15 个 `*_before_*`）改为单层 `CASE p_config_key` 分发：先查是否托管，再走该 key 的分支；判断与报错原文照搬当前生效层（被上层遮蔽的死分支丢弃）。长校验拆成 `validate_reply_style_options`、`validate_pref_word_count_tiers`、`validate_payment_plans_config`、`validate_payment_plan_list`。
- 删旧链 16 个函数与只被退役分支用的 `validate_lobby_pinned_characters`、`validate_payment_prompt_dialog_config`；收权只留属主。
- 有意差异：退役 key 存草稿改为拒绝；未登记 `image_advanced_*` 的报错文案改为 not managed。其余 key 结果不变。
- 迁移内自检：合成样例 + `config_drafts` / `config_releases` / `runtime_config` 全部现存值逐条比新旧结果，不一致整体回滚（TEST/生产用真实辅助校验函数再比一遍）。守卫：16 层 md5 必须是写迁移时的版本，多出一层也拒绝；已压平则跳过。
- 含视频广场的 `image_plaza_video_model_catalog` 分支（生产 11-18 20:08 已按旧办法加在最外层）。
- `20261118_db_reorg_p3d_report_validator_layers.sql`：只读报告，把与生产不同的层打到执行日志（TEST 报出早期视频迁移多套两层且套入顺序不同）。
- `20261118_db_reorg_p3d_align_test_validator_chain.sql`：前置。链与生产一致或已压平则空操作（生产）；只在 TEST 重建成生产当前的 16 层，非 TEST 不一致拒绝。
- 验证：`bash scripts/test-db-reorg-p3d-migration.sh`（对齐前置建出生产链并覆盖空操作/拒绝/重建 TEST 形态；辅助函数用可探测替身；含守卫/自检拒绝、热会话调用方、可重跑）。
- 发布：TEST → 生产。回滚：按历史迁移重建旧链（新旧结果已逐条比对一致，通常不需要）。

## 2026-11-18 数据库重组阶段 3c：上架状态拆出 characters（本地 PG17 非超级用户验证）

`20261118_db_reorg_p3c_character_listings.sql`（扩展）+ `20261118_db_reorg_p3c_character_listings_contract.sql`（收缩，后端发布后执行）。计划见 `.trellis/tasks/11-17-db-reorg-p3-user-state/design.md` 3c。

- 新表 `app_core.character_listings`（每卡一行：enabled / sort_order / archived_at / last_listed_at / updated_at），从 characters 回填；插卡触发器自动建行。上架时间触发器、"测试卡不能上架"守卫移到上架表；卡片表留"测试卡必须有 card_hash"CHECK 与"已上架的卡不能改成测试卡"守卫。service_role 只读写不增删（导入脚本插卡后设上架值）。
- 运营 `get_characters` / `get_character_layout` / `publish_character_layout_draft` / `create_character`（改返回 jsonb，键不变）与 `can_discover_character` / `can_use_character` 整函数重写（md5 守卫：线上必须是写迁移时依据的版本）；创作者 `mutate_creator_character` / `review_creator_character` 只按原文替换写上架列的 3 句（匹配不是恰好一处就拒绝）；`v_card_quality_session` 改 join。删 0 调用的 `archive_character` / `set_character_enabled` / `reorder_characters`。
- 运营列表的"更新时间"取卡内容与上架两者较晚的一个（布局发布不再改卡片表的 updated_at，界面所见不变）。
- 发布窗口：上架表 → 卡片表 4 列单向镜像，供旧后端读；写入方在扩展步已全部换成写上架表。
- pg_cron `card_position_hourly_snapshot` 的命令文本直读旧列：扩展步用 `cron.alter_job` 改为 join 上架表（写入内容不变，命令与预期原文不一致就拒绝；TEST 无 pg_cron 跳过），收缩步守卫不得再有 cron 命令读旧列。
- 收缩：锁两表 → 删镜像 → 守卫（每卡恰有上架行且与旧列一致；无函数/视图再读旧列）→ 插卡触发器改按默认值建行 → 删旧 CHECK、3 个旧索引、旧触发器函数与 4 列。
- 验证：`bash scripts/test-db-reorg-p3c-migration.sh`（旧函数跑固定场景作基线，扩展后、收缩后逐字比对）。
- 发布：TEST 扩展 → 生产扩展 → 后端发布 → 核对 → TEST/生产收缩。回滚：扩展步不删列且镜像同步，回退后端即可（旧的 3 个 RPC 无人调用，不恢复）。

## 2026-11-17 数据库重组阶段 3b-2：资料进 users，settings 改名 user_preferences（本地 PG17 非超级用户验证）

`20261117_db_reorg_p3b2_user_profile.sql`（扩展）+ `20261117_db_reorg_p3b2_user_profile_contract.sql`（收缩，后端发布后执行）。计划见 `.trellis/tasks/11-17-db-reorg-p3-user-state/design.md` 3b-2。

- `app_core.users` 加 6 个资料列并回填；TG 资料刷新改为 `app_core.refresh_user_profile`，值没变不写。`avatar_url`（旧 TG 头像链接，无人读）不迁，收缩步删除。
- 扩展步建同名自动可更新视图 `app_core.user_preferences`（只含偏好列），新后端从发布起就用最终名字；`cs_feed.user_identities`（保留 security_barrier）与两个运营函数改读 users，输出不变。
- 发布窗口资料双向同步，新建 settings 行先从 users 填资料（不变式：窗口内两边一致，收缩步才能按 settings 补 users）。
- 收缩：锁表补齐 → 守卫（除 4 个偏好函数外无函数/视图引用旧表）→ 删视图、表改名（约束同步改名）、删 7 个资料列 → 4 个偏好函数换新表名。
- 验证：`bash scripts/test-db-reorg-p3b2-migration.sh`。
- 发布：TEST 扩展 → 生产扩展 → 后端发布 → 核对 → TEST/生产收缩。回滚：扩展步不删列且双向同步，回退后端即可。

## 2026-11-17 数据库重组阶段 3b-1：一次性标记进 user_marks（本地 PG17 非超级用户验证）

`20261117_db_reorg_p3b1_user_marks.sql`（扩展）+ `20261117_db_reorg_p3b1_user_marks_contract.sql`（收缩，后端发布后执行）。计划见 `.trellis/tasks/11-17-db-reorg-p3-user-state/design.md` 3b-1。

- 新表 `miniapp_features.user_marks`（`(user_id, mark_key)`，count / first_at / last_at / last_action）：并入 `growth_prompt_states`（`growth_prompt.<kind>`）与 settings 的 `vip_entry_seen_at`（`vip_entry.seen`）、`characters_last_seen_at`（`characters_latest.seen`）。写只经 `touch_user_mark` / `record_growth_prompt_event`（签名与判定不变）。
- 扩展步直接删 10-13 起只为回滚保留的 `*_full_rules_remaining` 三列、`claim_instruction_slot_modes` 等 4 个函数与触发器（后端不读，0 次调用）。返利表加 `user_id` 索引。
- 发布窗口：`growth_prompt_states` 留只读兼容视图；settings 两列与 user_marks 双向同步（只在值变化时写，`pg_trigger_depth` 防回环）。
- 收缩：删同步触发器与兼容视图，锁表补齐窗口残差；`share_image_plaza_artifact` 去掉写 settings 首发分享时间的 upsert（按原文定位，删掉的文本与预期不一致就拒绝）；删 settings 三列。首发分享改由 `billing.image_plaza_share_rewards` 是否有记录推导（生产 7 人与旧列完全一致）。
- 验证：`bash scripts/test-db-reorg-p3b1-migration.sh`。
- `20261117_db_reorg_p3b1_clear_orphan_first_share.sql`：收缩前置。TEST 有手工改过的测试数据（有首发分享时间、无返利记录），挡住收缩守卫；按新定义清空（生产 0 行，空操作）。
- `20261117_db_reorg_p3b1_video_share_first_share.sql`：收缩前置。原重组执行记录中，TEST 有视频广场分支（#566）建的 `billing.share_media_plaza_video`，生产当时无此函数；迁移按原文去掉 settings 首发时间写入（同一事务已写返利记录，行为不变）。视频分支合并后，首次安装或重建 `20261027_media_plaza_video.sql` 的分享函数，必须紧接着单文件执行该 forward-fix，再开放视频分享；原视频 SQL 保留为历史定义，不改写。若该环境曾因函数不存在而把 forward-fix 记为空操作，不能只看账本判定已修复，须核对安装后的函数定义；需要重跑时用既有 Database Migration workflow 的 `force_rerun`，仍须遵守环境确认、测试先行和生产批准。最终函数不得再写 `miniapp_user_settings.image_plaza_first_share_completed_at`。本次合并未查询或修改任何远程环境。
- 发布：TEST 扩展 → 生产扩展 → 后端发布 → 核对 → 清孤立首发分享、去掉视频分享的旧写入 → TEST/生产收缩。回滚：扩展步保留标记列且双向同步，回退后端即可。

## 2026-11-17 数据库重组阶段 3a：用户归因与轮数拆出 users（本地 PG17 非超级用户验证）

`20261117_db_reorg_p3a_user_attributions.sql`（扩展）+ `20261117_db_reorg_p3a_user_attributions_contract.sql`（收缩，后端发布后执行）。计划见 `.trellis/tasks/11-17-db-reorg-p3-user-state/design.md` 3a。

- 新表 `miniapp_traffic.user_attributions`（来源、bot/MiniApp 首次进入、历史标记）与 `experience.user_chat_stats`（累计轮数，以 users 为准合并 settings 那份）；从 users 回填。
- 新函数 `app_core.ensure_user`、`miniapp_traffic.enter_user`、`experience.increment_user_total_round`、`experience.user_total_round`。`record_app_entry`、`check_invite_chat_rounds_reward`、`cs_feed.user_profiles`、`traffic_daily_stats` 改读新表（视图输出不变）。删除 8 个无人使用的分析视图。
- 发布窗口：users 上的触发器把旧后端写的归因列同步到新表；`app_core.increment_user_total_round` 暂留为兼容壳。收缩步先在 users 锁内按回填规则再补一次（扩展执行期间旧后端只写进 users 的残差，生产实测 1 人差 1 轮），再删触发器、兼容壳与 users 的 5 列、settings.total_round（守卫：补齐后仍有缺口或仍有函数引用旧列时拒绝）。
- `20261117_db_reorg_p3a_drop_test_funnel_stats.sql`：收缩前置。TEST 独有的遗留视图 `miniapp_analytics.funnel_stats` 依赖 users.bot_entered_at，挡住删列（生产无此视图，执行为空操作）；删完复核再无视图依赖要删的列。
- 验证：`bash scripts/test-db-reorg-p3a-migration.sh`。
- 发布：TEST 扩展 → 生产扩展 → 后端发布 → 核对 → 删 funnel_stats → TEST/生产收缩。回滚：扩展步不删列，回退后端即可。

## 2026-11-17 数据库重组阶段 2c：看板账号只经视图读，清掉浏览器角色遗留授权（本地 PG17 非超级用户验证）

`20261117_db_reorg_revoke_reader_and_browser_grants.sql`。计划见 `.trellis/tasks/11-17-db-reorg-p2-observability/design.md` 2c。

- `miniapp_analytics.chat_first_token_facts` 改为所有者权限；收回 `first_token_metrics_reader` 对 `experience` 三张表的直接/列级 SELECT、USAGE，删除三条 `first_token_metrics_read` 策略。报表函数与后端读视图不受影响。
- 收回 `anon`/`authenticated` 在业务 schema（不含 `admin`）的全部表/视图权限。二者本就没有这些 schema 的 USAGE，行为不变。
- `experience.chat_history`、`miniapp_traffic.botlinks`、`traffic_clicks` 开启 RLS（访问者只有所有者与 BYPASSRLS 的 `service_role`）。
- 验证：`bash scripts/test-db-reorg-p2c-migration.sh`。`scripts/sql/grant-first-token-metrics-reader.sql` 同步为只授视图。
- 回滚：视图 `SET (security_invoker = true)` 并按旧版脚本重授；RLS 可 DISABLE。

## 2026-11-17 数据库重组阶段 2b 收尾：删除 ops 兼容视图

`20261117_db_reorg_drop_ops_compat_views.sql`：删除 `app_core.alert_incidents`、`app_core.alert_delivery_attempts`、`miniapp_features.free_zone_events` 三个临时兼容视图。

- 前置：生产后端已改读 `ops`（#879，11-17 14:40 部署），`pg_stat_statements` 中旧表名语句不再增长。
- 守卫：旧名仍是表时拒绝；视图之上若有依赖，`DROP VIEW` 不带 CASCADE 会回滚。
- 验证：`bash scripts/test-db-reorg-p2b-migration.sh` 末段（两次幂等、`ops` 表与数据不变、旧名是表时拒绝）。
- 回滚：重建同名视图（定义见 2b 迁移）。

## 2026-11-17 数据库重组阶段 2b：告警、畅聊事件迁入 ops；删除短剧旧 SQL 链路（本地 PG17 非超级用户验证）

`20261117_db_reorg_ops_alerts_free_zone_events.sql`（domain: ops）。计划见 `.trellis/tasks/11-17-db-reorg-p2-observability/design.md` 2b。

- `app_core.alert_incidents` → `ops.alert_incidents`；`app_core.alert_delivery_attempts` → `ops.alert_delivery_jobs`；`miniapp_features.free_zone_events` → `ops.free_zone_events`。`SET SCHEMA` 原样搬，分析视图 `free_zone_model_events` 自动跟随。
- 旧位置留同名兼容视图（`security_invoker`，授权同原表），给发布前的旧后端用；后端上线生产后由下一个 migration 删除。
- 验证：`bash scripts/test-db-reorg-p2b-migration.sh`。以 service_role 执行后端真实 SQL：旧 SQL 经兼容视图、新 SQL 直接打 `ops`，含 `FOR UPDATE`、`RETURNING`、`ON CONFLICT DO NOTHING`、`UPDATE ... FROM`（`SKIP LOCKED`）；序列接续、FK/RLS 随表、事件只追加、浏览器角色无权限。
- 发布：TEST → Production → 后端发布（改读 `ops`）→ 删兼容视图。回滚：兼容视图在，旧后端可直接回退。

`20261117_db_reorg_drop_drama_playback_sql.sql`（domain: miniapp_analytics）。

- 删除已停写的短剧 SQL 观测：`drama_playback_observations` 表、`drama_playback_facts` 视图、记录/清理函数、停用的 cron、组角色 `drama_metrics_reader`。11-01 之后有写入或有外部依赖时拒绝。
- 验证：`bash scripts/test-db-reorg-p2b-drama-migration.sh`（正常删除两次幂等；近期写入、外部视图两种情况拒绝且不改动；`grafana_cloud` 读其他分析视图不受影响）。
- 发布：TEST → Production，同时删 Grafana 看板 `st-drama-playback` 与两处链接。回滚：不可逆，结构可从 `20261027_drama_playback_observability*.sql` 重建，历史行以每日备份为准。

## 2026-11-17 数据库重组阶段 2a：经营看板日汇总刷新提速（本地 PG17 非超级用户验证）

`20261117_db_reorg_core_refresh_bounded.sql`（domain: miniapp_analytics，派生缓存）。计划见 `.trellis/tasks/11-17-db-reorg-p2-observability/design.md` 2a。

- 问题：`grafana_core_recent_30m` 在一条命令里刷新今天和昨天，每条 5s 超时、同一事务连坐。函数逐行随机查供应商明细表，当天 4533 行 5.8s，11-17 午后 8 次失败 6 次，看板停更。
- 函数同签名、同输出、同权限。openrouter/venice 明细先按 `created_at` 取 `[当天 00:00 - 5 分钟, 次日 01:00)` 再哈希配对（生产实测明细比聊天记录晚 0~111 秒写入）。计费表仍按 `charge_key` 查。
- cron 拆两个：`grafana_core_recent_30m` 只刷今天（20s）；新增 `grafana_core_yesterday_close`（`17 16-22 * * *` GMT，北京时间 00:17~06:17）只刷昨天（30s）。
- 验证：`bash scripts/test-db-reorg-p2a-migration.sh`。保留旧函数副本，在 3 天随机合成数据上逐天比较新旧输出逐行一致；把窗口改窄会被测试抓到。生产执行前只读比较 11-16 全天 8035 行，新旧写法 0 行不同。
- 发布：TEST 单文件 → Production 单文件，无应用代码改动。回滚：重新执行 `20261026_grafana_light_core.sql` 的函数与 cron 段。

## 2026-11-17 数据库重组阶段 1f：删除无读者的 analytics_grafana（本地 PG17 非超级用户验证）

`20261117_db_reorg_drop_analytics_grafana.sql`（domain: miniapp_analytics 为唯一看数入口）。

- 删除 `analytics_grafana`：11 个物化视图、35 个视图，约 1.7 MB。
  - Grafana 现存看板与告警零引用；物化视图自 10 月下旬起无人刷新；无函数、cron、外部视图依赖；仓库零引用。
  - 迁移内守卫：仍有引用时拒绝执行。
- 删除只在该 schema 上有授权的组角色 `grafana_reader`（`grafana_cloud` 的上级角色）。有残留依赖或无 ADMIN 时保留并打印 NOTICE。
- `grafana_cloud` 读 `miniapp_analytics` 不受影响。
- 验证：`bash scripts/test-db-reorg-p1f-migration.sh`（两次幂等；外部依赖存在时拒绝且不改动）。
- 发布：TEST 单文件 → Production 单文件，无应用代码改动。回滚：不可逆，视图定义可从历史 migration 取回。

## 2026-11-17 数据库重组阶段 1e：托管配置 key 登记表（本地 PG17 非超级用户验证）

`20261117_db_reorg_managed_config_keys.sql`（domain: admin + app_core.runtime_config）。计划见 `.trellis/tasks/11-17-db-reorg-p1-foundation/design.md` 1e。

- 新表 `admin.managed_config_keys(config_key PK, managed_via, retired_at, note)`：56 个运营托管 key 加 `miniapp_text_postprocess_config`（text_postprocess）。
- `admin.is_managed_config_key` 改为查表（operations_config 且未退役），NULL 入参仍返回 NULL，权限仍只给 postgres。迁移内先记录旧 9 层链对每个 key 的判断，替换后逐一比对，不一致即回滚。
- `config_drafts` / `config_releases` 的 key CHECK 与 advanced-image CHECK 改为外键引用登记表。历史中登记表外的旧 key 以退役身份补登。
- 删除 9 个 `admin.is_managed_config_key_before_*`（迁移内断言除这两个 CHECK 外无其他引用）。
- 退役 7 个 key（运营台已不展示、后端不读）：`miniapp_recharge_page_config`、`miniapp_payment_prompt_dialog_config`、`system_fallback_character_id`、`miniapp_daily_checkin_bonus_credits`、`media_feature_free_trial_limit`、`image_plaza_tags_feature_enabled`、`lobby_pinned_characters`。删除这些 key 以及另外 5 个零引用 key 的 `runtime_config` 行。
- `admin.validate_managed_config_value` 的 15 层不改，冻结：**以后新增托管 key = 登记表插一行 + 最外层原地加校验分支 + admin-client 注册**，不再改名套层、不再改 CHECK（CONTRACT §2.5）。
- 验证：`bash scripts/test-db-reorg-p1e-migration.sh`。以非超级用户 + CREATEROLE 执行，用生产链原文做夹具。覆盖两次幂等、逐 key 一致、NULL 语义、外键接受历史/拒绝未知、旧 CHECK 与包装函数已删、配置行增删、权限不扩大。
- 发布：TEST 单文件 → Production 单文件 → admin/shared 去掉两个零引用常量（先后不敏感）。
- 回滚：恢复某个退役 key 时，`UPDATE admin.managed_config_keys SET retired_at = NULL`，并重新写入 runtime_config 行。

> 备注（1c）：`20261117_db_reorg_cs_grants.sql` 在生产留有一条失败认领（`repo_migration_claims`）。生产未执行 `20261013_repo_migration_claim_recovery.sql`，`abandon_claim` 不可用。该认领只阻止原文件重跑，原文件已由 `_fix` 取代，不影响其他迁移。

## 2026-11-17 数据库重组阶段 1c 修正：遗留角色逐项撤权（本地 PG17 非超级用户验证）

`20261117_db_reorg_cs_grants_fix.sql` 取代下面 `20261117_db_reorg_cs_grants.sql` 在生产的执行。

- 原因：原文件用 `DROP OWNED BY cs_outreach_reader_v1` 撤权。生产的 postgres 不是超级用户，也不是该角色成员（只有 ADMIN），报 `permission denied to drop objects`，整个事务回滚、未生效。
- 原文件已在 TEST 记账，按账本规则不改。生产对原文件的失败认领以 `abandon_claim` 作废，之后不再执行原文件。
- 修正：按 `pg_shdepend` 逐项 REVOKE（表/视图、schema、数据库），断言无残留依赖后 `DROP ROLE`。生产核对过这些授权的 grantor 均为 postgres。其余撤权内容与原文件相同。
- 验证：`bash scripts/test-db-reorg-p1c-migration.sh` 改为以"非超级用户 + CREATEROLE"账号建对象并执行，与生产 postgres 同权。原文件在此条件下复现失败，修正版两次执行均成功，角色级读写断言通过。
- 发布：TEST 单文件（无客服角色，跳过）→ Production：先 abandon_claim 原文件，再执行本文件。

## 2026-11-17 数据库重组阶段 1c：客服账号只读视图层（生产执行失败已回滚，由上面的修正文件取代）

`20261117_db_reorg_cs_grants.sql`（domain: 外部读者授权）。前置：`20261117_db_reorg_ops_cs_feed.sql` 已执行，客服仓库已改读 `cs_feed`（ST_cs_platform 91c9593）。

- `cs_runtime_v1`：撤销 `app_core` / `billing` / `experience` 的表权限与 USAGE，只留 `cs`（客服自有）与 `cs_feed`。客服表到 `app_core.users` 的外键检查以表所有者身份执行，不受影响。
- `cs_persona_reader`：撤销全部业务 schema，只留 `cs_feed`、`miniapp_analytics`。旧画像簇按所有者决定直接丢弃。
- `cs_outreach_reader_v1`：零引用、无连接、不拥有对象（迁移内再次断言），`DROP OWNED` 撤权后删除。
- 验证：`bash scripts/test-db-reorg-p1c-migration.sh`（两次幂等；以角色身份读视图成功、读业务表被拒；经外键写 `cs.conversations` 成功；无这些角色的环境跳过）。
- 发布：TEST 单文件（无客服角色，预期跳过）→ Production 单文件。回滚：按 ST_cs_platform `db/migrations/009`、`016` 重新授权。

## 2026-11-17 数据库重组阶段 1d：清理无读者的结构（本地 PG17 验证，远端未执行）

`20261117_db_reorg_cleanup.sql`（domain: app_core / miniapp_traffic / miniapp_features / PostgREST 暴露配置）。计划见 `.trellis/tasks/11-17-db-reorg-p1-foundation/design.md` 1d。

- 删除 `app_core.users.st_handle`，零引用，唯一索引随列删除。`st_initialized_at` 保留：幕间资格函数在读它，阶段 3 再搬。
- `miniapp_traffic.botlinks` 的 `"Purchase_amount"` / `"Procurement_days"` 改名为小写；视图 `traffic_daily_stats` 按列号引用，输出不变。
- 删除 `miniapp_features.wish_roles` 与 `create_wish_role` / `complete_wish_role`。
- 从 authenticator 的 `pgrst.db_schemas`、`pgrst.db_extra_search_path` 去掉 `miniapp`、`cs_platform`，保持原顺序，旧值打印在 NOTICE。然后删除 `cs_platform`（CASCADE）与空 `miniapp` schema，提交时 NOTIFY pgrst 先重载配置、再重载 schema。没有这两个 GUC 的环境跳过改写。
- 注销两个停用 cron（`daily_metrics_midnight` / `noon`），删除 `public.compute_daily_metrics` / `show_dashboard`。
- 归档以 Supabase 每日备份为准（所有者确认）。删除不可逆；暴露列表可按 NOTICE 旧值恢复。
- 验证：`bash scripts/test-db-reorg-p1d-migration.sh`（两次幂等、暴露列表只少两项且顺序不变、视图输出不变、无 GUC / 无 pg_cron 环境安全跳过）。
- 发布：TEST 单文件 → Production 单文件 → 后端（只去掉不再使用的 cs_platform 域客户端，先后顺序不敏感）。上线后核对后端 `/health`、真实对话、运营台读写。

## 2026-11-17 数据库重组阶段 1a：建 ops 与 cs_feed（本地 PG17 验证，远端未执行）

`20261117_db_reorg_ops_cs_feed.sql`（domain: ops 新建 + cs_feed 新建）。规则见 `docs/db/CONTRACT.md`，计划见 `.trellis/tasks/11-17-db-reorg-p1-foundation/design.md`。前置：`app_core.users` / `miniapp_user_settings`、`billing.user_wallets` / `vip_memberships` / `payment_orders`、`experience.chat_sessions`。

- `ops`：空 schema，只给 service_role USAGE；撤销 PUBLIC，以及新函数默认的 PUBLIC EXECUTE。阶段 2 起承接上游调用明细、测速、事件、告警。
- `cs_feed`：给客服仓库读的只读视图层，不暴露给 PostgREST。
  - `user_identities`：用户 id、tg_id、展示名、username；
  - `user_profiles`：资料卡，输出列与客服 `users.ts` 的 `profileSelect` 逐列一致。
  - 视图归 postgres，带 `security_barrier`，做法与 `analytics_grafana` 现有视图相同。
  - `cs_runtime_v1`、`cs_persona_reader` 只在生产存在，存在时才授权视图 SELECT。旧的业务表授权暂不收回（阶段 1c 收回）。
- 验证：`bash scripts/test-db-reorg-p1a-migration.sh`（两次执行幂等；视图与客服原 SQL 在空名字、无钱包、无设置、已删会话、未完成订单等边界数据上逐行一致；客服角色在没有任何底表权限时能读视图；anon/authenticated 无权限）。
- 发布：TEST 单文件 → Production 单文件 → 客服仓库改读 `cs_feed`（1b）→ 收权（1c）。只新增对象，旧代码不受影响。
- 回滚：客服仓库切换前，`DROP SCHEMA cs_feed CASCADE; DROP SCHEMA ops;`；切换后先回退客服仓库。

## 2026-11-17 剧情模式（本地 PG17 验证，远端未执行）

`20261117_drive_mode.sql`（domain: app_core 用户偏好 + admin managed key）。前置：`app_core.miniapp_user_settings`、admin managed config 函数链。

- `app_core.miniapp_user_settings` 新增可空列 `pref_drive_mode`（无默认值，只改目录不重写表）+ CHECK `miniapp_user_settings_pref_drive_mode_check`（NULL 或 `^[a-z][a-z0-9-]{0,31}$`）。NULL 表示跟随默认档；是否为启用档位由后端写入时校验。
- managed key `drive_mode_options`：沿用改名包装链，库里只校验是带 `modes` 数组与 `default_mode_id` 字符串的 JSON 对象，字段规则在 shared `DriveModesConfigSchema`；草稿/发布表的 key CHECK 放宽到新 key，未知 key 仍拒绝。不预置 runtime_config 行（缺失时引擎注入保守规则、前端隐藏栏目）。
- 每轮档位写在既有 `experience.chat_history.rich_reply_metadata.drive_mode`（既有 CHECK 允许附加键），不改热表结构。
- 验证：`bash scripts/test-drive-mode-migration.sh`（连跑两次幂等、key 链与 ACL、草稿/发布约束、偏好列 CHECK）。
- 发布：TEST 单文件 → Production 单文件 → Backend/Frontend → 运营发布剧情模式、主体模板、回复风格。回滚：先回滚主体模板并停用剧情模式，再回退代码；需要时 `ALTER TABLE app_core.miniapp_user_settings DROP COLUMN pref_drive_mode`，函数链保留。

## 2026-11-16 畅聊每次上游调用的真实花费（本地 PG17 验证，远端未执行）

`20261116_free_zone_calls.sql`（domain: miniapp_features + miniapp_analytics 只读投影）。无前置依赖（不建跨 schema 外键）。

- 新增 `miniapp_features.free_zone_calls`：畅聊每次真正发出的上游调用一行（并发主请求每路一行、兜底一行，含落败/被取消的），唯一键 `(chat_history_id, role, slot)`。后端竞速结束时写入，花费由后台任务按 Surplus 账单明细 / OpenRouter 生成编号事后补上。`cost_source`：`surplus_bill`、`surplus_bill_matched`（响应头前就取消、没请求号，按「同模型 + 结算时间」从账单配上）、`openrouter_generation`、`estimated`（兜底中途停下又查不到，写入定期算好的估算值）、`unavailable`（按 0）。RLS 开启，撤销 PUBLIC/anon/authenticated；service_role 只有 SELECT/INSERT/UPDATE。
- 新增只读视图 `miniapp_analytics.free_zone_call_costs`（每次调用的有效花费）与 `free_zone_turn_costs`（每轮合计，`cost_pending` 的轮次统计时排除）；存在 `first_token_metrics_reader` 时授予 SELECT。
- 验证：`bash scripts/test-free-zone-calls-migration.sh`（每轮合计、查不到按 0、估算、约束、权限、重复执行）。
- 发布：TEST 单文件 → Production 单文件 → Backend（迁移未执行时后端写入失败只记日志，不影响对话）。回滚：先回退后端，再按文件头注释删除视图与表。

## 2026-11-13 短剧原因问卷（本地 PG17 验证，远端未执行）

`20261113_drama_survey.sql`（domain: miniapp_analytics + billing）。前置：`app_core.users`、`app_core.runtime_config`、`billing.user_wallets`、`billing.wallet_ledger`。

- 新增 `miniapp_analytics.drama_survey_responses`：一次性问卷答卷，每个账号每份问卷一行（提交或叉掉）。问卷只弹给前端本机追剧记录里有过有效观看的用户；答卷包含 Q2a/Q2b 选项编码与客户端上报的观看深度（有效观看剧数、最大集数）。只用于分析，产品运行时不读；"是否已领过奖励"由后端查 `billing.wallet_ledger`。按 schema 规范第 5 条归入 analytics：不是平台资产，也不属于某个 MiniApp 功能的运行状态。
- 新增 `billing.submit_drama_survey(...)`：在同一事务里写答卷、加 bonus 星尘、记流水（`entry_type='survey_reward'`，`reference_type='survey'`，`reference_id=survey_key`）。"每账号只领一次"由答卷表主键保证，并发提交只发一次；没有在 `wallet_ledger` 上新建唯一索引，避免建索引时阻塞扣费写入。流水类型约束按 `20261030` 的方式追加，使用 NOT VALID。
- RLS 开启，撤销 PUBLIC/anon/authenticated；service_role 对答卷表只有 SELECT/INSERT，函数只授予 service_role。
- `app_core.runtime_config.miniapp_drama_survey_enabled` 默认 false。
- 执行：2026-11-13 TEST（run 43391746773）、Production（run 43418231723）均已 COMMIT；TEST 真机核对提交与叉掉两类答卷落表正确。
- 发布：TEST 单文件 → Backend/Frontend（开关关，线上无变化）→ Production 单文件 → 打开开关。回收：`pnpm --filter backend drama-survey:report -- --out <path>`。
- 收尾：关开关 → 导出 CSV → DROP 函数与答卷表（语句见文件头）。`survey_reward` 流水是资金审计事实，保留。

## 2026-11-12 畅聊每轮事实补「生成中断」（本地 PG17 验证）

`20261112_free_zone_interrupted.sql`（domain: miniapp_analytics 只读投影）。前置：`20261112_free_zone.sql`。

- `miniapp_analytics.free_zone_turn_facts` 末尾追加两列：`primary_delivered`（这一轮由免费模型自己交付）、`interrupted`（免费模型开始出字后没写完就断了：`stream_interrupted` 且不是 `user_cancelled` / `content_filter`）。中断率 = interrupted / primary_delivered。
- 只用 `CREATE OR REPLACE VIEW` 追加列，已有列、属主与授权不变；重复执行无副作用。
- 验证：`bash scripts/test-free-zone-migration.sh`（新增中断口径断言、Grafana 角色可读）。
- 发布：TEST 单文件 → Production 单文件 → Backend（后端评估读这两列；迁移未执行时评估会记 metrics_failed，只是本轮不按业务数据判断）。回滚：先回退后端，再按文件头注释重建视图。

## 2026-11-12 历史回复改绑富文本规则 v19（本地 PG17 验证）

`20261112_rebind_text_postprocess_v19.sql`（domain: experience）。回复富文本规则 v18（11-05）删掉了 choice / status / memory / dialogue 四条停用规则，内置卡片和对白的样式写在它们的 css 里，随之丢失。11-12 已在运营平台回滚到 v17，生成了 v19。

- 只把 `experience.chat_history.postprocess_version` 从 18 改为 19，不碰正文。同一事务内先调用 `experience.text_postprocess_bind_enter()` 通过写保护。
- 保护条件：v19 快照与 v17 完全相同，且 v18 缺少 choice 规则。不满足时打印 NOTICE 并跳过，TEST 等规则版本号不同的环境会走这条分支。重复执行时改绑 0 行。
- 发布：TEST 单文件（预期跳过）→ Production 单文件。不准备回滚。

## 2026-11-12 畅聊（免费模型）栏目（本地 PG17 验证，远端未执行）

`20261112_free_zone.sql`（domain: miniapp_features + miniapp_analytics 只读投影 + admin managed key）。前置：已有 `miniapp_analytics.chat_first_token_facts`、`experience.surplusintelligence_chat_history`、`experience.chat_reply_feedback`。

- 新增 `miniapp_features.free_zone_models`（每个候选一行当前上下架状态，唯一写入方是后端评估任务）与 `free_zone_events`（只追加的上下架记录）。RLS 开启，撤销 PUBLIC/anon/authenticated；events 只给 INSERT/SELECT。
- 新增四个只读视图 `miniapp_analytics.free_zone_turn_facts / free_zone_dislikes / free_zone_model_states / free_zone_model_events`，评估任务与 Grafana 共用同一口径；存在 `first_token_metrics_reader` 时授予 SELECT（Grafana 经此角色读取，不需要基表权限）。
- `free_zone_config` 加入 managed key（包装函数复制原 ACL、放宽两表 CHECK）。不插入 runtime_config 行：后端缺省视为总开关关、候选为空。
- 验证：`bash scripts/test-free-zone-migration.sh`（managed key 链、状态约束、投影、权限、重复执行）。
- 发布：TEST 单文件 → Backend/Admin/Frontend（总开关默认关，线上无变化）→ Production 单文件 → 运营平台填候选池并打开开关。回滚：关总开关；删除对象见文件头注释。

## 2026-11-11 聊天历史展示投影（TEST 已执行，Production 待验证）

依次验证 `20261111_chat_history_display_metadata.sql` → `20261111_chat_history_display_reads.sql`，然后有限回填、核验覆盖/读写性能，再发布 Backend。新表归 experience；原始 prompt 和账务不迁移、不裁剪。service_role 保留原 admission 的 invoker 写权限，新对象对 anon/authenticated 不开放。

`maintenance/chat_history_display_backfill.sql` 和 `maintenance/chat_history_display_write_recovery.sql` 是同一 migration 来源下的人工维护/恢复脚本，**不加入自动 schema migration 队列**；前者每批独立事务，需要 psql `\gexec`，不得包在外层事务中。完整前置、锁/容量、重访与恢复顺序见 [操作说明](../../../docs/chat-history-read-performance.md)。用户已确认两份扩展迁移在 TEST 执行，预检已核对对象存在；本地一次性 PG17 harness 覆盖回填/恢复，不代表 TEST 存量业务记录已完成回填或 Production 已执行。

## 2026-11-11 轻量文本专项星尘优先扣（本地 PG17 验证，远端未执行）

`20261111_light_text_bonus_first_debit.sql`（domain: billing）。前置：`20260921_wallet_debit_refund.sql`。

- 只改 `billing.apply_wallet_debit` 里 `main_then_bonus` 的拆分顺序：由「先通用后专项」改为「专项优先，不足部分再扣通用」。其余与原函数逐字一致（`CREATE OR REPLACE`，权限与注释重申）。起因：用户反馈轻量模型消耗了充值买来的通用星尘，专项星尘（只能给轻量模型用）反而闲置。
- 策略标识符保持 `main_then_bonus`：`charge_llm_usage` 的取值校验、在途快照、待恢复同步扣款都写着它，保持不变才能让在途扣款也走新顺序、不出现新旧混用窗口。含义自本迁移起为「轻量文本组合扣款：专项优先」。
- 不受影响：`main_only`（标准/旗舰/图片/语音）、余额不足整笔失败、`debit_key` 幂等、原路退款（按流水里的 main/bonus 数额还原）、创作者分成（按消耗额算）。
- 历史流水不改写：以 `main_delta` / `bonus_delta` 为准，不能用 metadata 里的 policy 字符串推断某笔的扣款顺序。
- 验证：`bash scripts/test-vip-billing-migrations.sh`、`bash scripts/test-first-token-fallback-local.sh`；`vip_billing_t2_scenarios` / `vip_llm_t4_scenarios` 的组合扣断言已改为专项优先，并新增「专项足够只扣专项、退款原路还原」。
- 发布：TEST 单文件（走 Database Migration workflow）→ 验证 → Production 单文件。后端无需同步发布：TS 侧 `allocateWalletDebit` 只是契约辅助，真实扣款只在 SQL。不准备回滚迁移，问题 forward-fix。

## 2026-11-10 会话长期记忆与正文字数水位（本地 PG17 验证，远端未执行）

`20261110_story_memory.sql`（domain: experience + admin managed key）。前置：`20261029_conversation_branches.sql`、`20261102_chat_message_overrides.sql`、`20261102_creator_review_prompt_config.sql`。

- 新增 `experience.story_memories`（记忆版本，全部保留）与 `experience.story_memory_jobs`（每会话一行任务状态），均 RLS，service_role 只读，写入只走四个 SECURITY DEFINER RPC（前移+建任务 / 领取 / CAS 提交 / 收尾退避）。均 FK `chat_sessions ON DELETE CASCADE`。
- 删除按轮数的旧泄洪：两个基础开轮函数里的 `apply_context_window_flood(...)` 调用原位替换为原样返回起点（锚点必须恰好一处，否则整笔失败），DROP 该函数，删除 `max_context_turns` / `retain_context_turns`。开轮 wrapper 链上的同名参数保留但不再使用。
- `fork_chat_session` 改为 4 参数：按"覆盖终点早于锚点的最新记忆版本"继承原文并复制记忆；删除 5 参数旧版本。
- `story_memory_config` / `story_memory_prompt` 加入 managed key（包装函数复制原 ACL、放宽两表 CHECK）。不插入 runtime_config 行，Backend 缺省用代码默认值。
- 验证：`bash scripts/test-story-memory-migration.sh`（先回放分支/覆盖基线，再断言 RPC 行为、分支记忆选择、权限、并发领取与账户级联）。
- 发布：TEST 单文件 → Backend/Admin → Production 单文件 → Backend/Admin。不准备回滚迁移，问题 forward-fix；不要把 Backend 回退到依赖 SQL 泄洪的版本。

## 2026-11-10 Surplus Intelligence 调用明细（本地实施，远端未执行）

当前执行入口为 `20261110_surplusintelligence_chat_history_compat.sql`。原 `20261110_surplusintelligence_chat_history.sql` 保留不改：在整份SQL以Windows CRLF提交时，其函数定义转为LF、匹配模板却保留CRLF，可能触发 `Unexpected installed delivery provider branch`。兼容文件完整包含原迁移功能，可直接用于原文件失败回滚后的环境；不需要先成功执行原文件，也不要重跑已记账原文件或加force_rerun绕过。

该迁移新增 `experience.surplusintelligence_chat_history`，以唯一 `chat_history_id` 关联父轮次，可选 attempt 必须同父；保存实际非正文请求参数、独立 request/generation ID、受控 body/SSE/header/request-record 数据和可用的用量/成本/时延投影。会话内容和计费权威仍在原链路；失败或输给 OpenRouter 的 Surplus 调用仍保留，不能凭明细存在推断交付胜者。

- 兼容修复仅把函数定义、全部多行匹配模板及替换文本统一为LF，并要求目标锚点唯一；不放宽未知分支、不用旧版函数覆盖现网锁/CAS/计费逻辑。原文件在其他环境若已成功，保持原filename/checksum，本兼容文件按独立文件记账。整份失败的原迁移处于显式事务中，不应提交部分新表；先核对账本及实际结构，再通过标准workflow执行新文件。

- 前置：现有多平台 catalog、first-token 表及 `20261026_first_token_nonretryable_conflicts.sql`、`20261028_first_token_race.sql`；目标必须已经支持当前请求登记/交付协议。迁移对安装中函数做带锚点的原位补丁，保留 OID/owner/ACL；未知 shape、旧40001永久重试或旧抢占限制会拒绝整笔操作。不要重跑旧文件绕过。
- 同文件修正 catalog provider 校验、generation 两表 provider CHECK、交付函数三分支；不会将 Surplus 写入 Venice。CHECK 扩展涉及现有表扫描，5s锁/60s语句预算，生产先独立评估大小/锁窗口，超预算停止，不扩大预算硬跑。
- 新表启用 RLS，撤销 PUBLIC/anon/authenticated，service_role 仅 CRUD；调用 RPC 仅 service_role 可执行，不给 metrics reader JSON 权限。请求16KiB、响应128KiB（数据库按JSONB文本UTF-8计数）；正文/思考/凭据字段递归拒绝。JSON允许项与缺口诊断由服务端严格mapper进一步约束。
- `prepare_surplusintelligence_call` 在 dispatch 前冻结参数；`record_surplusintelligence_call` 以行锁/CAS保全身份及非空证据，不修改主表。首次终态可更新首帧暂定用量，匹配不可变request ID的已完成详情可更新成本/用量查询投影；早期inline JSON证据仍保留，迟到首帧不回退终态投影。`claim_surplusintelligence_request_record` 原子领取补齐额度（最多6次，有界退避），允许超120秒残留调用的元数据恢复，避免多副本重复探测；详情权限不足只标不可用，不阻塞固定档位结算。
- 验证：扩展既有 `bash scripts/test-first-token-fallback-local.sh`，包含 migration重放、catalog校验、RPC/权限、ID与参数冲突、30位微美元精度/NULL/0、嵌套正文拒绝、容量、级联及Surplus输者/OR胜者。无Docker时隔离PGlite可验证SQL行为，但不能替代PG17/PostgREST、多连接并发、实际钱包及真实供应商验收。
- 发布：隔离回归 → TEST 单文件 workflow migration/shape及权限核对 → 新 Backend/shared/Admin 和真实小样本 → Production 独立单文件 workflow → 新应用 → CLI草稿/diff/用户明确同意后发布模型。生产配置发布不是本迁移的一部分；不能以TEST结果替代Production。
- 旧数据不回填未知参数或假响应；旧仅有Surplus计费快照的数据由兼容恢复处理。停止/恢复先禁用Surplus新流量并保留调用记录，使用兼容版本或受审阅forward-fix；禁止回退到把Surplus写进Venice的旧函数、DROP新表或重写旧账。

## 大厅评分去重

`20261104_lobby_ranking_refresh_state.sql` 新增一条后台专用记录，保存最近成功评分口径和完成时间，与分数同事务写入。先迁移、再发新应用；首次无成功记录需计算一次。回退应用保留该表。仅在本地隔离PG17验收。

## 2026-11-02 角色卡AI审核（本地验证，未执行远端）

用户暂停原直接公开发布，未执行的 `20261102_creator_direct_publication.sql` 已被本次审核方案替代，不应继续引用旧release-review或旧无条件放行方案。

1. `20261102_creator_review_prompt_config.sql`：仅增加运营审核正文text key，包装当前managed-key/validator并保留旧名单/ACL/两表CHECK与历史特殊key；正文1–12000 UTF16字长，默认规则ON CONFLICT不覆盖运营内容。输出结构不由配置控制。
2. `20261102_creator_ai_review.sql`：复用原mutate函数，只有服务端严格解析的approved/reason结果才能直接发布当前CAS版本；旧backend无review仍pending。排除server review措辞对客户端幂等身份的影响，不改权限/锁/会话快照；不批量通过原14张待审、不恢复禁用/归档。

未来部署顺序为两份迁移依次本地与TEST验证→Production→Backend/Admin→Frontend。本轮只本地开发，未触发远端workflow。验证复用 `bash scripts/test-creator-characters-local.sh`、`bash scripts/test-reply-style-options-local.sh`、`pnpm test:ui --grep @creator-review`。发布审核格式/超时失败不放行且不伪装成内容拒绝；恢复旧应用时保留pending兼容，不改已公开卡和历史聊天。

## 2026-10-30 用户角色创作（本地验收，远端未执行）

每个文件分别执行并记录账本，顺序固定：

1. `20261030_creator_cover_assets.sql`：持久封面身份与私有Storage bucket。
2. `20261030_creator_characters.sql`：作者草稿/审核、历史访问资格、owner CRUD；依赖既有角色社交/分支与用户根表。
3. `20261030_creator_character_versions.sql`：卡级不可变版本、真实开轮绑定与分支继承；空会话不锁版。
4. `20261030_character_creator_rewards.sql`：在当前归档/用户主动停止计费函数上追加实际扣费奖励、永久去重与退款回收；结构不符合预期会中止而不是覆盖旧函数。

先在TEST应用并检查ACL/RLS、公开审核、私密历史访问、既有聊天不变、真实存储上传及供应商调用，再安排生产。应用发布顺序为迁移 → Backend/Admin → Frontend。不能只发布前端。隔离PG17验证分别复用`bash scripts/test-creator-characters-local.sh`和`bash scripts/test-first-token-fallback-local.sh`，不连接真实账户或余额。

停止/恢复：首先隐藏创作入口、停止新审核/新卡发布，保留已用卡、不可变版本、历史访问资格、封面及奖励账本。已部署后不得直接删除session版本列或退回不认识版本的聊天后端，也不得删除奖励待抵扣余额；修复优先forward-fix，任何钱包恢复以既有账本核对，不手工改余额。覆盖资产使用不可变对象，失败上传只清理本次未被引用对象，不能清掉正在使用的封面。

本目录是仓库里**唯一**的 schema 变更源。现行规则以 [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md) 铁律 9 与 §7.4 为准，不要再引用已删除的 `DECISIONS.md` / `Schema划分设计.md`。

当前事实：

- 物理布局是 099 之后的八域（`app_core` / `experience` / `billing` / `miniapp_features` / `cs_platform` / `admin` / `miniapp_traffic` / `miniapp_analytics`）。`st_*` / `growth` / `miniapp_simulation` 已删。
- 新表必须在文件头声明 `-- domain: xxx`。跨域直连豁免见 ARCHITECTURE 铁律 8，不要另写一份地图。
- 新文件命名 `YYYYMMDD_<小写下划线描述>.sql`。三位数字编号已冻结，CI `pnpm lint:migrations` 拦截新编号。

## 现行执行通道

### 图片广场固定初始序位（2026-10-19，未执行）

文件：`20261019_image_plaza_initial_feed_order.sql`。前置：V2、seed_catalog、feed_like_order 三份 migration 的目标环境 shape 已核实。

- `experience.image_plaza_works` 加 nullable bigint、正数 CHECK 和 UNIQUE；一次编号所有未删除作品（包括有赞），模型内按源热度/时间/id，跨模型逐轮交错。不修改点赞、所有权、RLS/ACL 或生成/分享/导入流程；以后新增默认 NULL。
- 单事务持有 ACCESS EXCLUSIVE 锁，5 秒锁等待、60 秒每语句预算、100000 active 作品上限；阻塞期间分享/点赞/导入可能等待，必须维护窗口与容量验证。超预算停止，不自动重试/扩大阈值。重复执行明确拒绝，不重新编号。
- 保留既有点赞索引，新增零赞 partial 与最新索引。**候选索引还未得到真实 EXPLAIN/写成本验证**，本地无 PostgreSQL/Docker，不得将 unit mock 视为 SQL 验收。
- TEST preflight：核对列、约束、源热度类型、RLS/grants、现有索引、活跃作品规模与空间；确认没有已有 initial_feed_order。先隔离环境验证初始化原子回滚/重跑拒绝/并发，再 workflow 单文件 apply。
- postflight：比较前后权限；验证非空序位正数/唯一/覆盖，获赞与取消到零赞不重编号，新作品 NULL；实际 PostgREST `initial_feed_order::text` 与 NULL 混合方向游标、跨段 limit+1/字面搜索回归；1x/10x 合成规模首页/深页/搜索 EXPLAIN、点赞索引写成本与锁等待。仅保存结构/汇总，不提交业务行。
- 发布：TEST migration → Backend → Frontend → 真机/性能 → 独立 Production 审批；各环境独立初始化，不能复制 TEST 序位。当前没有执行任何远端迁移。
- 恢复：先回退 Frontend/Backend 到旧协议，保留新增列/索引（旧版本兼容）；初始迁移失败整笔回滚，结果未知先核对列/账本，禁止 force_rerun 重新编号。确认无消费者后才另审 DROP 索引/约束/列；错误初始化用独立 forward-fix 和新游标版本，不能删作品/点赞恢复。

**改库只有 GitHub Actions `Database Migration` 一条路。** 它才会查、写 `supabase_migrations.repo_migrations` 账本。

仓库 Secrets：

| Secret              | 用途                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| `TEST_DATABASE_URL` | test 库 **Session pooler** 连接串（端口 5432），必须包含 `zoqelpfhurwehlvypryl`    |
| `PROD_DATABASE_URL` | production **Session pooler** 连接串（端口 5432），必须包含 `wbtsfzozlmurljvglhpn` |

> Action 用 `psql -f` 执行整份 SQL（`supabase db query` 不能跑多语句文件）。直连 `db.*.supabase.co` 是 IPv6-only，GitHub-hosted runner 连不上。`SUPABASE_ACCESS_TOKEN` 只给本地 CLI 用，这个 workflow 不读。

步骤：GitHub → Actions → `Database Migration` → 选 `mode` 与 `environment`。

- **inspect**：只读。把日期命名迁移的 sha256 和 `repo_migrations` 对账，并探 R3 发奖入口、111 `st_handle` 是否可空、A 的结算两列。生产同样要填 `confirm_production`。
- **apply**：填 `migration_file`（如 `packages/shared/migrations/20260910_schema_migrations_ledger.sql`）。生产必须在 `confirm_production` 填 `RUN_PRODUCTION_MIGRATION`。查账本、执行、记账在同一次调用里；已执行且 checksum 一致会报 `MIGRATION_ALREADY_APPLIED`；文件被改过报 `MIGRATION_CHECKSUM_DRIFT`（写新迁移，不要改旧文件再跑）。`force_rerun` 只在文件未改时重跑 SQL，不覆盖首次记账。生产会拒绝 `104_rollback_voice_billing.sql`。`media_plaza` 视频 seed 文件按 `_seed_test_` / `_seed_production_` 与环境强绑定；TEST seed 还由 workflow 向单次 `psql` 会话注入 project ref 和 Storage 核验确认，禁止绕过 workflow 直接执行。
- **abandon_claim**：仅用于“SQL 已回滚/失败、没有账本成功行、原文件在失败认领后被修订”的恢复。先执行 `20261013_repo_migration_claim_recovery.sql`，再选择原 `migration_file` 并填写 `claim_abandon_reason`；脚本会在一个事务中锁定认领、复核无账本且 checksum 漂移、记录旧/新 checksum 与原因，然后删除认领，**不会执行目标 migration SQL**。之后才能以修订文件正常 `apply`。不得把它用于已记账文件、同 checksum 的可续跑认领，或代替生产问题排查。

应用启动**不会**自动跑 SQL；`packages/backend` 的 `start` 只做 `prisma generate`。workflow 校验 project ref：test 只能连 `zoqelpfhurwehlvypryl`，production 只能连 `wbtsfzozlmurljvglhpn`。

不要用的方式（不记账，不能当现行通道）：

- Supabase Studio SQL Editor、Management API 直改表结构
- 按历史三位数字前缀在 Studio 里手跑
- 本地 `pnpm supabase:db:query --file …` 对着远程库执行（仅排障时用，事后必须补账本）

### 本地 CLI（查询 / 调试）

SQL 源只在本目录；不要复制到 `supabase/migrations` 变成第二套来源。

```bash
pnpm supabase --version
pnpm supabase:status
pnpm supabase:start
pnpm supabase:stop
pnpm supabase login
pnpm supabase:link:test
pnpm supabase:link:prod
```

查库（不是发布）：

```bash
pnpm supabase:db:query -- --db-url "$DATABASE_URL" --file packages/shared/migrations/20260910_schema_migrations_ledger.sql
```

## 命名与账本

- **2026-09-10 起**：`YYYYMMDD_描述.sql`。存量三位编号文件锁死，新增编号会被 CI 拒绝（`scripts/check-migration-filenames.mjs`）。
- **账本** `supabase_migrations.repo_migrations`（建表：`20260910_schema_migrations_ledger.sql`）：workflow `apply` 执行前查重，已有记录且 checksum 一致则拒绝（`force_rerun` 可再跑 SQL，但不改首次 `applied_at` / checksum）；checksum 不一致拒绝，即使勾了 `force_rerun`。成功后写入 `filename / checksum / applied_by`。`20260914_repo_migration_ledger_events.sql` 补 `repo_migration_claims`（执行中认领）和 `repo_migration_events`（含 force_rerun 历史）；`20261013_repo_migration_claim_recovery.sql` 增加不可绕过的失败认领废弃审计。放在平台 schema，不进 `app_core`。不要用同 schema 下 CLI 的 `schema_migrations`（列是 `version`，没有 `filename`）。账本表不存在时，除账本迁移本身外会失败，不再静默放行。
- 账本只覆盖 2026-09-10 之后的新迁移，不回填更早历史。
- 查环境：Actions `mode=inspect`，或 `SELECT * FROM supabase_migrations.repo_migrations ORDER BY applied_at DESC`。
- 已执行文件被改过：用**新迁移**表达修正，不要改旧文件再跑。
- 本地协议回归（本机 Postgres，不连远程）：`pnpm test:migration-ledger`。

顺序依赖写在各文件头部「前置」，不要按文件名序号推断。并行分支撞号的存量（021/030/031/032/053/065/086/088/092/093/095 与 105/108/109）**同号含义可以不同**。099 已在 test 与生产执行完毕；其执行剧本是历史文档，见下方。

### 文本后处理版本（按环境账本核对后逐文件执行）

按顺序、一次一个文件：

1. `20260928_text_postprocess_versions.sql`：`app_core.text_postprocess_versions` 与 `miniapp_text_postprocess_config` 的专用草稿/发布/回滚/放弃事务。
2. `20260928_chat_history_postprocess_version.sql`：`experience.chat_history.postprocess_version`、当前消息视图和开轮 wrapper。必须在第 1 个文件成功之后执行。
3. `20260929_fix_text_postprocess_writer_guard.sql`：将专用 writer guard 改为事务本地设置，修复 PostgREST service role 跨 SECURITY DEFINER 边界时的误拒绝。必须在第 1 个文件成功之后执行。
4. `20260929_grant_text_postprocess_snapshot_insert.sql`：恢复专用发布 RPC owner `postgres` 对版本快照表的最小 `INSERT` 权限；`service_role` 保持只读，直接写仍由既有 trigger 拒绝。必须在第 1 个文件成功之后执行。
5. `20260929_grant_text_postprocess_snapshot_read.sql`：恢复对话开轮 wrapper owner `postgres` 和 Backend `service_role` 对版本快照的最小 `SELECT` 权限；要求两个 wrapper 仍为 `postgres` 所有的 `SECURITY DEFINER` 函数，拒绝未知 owner。必须在第 1、2 个文件成功之后执行。
6. `20260929_fix_text_postprocess_snapshot_fk_lock.sql`：补 owner `postgres` 的 `UPDATE(version)`，满足版本外键的 `SELECT FOR KEY SHARE` 权限检查；撤销 API 角色额外的表/列写权限，恢复 `service_role` 只读。保留 RLS、FK 和 ALWAYS 不可变触发器，无回填。要求第 1、2 个文件和既有授权修复完成；失败事务回滚，提交后采用 forward-fix，不恢复宽泛授权。
7. `20260930_fix_system_instructions_text_value_validation.sql`：恢复 Admin 平台规则模板使用 `text_value`、`value=NULL` 的既有契约，修复后续 validator 包装链把它误送入 JSON-only 守卫的问题。只替换最外层校验函数，不改配置数据、草稿、正式版本、RLS/grant 或富文本快照；迁移内验证合法文本、错误存储列、空值、缺失占位符及既有 VIP 分支。TEST 单文件执行和 Admin 保存/发布回读通过后才能继续 MiniApp 验收；Production 独立审批。
8. `20260930_bind_current_text_postprocess_on_turn_start.sql`：新增发送/重生成 current-postprocess RPC，在既有开轮事务内读取 `runtime_config` 权威指针、校验不可变 artifact 快照并绑定非空版本。保留旧显式 wrapper 的 `NULL=不绑定` 语义；新 Backend 必须在本文件之后发布，RPC 缺失或当前配置非法时不得降级开轮。无 backfill/表重写；TEST 冷启动首发通过后才规划 Production。
9. `20261013_accept_rich_reply_protocol_artifact.sql`：使发布/回滚的 artifact 守卫接受编译器写入的 `rich_reply_protocol` 描述符（版本 1 或 2，含 `enabled`）。不改草稿、正式指针或历史快照；先 TEST 单文件执行并完成一轮规则发布/真实生成验证，再单独审批 Production。

本地 SQL 回归应使用非 superuser 的 `postgres` 执行迁移（具备本地建库/建角色权限），另设隔离实例的 superuser `TEXT_POSTPROCESS_TEST_ADMIN` 执行恶意写入/replica 场景。例如在明确的本地 Unix socket 上运行 `PGHOST=/path/to/local/socket PGUSER=postgres TEXT_POSTPROCESS_TEST_ADMIN=local_test_admin bash packages/shared/migrations/tests/run-text-postprocess-t2.sh`。不要降权或修改共享开发实例已有角色；使用临时隔离实例。runner 覆盖缺失行锁权限、额外授权收敛、迁移重跑、非空/NULL 开轮、重生成、不可变快照、CAS、事务回滚和并发锁。

artifact 修订（2026-09-29，仍未执行远端）：首个文件在版本表新增 `artifact jsonb`，Backend 可终止 Worker 在事务前编译；publish/rollback 显式传 `p_source`、`p_artifact`，快照与当前指针/release/audit/draft 原子绑定。runtime config 不放 artifact。旧本地表通过 `ADD COLUMN IF NOT EXISTS` 与 `NOT VALID` CHECK 保留 NULL 历史；新行必须非 NULL，旧行在 MiniApp unavailable，不读时编译、不回填、不替代版本。历史 UPDATE/DELETE/TRUNCATE 无角色例外，trigger 为 `ENABLE ALWAYS`；恶意最高权限 DDL 仍不属于应用权限防护能力。

专用签名：`admin.publish_text_postprocess(uuid,uuid,text,integer,timestamptz,text,text,jsonb,jsonb)`、`admin.rollback_text_postprocess(uuid,uuid,text,integer,integer,jsonb,jsonb)`；最后两参数是 source/artifact。旧重载删除。SQL 对完整 payload 计算 SHA-256 request identity，source/artifact 不同必须冲突；Backend 重放读 outcome 的明确版本，不重新编译。未知结果仍查询原 request_id。

本地 runner 只接受 Unix socket；覆盖 fresh/replay/CAS/原子性、postgres/service_role/SECURITY DEFINER/replica session、旧无 artifact 表/旧重载、重跑、补丁漂移停止及恢复。TEST 仍须逐文件 preflight/apply/postflight 和业务读写验证；本修订不能证明远端 shape。

不播种规则，不回填旧消息，不改历史 migration。已有引用时不要 DROP 快照或该列。本地协议场景是 `fixtures/text_postprocess_t2_harness.sql` 加 `tests/text_postprocess_t2_scenarios.sql`，只对临时库执行，不能当作远端发布。

## 签到分档 forward-fix（2026-10-26，未部署）

**禁止**再对 TEST/Production 执行 `20261014_checkin_tiered_rewards.sql`：它会用静态白名单整表替换 `admin.is_managed_config_key`，在已有 `reply_style_options` 等草稿时触发 `config_drafts_config_key_check` 23514，并可能收窄图片广场等后续 key。

改用环境专用 safe 文件（单调 OR 包装白名单 + 扩 CHECK + VIP 对象转绝对整数 + `claim_daily_checkin`）：

| 环境                              | 文件                                             | VIP 绝对额默认                                | 说明                                                    |
| --------------------------------- | ------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------- |
| TEST `zoqelpfhurwehlvypryl`       | `20261026_checkin_tiered_rewards_test.sql`       | `150`（可保留已有 number / `fixed_credits`）  | 先 workflow inspect，再单文件 apply；禁止 `force_rerun` |
| Production `wbtsfzozlmurljvglhpn` | `20261026_checkin_tiered_rewards_production.sql` | `90`（2026-10-26 只读确认自 `fixed_credits`） | TEST 成功并验收后再独立审批；禁止套用 TEST 的 150       |

两文件不可交叉执行。前置：`claim_daily_checkin`、VIP validator、`config_drafts/releases` 已存在；已有 `*_before_checkin_tiers` 前置函数会拒绝重跑。成功后 Admin 校验签到三键保存/发布，抽测 VIP/新用户/老用户领取；应用回退保留新 RPC 语义，配置用 Admin 发布调整，勿恢复 object 形 `vip_checkin_bonus_config`。

## 图片广场白名单恢复（2026-10-16，未部署）

`20261016_reconcile_image_plaza_managed_config_keys.sql` 修复平台规则静态白名单覆盖图片广场四个 key 的回归，同时保留现有合法 key、CHECK 表达式、验证状态与 validator 链。前置为 `20261012_image_plaza_v2.sql`；若计划部署 10/13 平台规则、10/14 标签开关迁移，先完成这些文件，再执行本恢复文件，勿倒序覆盖。

1. 在已确认 TEST 中只读核对三个相关 migration 的账本、函数定义/owner/ACL、两表 CHECK/验证状态与表大小；未知 shape 停止。当前 MCP 无 TEST 访问权限，仓库声明不代表实况。
2. 经 `Database Migration` workflow 选择 TEST，单文件 apply 本迁移，不用 SQL Editor 改库。一次性执行，禁止 `force_rerun`；已存在恢复前置函数会拒绝。
3. 内置自检检查四个 key、两表真实 CHECK、未知 key 拒绝、其他 key 行为不变、合法配置通过与非法配置拒绝。锁等待 5 秒/语句 60 秒，失败整笔回滚；不自动重试。锁超时先检查写流量/表容量。
4. 只读复核以下 SQL；在 Admin 保存模型/标签/分享提示草稿并回读，确认保存不更改正式配置；分别验证发布、历史恢复、平台规则/标签功能开关与 viewer 拒写。生产独立审批。

```sql
SELECT key, admin.is_managed_config_key(key) AS allowed
FROM unnest(ARRAY[
  'image_plaza_enabled', 'image_plaza_model_catalog', 'image_plaza_share_tip',
  'image_plaza_tags', 'image_plaza_tags_feature_enabled',
  'system_instructions', 'choice_rules', 'status_rules', 'memory_rules',
  'llm_model_catalog', '__unknown_config_key__'
]) AS keys(key);
-- 前置迁移齐全时合法 key 为 true，未知 key 必须 false。
SELECT conrelid::regclass, conname, convalidated, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN ('admin.config_drafts'::regclass, 'admin.config_releases'::regclass)
  AND conname IN ('config_drafts_config_key_check', 'config_releases_config_key_check');
SELECT oid::regprocedure, pg_get_userbyid(proowner) AS owner, proacl,
       pg_get_functiondef(oid)
FROM pg_proc
WHERE pronamespace = 'admin'::regnamespace
  AND proname LIKE 'is_managed_config_key%';
```

无业务行写入/回填，RLS/表 grants 不变。重建已验证 CHECK 可能扫描历史行并持有 ACCESS EXCLUSIVE，低峰执行。提交后采用新 forward-fix 保留兼容范围，勿删历史记录或恢复旧窄白名单；应用回退无需回退此兼容迁移。

## Prisma

```bash
cd packages/backend
npx prisma generate
```

099 之后 `schema.prisma` 的 `schemas` 是 `["app_core", "miniapp_features", "billing"]`。`experience` / `cs_platform` 等无 Prisma model 的域走 `getDomainDb` 或全限定 SQL。

## 历史（不是现行规则）

下列文件已从工作区删除，需要时从 git 取回，并标明那是当时的决策而不是现在的权威：

| 内容                                     | 取回                                                  |
| ---------------------------------------- | ----------------------------------------------------- |
| 八域归属原稿                             | `git show 7541a54^:docs/schema归属地图.md`            |
| 099 执行剧本                             | `git show b4491cd^:docs/schema划分-一阶段执行计划.md` |
| ST 三 schema / DECISIONS 时代的本 README | 本文件改版前的 git 历史                               |

`st_platform` / `st_users` / `st_infra`（088）、`growth`（089）、`miniapp_simulation`（090）已删库。不要按「D014 三 schema」或「Studio + 数字前缀」执行新变更。

### 20261026_first_token_stage_budgets.sql

在20261023首token配置迁移之后，添加nullable兜底阶段时限、客户端实际等待、服务端超时阶段；扩展配置校验、原begin/report函数和invoker分析投影，不回填历史策略，不新增授权。TEST通过后单文件生产执行，再发布Backend/Admin、运营4/2/10配置、Frontend及v2看板。保留列/历史回滚应用，禁止改写旧迁移或releases。验证用`scripts/test-first-token-fallback-local.sh`（隔离本地PG17/PostgREST、reader ACL、身份/账务与v2失败率）。

# 短剧启动分析（2026-10-27，待远端执行）

`20261027_drama_playback_observability.sql` 仅新增 miniapp_analytics 的观察表、原子合并RPC、只读事实view、reader授权及初始关闭的有界清理job。无业务外键/写入，service_role写、浏览器角色无权限，Grafana只读；摘要14天/明细7天。先用 `bash scripts/test-drama-observability-local.sh` 验证本地PG17，再独立核对TEST/生产shape，通过Database Migration单文件流程执行。Backend开关默认false，迁移后才启用；回退关闭开关/清理job、撤reader，保留表，无业务数据恢复。详见 [发布与验收](../../../docs/grafana/drama-playback-runbook.md)，源码不代表已迁移。

## 短剧生产 cron 权限 forward-fix

原 `20261027_drama_playback_observability.sql` 的production事务在直接UPDATE cron.job时被Supabase托管权限拒绝并回滚，源文件/失败认领不改写。新安装或恢复改为单独执行自包含 `20261027_drama_playback_observability_forward_fix.sql`，只将cron关闭动作替换为官方cron.alter_job；本功能对象/权限/数据策略不变。执行前确认对象回滚、目标函数存在且迁移角色可执行；job保持inactive。

## 签到自然日更新（2026-10-30，本地验证，远端未执行）

`20261030_checkin_calendar_day.sql` 仅替换 `miniapp_features.claim_daily_checkin(uuid)` 的时间表达式，保留当前奖励配置、owner/ACL、事务和唯一入账出口。按北京时间每天00:00恢复资格，旧记录按日期自然兼容，无回填。CRLF规范化；旧锚点不是恰好一处则全事务拒绝，完整重放无操作；锁5s/语句30s。

TEST先经Database Migration workflow逐文件执行、验证，再经授权生产迁移 → Backend → Frontend。隔离回归：`bash scripts/test-vip-billing-migrations.sh`。恢复用受审阅forward-fix同步RPC/Backend回滚动24h，已领余额/流水保留。不可重跑旧分档迁移，以免覆盖运营已发布数额。

### 20261102_chat_message_overrides.sql（本地候选，未远端执行）

experience 域增加会话局部消息覆盖，`change_chat_message` 仅允许所属会话最近十轮，用户/角色消息独立编辑或软删除，版本比较与会话锁防覆盖；不会新增生成/扣费事实。修改 `session_chat_history` 作为显示/入模的一致投影，新分支冻结覆盖，旧分支保持独立。删除不重排轮号，已删除用户输入不能重生成。已有窗口 A/B 不变。
先运行既有隔离 PG17 分支脚本验证权限、幂等、并发、分支、删除、计费事实不变；后续按单文件 TEST -> production migration -> Backend -> Frontend 发布。停用入口可止写，但不得回滚成旧投影导致已删除内容重新显示；保留覆盖表并 forward-fix。线上迁移与真实供应商缓存命中尚未验证。

### 20261102_lobby_quality_rotation.sql（本地候选，未远端执行）

新增miniapp_features个人推荐批次和角色曝光摘要，RLS开启、撤销浏览器访问、service_role受控CRUD；角色评分扩展qualified-v1可信历史，绝不回填旧评分。增量包装运营validator、保留owner/ACL/grant option/既有校验，重复执行不覆盖后续包装。无现有业务行重写或正式配置变更。

顺序：先隔离PG17验证（`pnpm test:lobby-ranking`），未来通过既有workflow先TEST单文件，再独立批准Production；应用发布后直接全量轮换，核验qualified-v1评分刷新；新证据未就绪时沿用旧排序。缺迁移不得发布新job。出现失败回退推荐消费者，保留表/可信历史，不自动DROP或清理用户状态。20s语句/3s锁预算，远端运行前另核前置shape和表锁预算；本地通过不等于远端已执行。

### VIP 混合奖励（2026-11-05）

`20261105_vip_mixed_rewards.sql` 先经测试环境再生产执行，随后发布应用，最后通过运营 CLI 发布混合签到与开卡赠礼配置。旧签到数字及旧订单继续兼容；开卡奖励使用订单两钱包快照，同事务入账且不增加实付收入。回退先恢复旧配置，保留混合发放支持处理在途订单。详见 `.trellis/tasks/11-05-vip-mixed-rewards/`。
