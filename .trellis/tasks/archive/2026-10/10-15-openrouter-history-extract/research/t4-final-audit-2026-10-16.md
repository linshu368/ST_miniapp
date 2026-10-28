# T4 最终审阅与环境证据

采集日：2026-10-16，Asia/Shanghai。只读远端；本地修复未提交/推送。没有执行远端 DDL/DML、合并或部署。未导出业务行、正文、完整 generation ID、raw JSON、密钥或连接串。

## 分支、CI 与部署

- `git fetch origin` 后，本地 HEAD、`origin/dev_openrouter_migrate` 与 PR #424 head 都是 `caebc0c6ded5d3fe5688464d136ec0a0c300c421`；base=`dev`，PR OPEN、mergeStateStatus=BLOCKED，无已完成 reviews。
- `origin/dev=cb91499f6e32451104f07aee03bcedd871042bf0`；merge-base=`fd1019bdb9ca919ce63e91b395a6f42dc2be4980`，相对分叉 9/8 commits。没有合并/rebase；后续整合最终 base 后必须重新验证，当前结果不是最终合并树验证。
- [CI 38875237798](https://github.com/linshu368/ST_miniapp/actions/runs/38875237798)：Quality Gate 与 Backend Docker Build SUCCESS。
- [PR Review 38875235561](https://github.com/linshu368/ST_miniapp/actions/runs/38875235561)：最新日志仍为 HTTP 402；未完成代码审阅。此次本地最终审阅不把该 required check 改成通过。
- Railway PR `b731194c-df8b-4a3c-9c51-a8437b79385a` / Backend `8bd593b7-7c40-4ab6-8808-c0863f27a22a`：当前 deployment `a6cd9603-13b7-49d3-98b8-03d00539d4c1` SUCCESS；commit=`caebc0c6`，创建 16:43:23，完成 16:43:46。
- Railway Production `f03d6c61-84e3-434d-a81a-0ae209167ef5`：deployment `df7b4385-ce8f-4509-bea2-702a622eaefd` SUCCESS；commit=`c759f6de4e4ea1ab1b1f597ad49293b92e288f5c`，branch=`main`。不是本任务新 Backend。
- 本地 T4 修复产生于上述查询之后，当前 PR CI/部署均不包含它。必须经人工审阅、单独提交/推送授权和 TEST 部署/复验后才能作为发布候选。

## TEST：证据来源与原名写入

当前 Supabase MCP `get_project(zoqelpfhurwehlvypryl)` 返回 Project not found；不能标为 MCP TEST-DB。改用 Railway PR-424 变量在进程内选取 TEST 数据库连接，断言 `DATABASE_ENV=test`、Supabase URL 与连接串均匹配 TEST ref，再在 PostgreSQL `BEGIN READ ONLY` 中查 catalog、迁移账本和脱敏聚合。凭证没有输出或落盘。连接变量不含有效部署 SHA，部署 SHA 以上面的 Railway deployment 元数据为准。

19:11 账本核对：四份文件 checksum 均与当前仓库 SHA-256 一致：

- `20261015_openrouter_chat_history.sql`：`396df2bc85cd63891a29d0356534cd6581ca711d2cecfe83e88954f198c97fe7`；账本时间 10-15 18:23:49；run `38719886735`（run ID 来自交接记录）。
- `20261015_openrouter_chat_history_backfill.sql`：`4a118905ab9dab0118f0db1dec54c680648d07d94973eedd79136cf35c7314d3`；10-15 18:26:35；run `38720229528`（交接记录）。
- `20261015_openrouter_chat_history_venice_exclusion_backfill.sql`：`9ab87c9f487dc0ef647a9c6ef043324e3e81302145a2eda49dc18ea0c7041d23`；10-15 21:42:47；run `38744963817`（交接记录）。
- `20261016_openrouter_original_metadata_fields.sql`：`cbd8842ad32380037cacde9d79d0c3146fd95c79aeb04962de2ef88cccef00f1`；10-16 16:35:01；[run 38874596773](https://github.com/linshu368/ST_miniapp/actions/runs/38874596773) 实时复核 SUCCESS、head=`68bf9085`。

专表 28 列；原名 11 列类型与 migration 一致；唯一 parent/FK cascade、generation ID/created_at 索引保留；RLS=false，ACL 仅 postgres/service_role，anon/authenticated 无表授权。旧别名保留。

19:15 脱敏聚合，严格以 parent.created_at 晚于当前 PR deployment 完成时间 16:43:46 筛选：

- 新增 3 条 revision，时间 17:08:43–17:09:26，其中 1 次重新生成。
- 3 条原名 usage 非空，且 3 条旧别名 llm_usage 都为空；原名 usage/latency/generation_time/finish_reason 均完整。证明这些新调用不是 expand migration 的历史复制；不是仅根据“两套字段有值”验收。
- generation ID 与 parent 一致，差异 0；3 条均已结算，每条关联 1 条 llm_usage_charges。该查询验证 charge 行数，不等价于重新审计所有钱包 ledger；此前真机 3 条流水证据属于旧版本验收。
- 当前样本 cancelled/timeout/upstream_error 均为 0；未按免费类型核验。不得据此勾选对应验收。
- 近 24h 有 generation ID、无 Venice 明细且无 OpenRouter 明细的 parent 为 9；全表 OpenRouter/Venice 明细交集 0；“元数据完整且未结算”近 24h 为 0。此为活跃库瞬时计数，不证明所有失败路径不存在。
- 新增缺失明细查询通过 TEST PostgREST HEAD（无业务行响应）验证：HTTP 200、count=9，两个 FK anti-join 与 JSON provider 过滤可执行。本次没有补写这 9 条数据；其来源与真实恢复留给新版本 TEST 验收。

用户反馈“新旧列都有值”仅作为线索；前一版本 3 条真机样本迟到 404 后恢复属于历史证据。404 根因尚未确定。

## Production：独立只读结构核验

Supabase MCP `get_project` 明确返回 `wbtsfzozlmurljvglhpn`（显示名称 ST_telegrambot，不能仅凭名称判断环境），ACTIVE_HEALTHY / PG17。19:10–19:18 catalog 与治理账本查询：

- `experience.openrouter_chat_history` 不存在；四份本任务 migration 在 `repo_migrations` 无记录，`repo_migration_claims` 和 `repo_migration_events` 也无对应记录。证实本任务 Production 尚未迁移，不是从 TEST 推断。
- `chat_history` 的 13 个兼容元数据列仍存在且可空；`current_chat_history` 仍依赖全 13 列；`miniapp_analytics.base_chat_bj` 仍依赖 `llm_latency`。
- `chat_history` RLS=false，存在 anon/authenticated 表级权限，但这两角色没有 experience schema USAGE；这是既有结构，不能复制其表 ACL 给新表，也不能只看表 grant 就宣称可访问。service_role 有 schema USAGE、无 CREATE。相关 pg_default_acl 无额外默认授权。
- `cs_persona_reader` 已有主表、Venice、current view 和 analytics view 的 SELECT。新 OpenRouter 表不自动授予此角色；外部分析/CS 查询是否需要明细仍需 owner 确认，本次不改权限或视图。
- `venice_chat_history` 存在，`20260929_venice_chat_history.sql` 未记账；只记录漂移，不重跑、不伪造账本、不改历史文件。
- pg_depend 证实上述视图依赖；扫描 experience/billing/analytics/cs/admin 函数体没有发现直接使用主表这 13 列的函数。billing 函数里的相关名称来自其自身字段，不是主表引用；动态 SQL、外部脚本和人工 BI 查询无法仅靠 catalog 排除。
- `chat_history` planner 估计 346,623 行、total relation size 23,441,907,712 bytes；Venice 估计 1,300 行。都是 catalog 估计/存储统计，不是精确候选数，也不是可迁移行数。Production 未读业务行；不能沿用 TEST 两千行的锁/容量判断。
- billing 的 charge_key 与非空 generation_id 在 llm_usage_charges/dedup 上都有唯一索引。主表终态仍由应用条件更新与既有 RPC 管理，此次不改钱包函数。

## 最终代码审阅发现与本地处理

审阅范围：`origin/dev...caebc0c6` 全量 30 文件及 T4 本地 diff；重点逐链跟踪 generate → finalize/ID placeholder → settle → metadata/charge → sync，及四份 migration、legacy guard、既有回归。没有将 402 当成审阅通过。

1. **P1，已本地修复**：专表扫描仅筛缺 metadata，漏掉 metadata 完整但 charge/quota/主表结算回写失败的记录；Venice 也不再进入原结算恢复分支。增加独立有界主表 pending billing 扫描，不改变 Venice mapper/表/计费规则。
2. **P1，已本地修复**：placeholder 两次写入都失败时，只有 parent 的兼容 ID，而新扫描只从明细出发，无法自动恢复。增加 24h 内、每批 50 的 missing-detail anti-join，排除 Venice 明细和明确 Venice 快照；由既有 upsert 恢复。主表 ID 在此兼容发布中仍有恢复职责，不得删除。
3. **P1，已本地修复**：raw JSON 仅靠字段名黑名单，未知 `completion`/嵌套 credentials/error message 可带入内容。改用原名 metadata + id 的固定 allowlist，字符串最多 512 字符，错误仅保留数值 code；不记录任意 nested/raw body。provider 数值校验、usage_cache 的 NULL/0 语义不变。
4. **可靠性补齐**：新增仓储查询/upsert 均有 5s timeout；三路扫描各限 50、24h，失败分别记录并允许其余来源推进；按 parent ID 去重。唯一 parent key 和既有 charge_id RPC 保证重复处理不会新增第二笔计费；不以进程 isRunning 代替 DB 幂等。

范围限制：24h 之外的旧 writer 窗口不自动 catch-up；跨实例旧/新 metadata 竞争可能短暂使缺字段重现，仍需实测重跑和窗口审计。新 Backend 不回写旧别名/主表元数据数值，旧视图可能继续看到旧值；不能声称分析消费者已经切换。保留旧列是兼容发布选择，清理不在 T4 必做范围。

## 验证

Backend 84 files / 669 tests、Shared 15 files / 139 tests、workspace typecheck/build、lint/import/legacy/migrations、PG17 migration 与 migration-ledger 协议回归通过。无新测试文件。最终本地验证结果及未完人工矩阵见 `../task.md`；生产逐文件步骤、容量停止条件与恢复见 `../production-release-checklist.md`。T3 保持未完成；不归档本任务。
