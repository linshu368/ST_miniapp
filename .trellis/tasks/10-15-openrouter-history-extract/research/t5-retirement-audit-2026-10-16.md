# T5 主表清退：只读调查与规划证据

采集日期：2026-10-16，北京时间约 20:10–20:18（实时快照，不是未来删列时的证明）。范围为本地 597df0e1、GitHub、Railway 与两个已确认数据库。没有远端写入/迁移、提交/推送或部署；未输出正文、完整 generation ID、raw JSON、凭证或连接串。

## 工作区与任务

本地 dev_openrouter_migrate / 597df0e1。原 dirty baseline：10-12-admin-preview-api-guard 的 prd/task 两个修改、design/implement 两个未跟踪文件，以及 docs/后处理规则-实际应用问题汇总.md；均未编辑。已按用户要求执行 task.py start 10-15-openrouter-history-extract，active source 为当前 Codex session，任务继续 in_progress。T5 新规划仍待人工审阅，不以 start 代替审批。

已读取 AGENTS/README/ARCHITECTURE/workflow、任务四规划文件/两个 manifests、T1/T4 审计、旧 release 清单，以及 Backend、DB、安全/归属/迁移/采集、Shared 和跨层规范。当前文档关于 Production 尚无表/账本、T4 仅本地等说明已过期，本轮文档显式订正。

## 发布与部署

- gh pr view 424：MERGED，mergedAt=2026-10-16T11:42:39Z，mergeCommit=f7f79f43734870154113683b2303201c3dda752d。
- gh pr view 429：OPEN，mergedAt/mergeCommit=NULL，head=50c121f422180dd2de7bc4e523c3c8a6319477a0。Quality Gate、Backend Docker、Build & Push/manifest 等适用 check SUCCESS；review SKIPPED。按用户要求不修 PR Review 自动化。
- Railway stminiapp（项目 ce38c0c0-88cd-407a-9c04-06124cd42e97，服务 8bd593b7-7c40-4ab6-8808-c0863f27a22a）：
  - development a184d734-11e3-4b20-a114-1868f4c5f4d3：deployment bc82947a-f9f5-45ef-ab72-b914385110f5，SUCCESS，dev/50c121f4。
  - production f03d6c61-84e3-434d-a81a-0ae209167ef5：deployment df7b4385-ce8f-4509-bea2-702a622eaefd，SUCCESS，main/c759f6de4e4ea1ab1b1f597ad49293b92e288f5c。
- deployment SUCCESS 是平台记录，尚未逐副本/进程证明退休版本上线或旧副本退出。没有将 dev PR 的部署当 Production。#429 合并/发布仍未发生。

## 目标与账本

Supabase get_project 确认 Production ref=wbtsfzozlmurljvglhpn，ACTIVE_HEALTHY，PG17。TEST MCP get_project 返回 Project not found，未冒称 MCP TEST-DB；通过 Railway development 配置在进程内断言 DATABASE_ENV=test、Supabase URL 和数据库 URI 均包含 zoqelpfhurwehlvypryl，再 BEGIN READ ONLY 查询。Production 结构/账本用 MCP；必要业务聚合改走 production 配置断言 ref 后的直接 PG 只读事务。临时脚本不含凭证，不提交 Git；连接错误抑制内容，仅输出必要结果。

两个目标 repo_migrations 的四个 checksum 均与本地 shasum -a 256 一致：

- 20261015_openrouter_chat_history.sql：396df2bc85cd63891a29d0356534cd6581ca711d2cecfe83e88954f198c97fe7
- 20261015_openrouter_chat_history_backfill.sql：4a118905ab9dab0118f0db1dec54c680648d07d94973eedd79136cf35c7314d3
- 20261015_openrouter_chat_history_venice_exclusion_backfill.sql：9ab87c9f487dc0ef647a9c6ef043324e3e81302145a2eda49dc18ea0c7041d23
- 20261016_openrouter_original_metadata_fields.sql：cbd8842ad32380037cacde9d79d0c3146fd95c79aeb04962de2ef88cccef00f1

不能重跑或改写。两环境 Venice 20260929 文件在上述精确 filename 查询中均无记录，实表存在，保持漂移。当前没有另查四文件 claims/events；最终远端执行前还须核对治理异常，ledger 一致不替代该项。

## 覆盖与容量聚合

TEST（12:15:21Z 开始的只读事务）：parent 1,970，OpenRouter detail 1,800，Venice detail 5；两 provider 重叠 0；有主表 ID 非 Venice 而无 OpenRouter detail 0；ID 与对应 detail 不一致均 0；无 ID/无任何 detail 165；Venice snapshot 无 detail 0；有 usage/finish_reason 和 snapshot 但未 settled 0。只是瞬时聚合，不能证明失败恢复或免费额度真实收口。

Production（12:18:00Z 开始的缩减只读聚合）：parent 347,601，OpenRouter detail 333,281，Venice detail 1,337；重叠 0；有主表 ID、非 Venice 而缺 OpenRouter detail **41**；OpenRouter ID IS DISTINCT FROM parent ID 为 **41**，包含这 41 条缺失，不能再计作 41 条已存在 detail 冲突；Venice ID mismatch 0；无 ID/无 detail **12,942**；有 usage/finish_reason 而未 settled 0（此缩减查询没有 snapshot 条件）。

Production 首次包含所有 parent billing_snapshot 条件的全量聚合未在有界检查中完成，脚本返回失败；设置 statement_timeout=55s/client query_timeout=60s，但因已抑制错误文本，未保留 SQLSTATE，不能断言唯一根因。停止重跑原重查询，改 EXPLAIN（不 ANALYZE）确认大范围扫描：parent PK parallel index scan、OpenRouter unique-parent merge join、Venice hash join，plan total cost 128077.14。缩减查询移除 snapshot 读取后完成。**Production 全量 snapshot/provider 冲突及切换窗口覆盖仍未验证，禁止以本次 ID 聚合替代。**

Production catalog 主表 reltuples=346,623（统计估计，与精确 count 不同），本轮 size 从 23,453,458,432 到 23,453,933,568 bytes 随写入变化；OpenRouter 246,489,088 bytes、Venice 2,293,760 bytes。TEST 主表 56,156,160 bytes。没有采集磁盘余量、复制滞后、长事务/锁持有者或 DDL 窗口，因此容量/锁门禁未过。

## 数据库依赖与权限

Production pg_depend 对 12 列的显式列依赖为 current_chat_history 的 \_RETURN，以及 base_chat_bj 对 llm_latency 的 \_RETURN；未见其他索引/策略等列级 dependent。函数体关键词扫描仅返回 Admin model catalog 配置函数，并非 chat_history 调用元数据读取；未发现直接目标列引用的业务函数，但文本扫描不能排除动态 SQL、SELECT \*、外部 BI 或运行时代理。

两环境 current view 均 DISTINCT ON(session_id,turn_index)，过滤无 session/turn/revision，ORDER BY revision DESC，并投影这 12 列及主表业务 finish reason；security_invoker=true。Production owner postgres，SELECT 给 service_role/cs_persona_reader。TEST 没有 cs_persona_reader grant。

Production base_chat_bj 仍直接读主表 llm_latency，包含 id/user_id/character_id/status/created_at/北京时间 timestamp/date/llm_latency，一行一个 parent，owner postgres，默认安全模式，cs_persona_reader SELECT。TEST 不存在该 view。

Production OpenRouter 表只授权 postgres/service_role；Venice/main/current 已授权 cs_persona_reader。直接改 current 的 JOIN 而不处理列级权限会引入权限回归；不能切为 SECURITY DEFINER 绕过，也不能授 anon/authenticated 整表。规划按原角色/输出列最小授予 canonical + parent/ID/诊断列，需 SET ROLE 正反验证。未读取外部消费者查询，owner 确认仍是删列门禁。

## 代码消费者与故障链

- ConversationHistoryRepository.ts:39/80 主表/恢复类型有 llm_generation_id；finalizeTurn :232/:260 两个 UPDATE 分支写该列；listRowsPendingBilling :405–409 从主表筛 ID；listRowsMissingOpenRouterDetail :426–432 依赖主表 ID 并排除 Venice。
- generate.ts 的 onBeforeSettle 和最终 finalize 均传 generationId；ensureOpenRouterGenerationId :407–422 吞失败，注释依赖 legacy parent ID。仅删除主表写入会造成不可恢复。
- execute.ts :210 建 fire-and-forget history writer；:442–467 不 await settleGeneration；快照保存位于 settle.ts 终态后的异步逻辑。崩溃安全不能靠该任务。
- upstream.ts :124–126 首次 ID 只在内存；:122–145 的 try/catch 包住解析和回调，新增 async 持久化错误需独立传出，不能被误吞成无效 JSON。
- sync-job.ts 三路扫描/去重，:146 从恢复 row 取 ID，provider 主要由 snapshot 默认 OpenRouter；启动缺 OpenRouter key 即完全关闭（会阻止 Venice 计费恢复）。需要 provider 专表来源与缺失条件分离。
- Venice 专表已有 ID/latency、唯一 parent/FK；当前 metadata upsert 在异步 settlement、charge 之后，删除主表 ID 前需保证最小 ID 持久化及 provider-specific 恢复；不改 mapper/表/计费算法。
- Prisma 不映射 experience.chat_history；Shared API 没有这 12 个调用字段。Frontend/Admin/CS 没有找到直接旧列消费者；llm_model_catalog/钱包表名不属于清退列。ops/schema-split/snapshots 与冻结 migrations 有历史引用，不修改它们。
- scripts/check-legacy-references.mjs 现有 OpenRouter repository 只读 parent allowlist 是按文件受限，不能因适配扩大为所有 writer 的通用豁免。现有 local fields harness 只测 expand，不能声称已删列验证。

## 调查限制与门禁

没有产品代码或 migration 实现；没有本轮自动业务回归。T5 文档规划准备后待用户审阅，审阅后执行 T6–T8 本地实现。Production 41 条缺口、12,942 条无 ID/无 detail 需要按本环境历史和切换窗口分类；旧 main 仍在写，数字不是最终缺口。外部消费者、运行期零旧列读写、旧副本退出、Production snapshot 全量冲突、锁/容量、TEST 真机失败矩阵仍未完成。
