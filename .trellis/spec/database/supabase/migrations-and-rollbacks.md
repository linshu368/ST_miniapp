# 迁移、发布与回滚

## 文件与不可变性

- 新 SQL 只添加到 `packages/shared/migrations/`。2026-09-10 起统一命名为 `YYYYMMDD_描述.sql`，并通过 `pnpm lint:migrations` 校验；三位编号文件属于冻结历史，不得继续编号、改名、编辑、重排或“清理”，也不得按编号推断依赖和环境执行状态。
- `supabase/config.toml` 当前 `schema_paths=[]`，本地 reset/push 不会自然代表 shared migrations 的执行链；必须使用项目约定的手工流程。
- 远端 test/production 的正式入口是 `.github/workflows/db-migrate.yml` 的 `workflow_dispatch`：一次选择一个 `packages/shared/migrations/*.sql`，保留 project-ref 校验、production 明文确认、environment concurrency 和执行摘要。本地 CLI 仅用于明确授权的本地/诊断场景，不能绕开工作流门禁。
- workflow 使用 `psql --no-psqlrc --set ON_ERROR_STOP=1 --file` 执行完整多语句文件。执行前按 filename 查询 `supabase_migrations.repo_migrations`，成功后记录 filename、checksum 与执行者；它是仓库迁移账本，不得与 Supabase CLI 自有 migration history 混淆。`force_rerun` 只能用于已审查的显式恢复场景。

## 设计必填

每个 migration 在 design/implement 中写：目标对象和 schema、前置 shape、数据量/锁、事务和幂等、backfill 批次、应用兼容顺序、RLS/grant、测试 SQL、失败停止条件、回滚或 forward-fix。

## 执行顺序

1. 对测试目标采集/验证前置 shape；
2. 审查 SQL，无 DDL/DML 误指生产；
3. 单文件执行；
4. 验证对象、约束、权限、关键读写和性能；
5. 记录结果后再进入下一文件；
6. 生产执行需独立确认，不因测试成功自动执行。

GitHub Actions 操作前再次核对 workflow 版本、目标 environment secrets 和输入文件；禁止把数据库 URI 复制到 issue、日志补充或任务 Markdown。

## 安全变更模式

- 破坏性字段采用 expand → 双兼容/回填 → consumer 切换 → contract；不得同次先删后发。
- 大表索引/约束评估 concurrent、NOT VALID/VALIDATE、statement/lock timeout 和 Railway/Supabase 连接影响。
- migration 应可重复检测目标 shape；不能真正幂等时明确“一次性”及安全失败条件。
- 回滚可能丢数据时优先 forward-fix；任何恢复步骤都写明数据损失边界和备份前提。
- 文本后处理迁移/应用顺序固定为版本/草稿与显式 wrapper → artifact/权限 forward-fix → current-postprocess 开轮 RPC → Backend → Frontend/Admin。已发布快照和被 history 引用的版本不得 DROP/改写；应用回退保留数据对象，配置恢复通过发布新版本，数据库缺陷使用 reviewed forward-fix。

## OpenRouter 兼容发布门禁

`20261015_openrouter_chat_history.sql` → `20261015_openrouter_chat_history_backfill.sql` → `20261015_openrouter_chat_history_venice_exclusion_backfill.sql` → `20261016_openrouter_original_metadata_fields.sql` → 新 Backend。每个文件核验账本/checksum、shape/FK/unique/index、ACL、回填聚合与锁/容量后才能继续；初始表的 provider 常量约束会被第三份修正，中间态不可部署新 writer。

旧主表列/视图保留仅是兼容阶段，不能作为清退任务完成。2026-10-16 新增阶段须交付主表 12 列（不含业务 `llm_finish_reason`）的消费者切换及独立 DROP migration；专表旧别名在用户T9明确扩展后纳入独立contract，保留ID/data现名。视图必须按对应 provider 专表取值并保留类型/基数/ACL/security_invoker，不能用 CASCADE 解决依赖。四类删列门禁为应用无引用、DB 无依赖、实际运行无旧读写及历史/窗口覆盖；删列后旧 Backend 不能直接回退，需已验证兼容 SHA 或受审阅 forward-fix。三份 SQL 已本地实现并通过真实 PG17/PostgREST 删列回归；未在远端执行，见本任务 T8 报告。新 writer 不持续反写别名；回退旧 Backend 不能使这些新数据自动同步回旧列。切换窗口须按最后旧 writer/首个新 writer 的实际时间审计，24h 回捞外的数据另审 catch-up。

测试库小样本成功不代表大生产表可用相同单事务回填。先取得本环境候选规模/查询计划、锁与 WAL/磁盘预算；文件 1/2 无内置 timeout，未验证生产规模前停止执行。结果未知须互证 SQL 提交与 ledger/claim/event，禁止盲重跑或 force_rerun 修漂移。完整可审阅方案见 `.trellis/tasks/10-15-openrouter-history-extract/production-release-checklist.md`；该路径是本任务方案，不是已执行证明。

## Scenario: chat_history 12 列 contract

### 1. Scope / Trigger

只删除调用元数据，保留主表 llm_finish_reason/业务 model/计费事实；专表11重复别名另用独立contract，不重跑已记账历史 SQL，不改 Venice 表/mapper。

### 2. Signatures

新增 shared migrations：20261016_openrouter_retirement_catchup.sql → 20261016_chat_history_provider_metadata_views.sql → 20261016_chat_history_drop_provider_metadata.sql。先部署无旧列依赖 Backend/旧副本退出和窗口覆盖，再逐文件迁移；最后 DROP 独立审批。

### 3. Contracts

catch-up 只补经证明归属的安全标量/ID、只填 canonical 空值，不搬 raw JSON/正文/主表业务 finish reason，候选超过 2000 拒绝另审分批。current/已有 analytics view 保留列名/序/类型/基数、owner/ACL/security mode；按对应 provider 专表取值，current invoker 所需 reader 仅补最小列权限。新 streaming 调用若有专表占位且主表旧字段为空，不应被历史结算门禁强制中断。

### 4. Validation & Error Matrix

重叠/ID 冲突/未保全标量/未知 provider/DB 依赖/旧 raw JSON 未审阅/历史计费未收口 → 整笔拒绝；锁 5s、语句 60s，失败/结果未知先核对 shape 与 ledger/claims/events，不盲重跑。SQL 不能替代应用无依赖、DB 无依赖、运行无旧列读写、历史/切换窗口覆盖四类外部证据。

### 5. Good/Base/Bad Cases

Good：TEST/Production 分别记录覆盖与容量/锁证据，再独立 DROP RESTRICT 12 列。Base：无 ID 历史先分类；无信息不伪造 ID，有可靠归属/安全字段可建 NULL-ID 明细，未知阻断删除。Bad：把 TEST 165 当生产事实、旧 raw JSON 直接搬运/置空、DROP CASCADE 或为了删列暂停/破坏正常新对话落表。

### 6. Tests Required

scripts/test-openrouter-retirement-local.sh（PG17 + 显式本地 PostgREST 路径）证明物理 DROP 后实际 repository 读写、视图字段/基数/权限、未知/JSON/历史结算/依赖/重复执行拒绝，和正常新 streaming 状态保留；原 expand/ledger 回归继续通过。真实上游/钱包/额度/外部分析 owner 与所有旧副本退出仍单独核验。

### 7. Wrong vs Correct

Wrong：DROP 后回滚旧 Backend，或声称会立即回收磁盘。Correct：仅回退到已验证无 12 列也能运行的 SHA，或受审阅 forward-fix；恢复旧应用须另审列/安全事实重建，空列不等于数据恢复；无 VACUUM FULL/表重写。

## Scenario: OpenRouter 专表 11 别名 contract

`20261016_openrouter_chat_history_drop_legacy_aliases.sql` 要求所有共享库旧 writer 退出、11组shape匹配、零非空冲突、NULL原名补齐候选不超过2000；仅移除8个已知单别名CHECK及11旧列，RESTRICT拒绝未知view/index/策略/混合约束依赖。canonical校验、ID/data、唯一/FK、ACL与业务父行不改。空占位/待回捞不是失败，不要求metadata齐全才能清理重复别名。无新对象，无并行迁移来源。

单独事务与5s锁/60s语句预算，覆盖预检在获取DDL锁之前；锁超时停止、结果未知核对账本/shape，不自动重试。原名缺口补齐只取同一专表旧安全标量，0保留，非空新事实不覆盖，不搬历史raw JSON。可先执行专表contract，再在历史治理/四类门禁通过后执行主表contract；主表原拒绝未知JSON/历史结算守卫未改，不能通过伪造settled_at放行。

扩展既有scripts/test-openrouter-retirement-local.sh与.mts，真实删除12+11列后验证实际repository读写/回捞/计费恢复/取消晚到/Venice及视图/权限；冲突/未知依赖/混合CHECK/2001候选/重复执行拒绝。原expand/ledger与所有消费者验证继续运行。Production需单独覆盖/锁/容量证据，不能沿用TEST零冲突。删列后禁止回退旧别名writer或用重建空列伪称数据恢复；无VACUUM FULL。

## Scenario: 诊断白名单处置与旧账务契约

`20261016_openrouter_history_disposition.sql` 先保全受控字段，再清父表raw诊断；同批规范化已有OR诊断，不整份归档JSON、不复制未知动态key/错误文本。候选LIMIT2001先核对最多2000预算再读取TOAST；JSON对象/ID/provider/字符串512/非负数/整数边界与指纹CAS检查，失败全事务回滚。Venice只验证既有明细保全、不写其明细；业务正文/终态、钱包/账单/额度不改。明确未知诊断丢弃的不可恢复性，远端执行前审阅。

仅两库尚未执行的主表DROP可修改；已执行SQL不变。要求处置成功账本、snapshot schema文件checksum和applied_at作为旧契约边界，再按实际billing.llm_usage_charges/llm_usage_charge_dedup及character_free_chat_quota_decisions只读分类。不把无快照历史的settled_at NULL全部当失败，不对旧pending伪造结算；它们的定价事实/幂等键/专表ID保留，超窗停止自动回捞、独立账务核验。未知成功、现代漏快照、身份/状态冲突及旧字段关联reserved仍拒绝，正常专表流式不阻断。

同一既有PG/PostgREST harness验证两次删列和处置前后业务/账务不变，覆盖非白名单清除、NULL/0、新事实优先、Venice/身份/shape/预算/账本/现代pending/缺快照/NULL逻辑的拒绝及旧pending保留。Production数量/计划/容量另核，超过预算另审forward批次，不改文件或force_rerun扩容。

## Scenario: 已在另一环境执行的 catch-up 在生产超时

已记账原文件不改；保留同checksum失败claim（不适用abandon_claim），新增forward恢复SQL只记自身ledger，文档明确替代关系。先EXPLAIN、再有界只读实测，LIMIT与最终候选数都不能证明扫描成本有界。20261020恢复文件在候选阶段局部使用hash join并恢复planner设置；每批2000、最多两批、4001拒绝，60s/5s全事务失败回滚，不以盲增timeout代替容量设计。只填NULL安全标量/ID、不搬raw JSON；竞争非空ID拒绝覆盖且写后复核provider/identity。已contract目标只在12列全缺且精确匹配原DROP账本时跳过，部分shape或缺账本拒绝。正式执行前按本环境复核容量/旧writer/覆盖，不自动放行后续JSON处置或DROP；既有隔离PG/PostgREST harness覆盖跨批、整笔回滚、预算、冲突和contract分支。

## Scenario: 外部分析视图阻止 provider contract

发现analytics_grafana等现场兼容报表引用旧字段时，不删依赖守卫、不CASCADE、不改已执行SQL。先明确既有兼容schema与miniapp_analytics业务归属，采集真实pg_get_viewdef/列/ACL/owner/options/comments/索引及下游/刷新，再新增前向修复。只对精确已核验指纹做有界源字段替换，保留业务finish_reason、币种/单位/账务公式；需补canonical时仅同OR行NULL-safe、冲突/provider重叠及2000预算守卫并固定候选ID。物化视图先在暂存名WITH DATA构建/建唯一索引，再取得短DDL锁、复核结构与权限漂移、原子切换名称/包装视图、RESTRICT删除旧对象并恢复ACL/comments/index；不得上线WITH NO DATA后等待异步刷新。每条语句60s、锁5s，失败包括metadata补齐全部回滚；无该外部schema安全跳过，部分/未知依赖/定义漂移拒绝。正式psql文件可用\gexec拆分两条有界CREATE，不新增数据库函数/API。既有PG/PostgREST回归必须覆盖默认ACL撤销、下游OID、第二MV失败/暂存漂移回滚及真正两处DROP后报表和并发刷新。源表与账务不因分析修复改写，生产容量/刷新窗口及后续清理仍各自门禁。

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

验证：既有隔离 PG17/PostgREST harness 覆盖 6001 行跨四批、末批失败保留前批进度且回滚当前批、重入不改写已规范化行、300001 预算拒绝、JSON/身份/Venice/CAS/账本 checksum 拒绝，以及真正删列后的 repository、报表和物化刷新。原处置 SQL 与原 DROP 文件未改。此为本地修复，未执行远端迁移或提交推送。
