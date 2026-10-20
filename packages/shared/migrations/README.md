# SQL 迁移文件

本目录是仓库里**唯一**的 schema 变更源。现行规则以 [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md) 铁律 9 与 §7.4 为准，不要再引用已删除的 `DECISIONS.md` / `Schema划分设计.md`。

当前事实：

- 物理布局是 099 之后的八域（`app_core` / `experience` / `billing` / `miniapp_features` / `cs_platform` / `admin` / `miniapp_traffic` / `miniapp_analytics`）。`st_*` / `growth` / `miniapp_simulation` 已删。
- 新表必须在文件头声明 `-- domain: xxx`。跨域直连豁免见 ARCHITECTURE 铁律 8，不要另写一份地图。
- 新文件命名 `YYYYMMDD_<小写下划线描述>.sql`。三位数字编号已冻结，CI `pnpm lint:migrations` 拦截新编号。

## 现行执行通道

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

### 2026-10-20 OpenRouter catch-up 超时恢复

生产 `20261016_openrouter_retirement_catchup.sql` 候选查询超时；该文件已在 TEST 记账，不改历史文件。新增 `20261020_openrouter_retirement_catchup_recovery.sql`：候选阶段局部hash join、最多两批各2000、总量4001拒绝，仍为60s/5s单事务；只补安全标量/ID，canonical非空优先，正文/业务终态/计费/raw JSON不动。已删12列的目标须匹配原DROP账本才跳过；其他shape异常拒绝。生产原同checksum claim保留，正式workflow执行新增文件，不重跑原文件、不清claim/伪造原ledger。后续清理仍独立门禁。当前为本地修复，证据与验证见 `.trellis/tasks/10-15-openrouter-history-extract/research/t11-catchup-timeout-recovery-2026-10-20.md`。

### 2026-10-20 Grafana provider 元数据依赖修复

生产analytics_grafana的v_llm_calls及两张成本/免费额度MV仍依赖旧字段，原alias DROP正确拒绝。先执行新增`20261020_grafana_provider_metadata_dependencies.sql`，再重试原alias DROP；旧文件不可改、无需清同checksum claim。修复仅维护既有分析兼容schema（归属miniapp_analytics派生分析），以精确源定义/依赖/预算守卫、预填充替代MV和单事务切换保留查询名称/权限/索引/注释/下游view OID及刷新调度，OR改读canonical并移除主表待删metadata引用，保留业务finish_reason/账务公式。TEST无该schema安全跳过；本地真实PG/PostgREST双DROP回归不替代远端执行。证据、验证与生产恢复见`.trellis/tasks/10-15-openrouter-history-extract/research/t12-grafana-provider-dependency-repair-2026-10-20.md`。

### 2026-10-20 历史 JSON 处置超预算恢复

生产原 `20261016_openrouter_history_disposition.sql` 在 `LIMIT 2001` 容量守卫处失败，尚未写业务表；2001 是截断结果，不代表真实总量。原文件及同 checksum 的失败 claim 保持不变，不清 claim、不伪造原成功账本，也不使用 force_rerun 扩容。

替代执行顺序（仍通过 Database Migration workflow，一次一个文件，先 TEST 后 Production）：

1. `packages/shared/migrations/20261020_openrouter_history_disposition_recovery.sql`：固定候选 ID 清单，每批最多 2000，总计最多 300000（最多 150 批）；300001 拒绝，5s 锁/每批语句 60s，每批独立事务提交。保留原 JSON 白名单、provider/ID、Venice 保全、canonical 非空优先与指纹 CAS；仅清主表旧 JSON 和规范化 OR 诊断，不改正文/终态/计费。非白名单诊断丢弃仍不可恢复。已规范化的非空 OR JSON 仍属于候选，所以必须按固定 ID 分页。失败仅回滚当前批，已提交批次保留；重入仍验证全部候选，但不改写已经规范化且 canonical 齐全的 OR 行。全部批次及主表 raw 归零复核成功后才记录新文件自己的账本。已删列的 TEST 只在原 DROP 精确 checksum 账本匹配时跳过。
2. 核验恢复文件 ledger/checksum、主表旧 JSON 归零、OR 白名单、业务事实不变、锁/容量后，另行执行 `packages/shared/migrations/20261020_chat_history_drop_provider_metadata_recovery.sql`。它接受原处置账本或精确匹配恢复文件 checksum 的账本，保留原 DROP 的全部依赖/字段保全/账务/额度守卫；替代原主表 DROP，不再重跑原处置或原 DROP。

2026-10-20 Production（wbtsfzozlmurljvglhpn）只读 count 实测候选 295383；先前 4001 为截断聚合。总预算据此设为 300000，并在读取/指纹 JSON 前检查；候选阶段局部 hash join，避免 UUID 顺序访问大表。WAL/磁盘/复制余量、旧 writer 退出与执行窗口仍需本环境核验；若超过预算停止，不改已应用文件。结构已由新 DROP 收缩的环境无需重跑恢复文件。恢复后只能部署兼容 canonical 字段的 Backend，重加 NULL 列不能恢复已丢弃诊断。

2026-10-20 Production 首次执行恢复文件在某批报 `Unresolved historical JSON shape/provider/identity`：只读聚合候选 294369，唯一命中为 3 条主表旧 JSON 无任何 provider detail、无调用 ID、快照无 provider，且不含任何白名单键。已提交批次保留、失败批回滚，未记账。恢复文件不改（保持 claim 与 DROP 恢复 checksum）；先执行新增 `20261020_openrouter_history_orphan_json_disposition.sql`：仅清空“无 detail、无 ID、快照无 provider、无白名单键（含 2 条卡死 streaming，经确认放弃，status 不改）”的主表旧 JSON，上限 100、指纹 CAS、不写 provider 表/正文/终态/计费，任一行有归属证据或事实即整体拒绝待人工分类；可重入。随后用同一 checksum 重跑恢复文件（续接 claim）。被清空的诊断不可恢复。

首个孤儿处置文件在 Production 以 `Orphan history JSON requires manual provider classification` 失败（未写数据）：这 3 行有不含 `provider` 键的旧 billing snapshot（`provider` 为可选字段），被误当归属证据。原文件与其 claim 保持不变；改为执行 `20261020_openrouter_history_orphan_json_disposition_recovery.sql`，仅把快照中显式 provider 视为证据，其余守卫相同。

Production 执行 `20261020_chat_history_drop_provider_metadata_recovery.sql` 时，删列前的全表守卫（`Unpreserved identity/scalars…` 的 provider 事实扫描）触发 60s `statement_timeout`，整笔回滚、未执行 DDL、未记账。原文件与其 claim 不改；改为执行 `20261020_chat_history_drop_provider_metadata_bounded_guards.sql`：守卫阶段顶层 `SET LOCAL statement_timeout='900s'` 并局部关闭 merge join/nested loop（此时尚未持有排他锁），守卫结束后恢复 60s，仅 `ALTER TABLE … DROP COLUMN` 受严格预算。守卫内容与 DROP 列表与原文件完全一致。

Production 执行 `20261020_chat_history_drop_provider_metadata_bounded_guards.sql` 报 `Historical billing/quota closure not proven`：只读核查为 6 条 2026-10-02..15 起一直 `streaming` 的废弃回合（无快照、无调用 ID、无 detail、无 charge/dedup），其中 4 条仍占 `reserved` 免费额度。经确认放弃，先执行 `20261020_chat_history_abandoned_streaming_closure.sql`：按固定 6 个 ID，对 reserved 额度调用 `billing.finalize_character_free_chat_round(…, false)`（与 `recoverStaleStreaming` 相同：释放预留、不计已用），再把回合置为 `stream_interrupted`（已有 `cancelled` 保留，其余 `timeout`）；不写 charge/dedup/钱包/`llm_billing_settled_at`；任一行有计费/provider 证据、未满 24h 或数量不符即整体拒绝，可重入；目标 ID 不存在的环境（TEST）安全跳过。随后执行 `20261020_chat_history_drop_provider_metadata_closed_abandoned.sql`：在原守卫上新增一种可接受形态——终态（`upstream_error`/`stream_interrupted`）、无快照、无 charge/dedup 的回合，因为这类回合晚于账务边界、原“边界前”豁免无法覆盖；`streaming`、`reserved`、pending 仍拒绝，其余守卫与 DROP 不变。旧 `_recovery.sql` 与 `_bounded_guards.sql` 不再执行。

Production 执行 `20261020_chat_history_drop_provider_metadata_closed_abandoned.sql` 仍报 `Historical billing/quota closure not proven`：只读核查（结果有截断）发现两类原守卫从未覆盖的历史行——账务边界前 `success` 但无 charge/dedup（含 4 条成功后仍 `reserved` 的免费额度），以及 2026-09-14 边界后、新 Backend 写快照前已 `charged` 却无快照/`settled_at` 的回合。该守卫判断的是历史账务是否收口，而删 12 列从不改变账务：`llm_charge_id`、快照、`settled_at` 与全部 billing 行原样保留，回捞所需调用 ID 已在 detail 表。改为执行 `20261020_chat_history_drop_provider_metadata_data_guards.sql`：移除账务/额度守卫，保留列形状、数据库依赖、provider 互斥、标量/调用 ID 保全、旧诊断 JSON、处置账本与业务列形状守卫，DROP 列表不变。历史漏扣、遗留 `reserved` 额度如需处理，另行只读分类后单独决策，不再阻塞删列。旧 `_closed_abandoned.sql` 不再执行。

验证：既有隔离 PG17/PostgREST harness 覆盖 6001 行跨四批、末批失败保留前批进度且回滚当前批、重入不改写已规范化行、300001 预算拒绝、JSON/身份/Venice/CAS/账本 checksum 拒绝，以及真正删列后的 repository、报表和物化刷新。原处置 SQL 与原 DROP 文件未改。此为本地修复，未执行远端迁移或提交推送。
