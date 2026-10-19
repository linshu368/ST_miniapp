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

- managed-key 白名单不得用另一分支的静态名单覆盖当前支持集合；改名包装函数会保留 OID，既有 CHECK 可能仍绑定前置函数，因此必须同时验证 drafts/releases 的实际表达式与 RPC 入口。参考 `20261016_reconcile_image_plaza_managed_config_keys.sql`（MIGRATION，未部署）；保持 validator、专用配置例外和 convalidated，不用删 CHECK 绕过保存错误。

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
