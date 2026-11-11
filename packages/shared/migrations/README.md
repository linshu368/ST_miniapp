# SQL 迁移文件

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
- **apply**：填 `migration_file`（如 `packages/shared/migrations/20260910_schema_migrations_ledger.sql`）。生产必须在 `confirm_production` 填 `RUN_PRODUCTION_MIGRATION`。查账本、执行、记账在同一次调用里；已执行且 checksum 一致会报 `MIGRATION_ALREADY_APPLIED`；文件被改过报 `MIGRATION_CHECKSUM_DRIFT`（写新迁移，不要改旧文件再跑）。`force_rerun` 只在文件未改时重跑 SQL，不覆盖首次记账。生产会拒绝 `104_rollback_voice_billing.sql`。
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
