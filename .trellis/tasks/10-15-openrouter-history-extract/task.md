# T5–T9 本地清退阶段（2026-10-16 当前状态）

用户已授权补齐两类历史方案后直接实施，最高约束为正常对话及正文/历史/终态/计费数据正常落表。已完成本地实现与验证，任务保持 in_progress，真实环境门禁未完成。

- [x] T5：规范/现有任务/环境/消费者调查；两类历史分类和正常落表不变量补进规划，用户已授权实施。
- [x] T6：业务字段显式投影、停止主表调用 ID 读写；上游前 snapshot/专表占位、首次 ID 持久化/10s 总预算/冲突保护；两 provider 恢复与 stale 收口。
- [x] T7：新增 catch-up → provider views → 独立 DROP 三份 SQL，隔离 PG17/PostgREST 真实删列后关键 repository/视图/权限/失败门禁通过。
- [x] T8 本地：Backend 681 / Shared 139、全 workspace typecheck/build、适用 lint/import/legacy/migration、ledger 协议、新旧 PG 回归；同步 README/架构/spec/发布清单和模块载荷。
- [ ] T3/远端：真实 TEST 失败/免费/取消/超时/上游/钱包/额度/重启多副本；各环境新部署/旧副本退出、窗口覆盖、历史分类与 raw JSON 审阅、外部消费者和容量/锁/运行无旧列读写。

详细代码、SQL 顺序、验证边界与恢复见 [T8 本地报告](research/t8-local-retirement-verification-2026-10-16.md)。没有远端写入/迁移、提交/推送、PR/部署/归档；保留无关文件。下方 T1–T4 记录为历史，旧“保留旧列即兼容发布完成”的范围不再是本任务完成条件。

---

# Task Breakdown

| ID  | 状态             | 工作与文件范围                                                        | 验证/门禁                                                                                                               |
| --- | ---------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| T1  | Done             | 复核 TEST/Production 结构、账本、应用/DB 消费者；定历史归属与兼容边界 | 只读 catalog/依赖/账本证据；未导出业务行，见 `research/t1-environment-and-consumer-audit-2026-10-15.md`                 |
| T2  | Done             | 新表 migration 与 Backend 生成、结算、回捞仓储；必要的既有回归        | 本地静态与回归通过；远端 migration/人工场景留给 T3                                                                      |
| T2R | Done (TEST)      | OpenRouter 11 字段改原名、显式计费结果与 expand migration             | 本地回归通过；TEST 原名 expand 已执行（run 38874596773 / 68bf9085）；Backend caebc0c6 已推送，PR-424 实际部署已实时复核 |
| T3  | In progress      | TEST 迁移、真实业务验收与切换窗口核对；旧列/视图保留                  | TEST 结构/回填、PR 424 真机发送/重生成及迟到元数据回捞已通过；其余真实场景与切换窗口仍待验收，旧列/视图切换另审         |
| T4  | Ready for review | 最终审阅、本地必要修复、文档与生产发布清单                            | diff、验证结果、forward-fix 和发布顺序                                                                                  |

## 当前状态校正（2026-10-16 T4）

用户交接证据：TEST 四个官方 migration 已执行，原名 expand 为 run `38874596773`、提交 `68bf9085`；Backend `caebc0c6` 已推送。下方按日期记录的“本地/未执行/未部署”是当时状态，不是当前待办；T4 实时核验见本文末尾与 research/t4-final-audit-2026-10-16.md。TEST 新旧字段都有值的反馈不证明部署后新调用已由原名 writer 写入。T3 未整体验收，Production 动作未授权。

## Execution Log

- 2026-10-15：依据正式 TEST 的只读结构核验与仓库读写链路创建规划任务；未执行 `task.py start`，未修改产品代码或数据库。待人工审阅规划后再启动。
- 2026-10-15：人工审阅后启动任务并完成 T1。确认 TEST/Production 的 13 列与 `current_chat_history` 依赖一致，Production 另有 `miniapp_analytics.base_chat_bj.llm_latency` 依赖；记录 Venice shape/账本漂移和主表终态、回捞、历史关联边界。未写入数据库或产品代码。
- 2026-10-15：完成 T2。本地新增 `20261015_openrouter_chat_history.sql`：`experience.openrouter_chat_history` 以 `chat_history_id` 唯一、父 FK `ON DELETE CASCADE`、OpenRouter 常量约束、generation-ID/时间索引及仅 `service_role`/`postgres` 授权保存调用元数据；没有执行 TEST 或 Production migration，也没有回填历史数据。Backend 在获取 OpenRouter generation ID 时幂等创建/补齐明细占位，结算和 24 小时 sync job 从新表定位并写入元数据；`experience.chat_history.llm_finish_reason` 仍由业务终态路径裁决，计费事实仍留主表，旧 generation ID 继续兼容写入。新增/扩展回归覆盖 ID 占位、OpenRouter 明细写入、敏感调用内容排除及取消保护；`pnpm --filter @miniapp/backend test`（83 files / 651 tests）、`pnpm --filter @miniapp/backend typecheck`、`pnpm -r typecheck`、`pnpm lint:migrations` 与 `git diff --check` 通过。
- 2026-10-15：T3 已在正式 TEST `zoqelpfhurwehlvypryl` 通过官方 Database Migration workflow 单文件执行并记账：`20261015_openrouter_chat_history.sql`（run `38719886735`）与 `20261015_openrouter_chat_history_backfill.sql`（run `38720229528`）。只读核验确认 17 列、父 FK/唯一/约束、`anon`/`authenticated` 无 SELECT、`service_role` 有 SELECT/INSERT，且两份账本记录存在。回填严格以 `llm_billing_snapshot.provider='openrouter'` 为归属证据：102 条 eligible parent rows 与 102 条 detail rows 一致；1,674 条归属不足或其他 provider 行未迁入；`llm_generation_data` 与 provider-table 的 `llm_finish_reason` 均为 0 条历史复制，避免带入未审计内容或把主表业务终态误当上游事实。未运行 Production migration、未删除/清理旧列、未修改 `current_chat_history` 或 `miniapp_analytics.base_chat_bj`。
- 2026-10-15：用户补充并授权 T3 排除法：目前只有 OpenRouter/Venice，Venice 每次调用均有 `venice_chat_history.chat_history_id`；有 generation ID 且无 Venice 明细的主表行归 OpenRouter。TEST 只读审计无明细重叠、无 Venice 快照缺 Venice 明细；补迁移前剩余候选随活跃写入从 1,674 增至 1,681。发现新表错误地将 `llm_provider_name` 限制为常量 `openrouter`，而该列实际是路由厂商；新增 forward migration 修正约束、修复首批 102 条占位厂商名、按排除法补齐已有 generation ID 行。Backend 占位不再写假厂商，结算/回捞将上游明细与主表计费字段隔离，避免 `llm_intended_deduction` 等字段进入新表。历史 raw JSON 与主表业务终态不复制；无 generation ID 的 165 条非 Venice 行无上游关联键与元数据，不属本次明细回填。Backend 83 files / 651 tests、`pnpm -r typecheck`、migration 文件名检查与 `git diff --check` 已通过；TEST workflow、部署和人工场景结果待后续记录。
- 2026-10-15：上述补迁移以提交 `d355811f` 推送，官方 TEST Database Migration workflow run `38744963817` 成功执行并记账。执行后只读核验：有 generation ID 且无 Venice 明细的 parent 1,782 条，新表 1,782 条，缺失 0、Venice 重叠 0、厂商名与主表不符 0；历史 `llm_generation_data` 和 provider-table `llm_finish_reason` 均为 0 条复制。17 列保持不变，旧常量约束已移除，厂商列允许 NULL 且无默认值；`anon`/`authenticated` 无 SELECT、`service_role` 有 SELECT/INSERT/UPDATE。`pnpm test:migration-ledger`、`pnpm lint` 通过；Backend 无 build 脚本。TEST Backend 仍未部署，真实 SSE、结算与重复回捞未验收；Production 未执行，视图和主表旧列未动。活跃库的总数会继续变化，部署前新产生的旧路径行需再次核对补齐。
- 2026-10-16：PR #424 的 Railway `pr-424` Backend 已部署提交 `b2bd58e0`，其数据库环境标识和连接 ref 均核对为正式 TEST。真机完成两轮发送并对第一轮重新生成，实际产生 3 条 revision。只读核验：3 条主表记录各有唯一 OpenRouter 明细，generation ID 一致、无 Venice 明细；主表均为 `success/stop`，每条各有 1 笔 `charged` 且已结算的 16 星尘流水，未见重复扣费。3 条新表明细的用量、路由厂商、上游 finish reason 仍为空；`llm_generation_data` 仅含 `error.code=404`，自动回捞截至北京时间 15:30 仍持续写入 404。PR 与 development 的 OpenRouter 凭证相同，同模型部署前近 24 小时的另外 2 条记录曾成功取得用量；因此可确认本次 ID 落表与计费关联正常，但元数据补齐未通过，404 根因尚未定位，不能判定是迁移或既有回捞缺陷。查询未读取或记录对话正文、完整 generation ID、密钥和原始响应。

## T3 前置项与剩余风险

- 2026-10-16 T2R 本地实现完成：新增 `20261016_openrouter_original_metadata_fields.sql`，在 OpenRouter 专表新增 11 个原名字段并从旧别名复制已有值；`llm_generation_id`、`llm_generation_data`、主键/FK/权限保持不变。新 Backend 的 mapper、仓储查询与写入、结算和回捞只使用原名，显式计费结果不再混入上游对象；主表取消/超时优先级保持，移除已无消费者的主表旧元数据扫描方法。Venice mapper/repository/表与业务逻辑未改；公共计费调用仅做等价参数调整。测试确认 `usage_cache=0` 和缺失语义、不引入 `cache_discount`、重复回捞及晚到 `stop` 的主表保护。Backend 84 files / 665 tests、Shared 15 files / 139 tests、`pnpm -r typecheck`、`pnpm -r --workspace-concurrency=2 --if-present build`、`pnpm lint`、`pnpm lint:imports`、`pnpm lint:legacy`、`pnpm lint:migrations`、`git diff --check` 通过。`OPENROUTER_TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin bash scripts/test-openrouter-original-fields-migration.sh` 在隔离本地 PG 17.11 通过 11 列值复制、零值/NULL、主表隔离、权限/约束、重放不覆盖原名值、FK 级联和错误 shape 拒绝；本机默认 PG 14 回归也通过。新增专项测试文件的依据是计费和 migration 兼容风险；README、架构及相关 spec 已同步本次字段约定和发布顺序。本轮未提交/推送、未执行远端 migration/回填或部署，T3/T4 未整体收尾。
- 原名版本发布新增前置项：由于 PR 分支推送会自动部署 Backend，先只提交/推送 migration 并在 TEST 经官方 workflow 单文件执行，再提交/推送 Backend 适配。新 Backend 不兼容缺少原名列的库。旧 writer 在 expand 后写出的旧别名仅能在切换窗口内通过回捞补齐；超过 24h 或上游失败的记录需窗口审计并另做受审查 catch-up。旧别名清理需后续单独 contract，不能据本轮本地通过直接删除。Production 仍须独立授权与逐环境核验。

- 2026-10-16 补充复核：用户反馈三条明细已补齐后，通过 PR 424 的 TEST 连接以只读事务核验，同一真机会话的 3 条 revision 均已有厂商、模型、usage、耗时、prompt/completion token 数和上游 `stop`；原始诊断对象已无 `error`。主表仍为 `success/stop`，generation ID 一致，已结算，每条各有一笔计费，无 Venice 明细。故先前 404 已恢复，发送/重新生成及迟到元数据回捞验收通过；此结果未确定此前 404 的根因，也不替代免费、取消、超时、上游错误和消费者切换验收。仅记录聚合结果，未导出业务行或原始 JSON。

- TEST 四个 migration 已执行，详见当前状态及后续 T4 证据；不重复执行。Production 需独立审批、目标复核与逐文件执行记录。不可用本地或 TEST 验证替代 Production。
- PR 424 已验证真实付费发送、重新生成的 generation ID 占位、一对一明细、迟到 usage/路由厂商/原始结束原因补齐，以及多次自动回捞后每调用仅一笔计费；还需覆盖免费、取消、超时、上游错误与业务终态保护。此前 404 已恢复，根因未确定，保留为观察风险。
- 不得在 T3 前回填或删除主表旧列；`current_chat_history` 与 Production `miniapp_analytics.base_chat_bj` 仍依赖旧列。只有确认两环境的应用/视图/函数/分析查询及部署版本均无旧列读写后，才可另行评估 consumer 切换和清理。
- TEST/Production 现有 `venice_chat_history` 与未记账 `20260929_venice_chat_history.sql` 的漂移保持已记录状态；本任务未重跑、未改写该 migration，不能据此推断新 migration 的账本状态。
- PR 424 的 Backend 已在 `pr-424` 部署，但这次真机样本不足以完成全部 T3 验收；`current_chat_history` consumer 切换与旧列清理仍需单独授权和两环境无读写证据门禁，Production 迁移/部署仍未执行。TEST 作为活跃库，补迁移后新增的旧路径行也须在后续发布门禁重新核对。

## T4 最终审阅与发布准备（2026-10-16）

- 当前本地/远端/PR head 同为 `caebc0c6`，PR-424 实际 deployment `a6cd9603-13b7-49d3-98b8-03d00539d4c1` 运行该提交；Quality Gate/Docker 通过，最新 PR Review run `38875235561` 仍 HTTP 402。`origin/dev` 相对当前分叉 9/8 commits，未自动 merge/rebase，整合最终 base 后须重新验证。
- TEST 四份 migration 实时账本与 checksum 均通过；原名 expand 官方 run `38874596773` SUCCESS / `68bf9085`。部署后新产生的 3 条（含一次重生成）原名 usage 完整、旧 llm_usage 均 NULL，ID 一致且每条一笔 charge/均已结算，已区分历史复制与新 writer。
- TEST 近 24h 缺失 OpenRouter 明细的非 Venice parent 为 9；缺失明细 anti-join HEAD 验证 HTTP 200/count 9。本次未补写它们；不能宣称已恢复。metadata 完整但未结算为 0 仅是瞬时聚合，不能代替失败路径验收。
- 最终审阅发现三项 P1 并完成本地修复：完整 metadata 的未结算/Venice 恢复入口丢失、占位失败后不可回捞、raw JSON 黑名单不保证内容隔离。恢复三路各 50/24h/5s、独立失败隔离/去重；诊断改有界 allowlist。没有新 migration、依赖、公开 DTO 或测试文件；扩展既有风险回归。当前远端/CI/部署不包含这些本地修复。
- Production 已独立核实：新表不存在、四份 ledger/claims/events 无记录；current_chat_history/base_chat_bj 的旧列依赖保留。主表 catalog 约 346,623 行/23.4 GB，超过 TEST 规模依据；容量/锁/候选预检未完成前不可执行生产回填。Venice 旧 migration 未记账只记录漂移。
- 发布方案见 [逐文件清单](production-release-checklist.md)，证据与审阅结论见 [T4 审计](research/t4-final-audit-2026-10-16.md)。README/架构/Backend 与 DB 专题 spec 已同步；四模块 `module-updates.json` 为待人工审阅的最终内容，未 archive/apply。

### 仍未完成的 T3

- [ ] 含 T4 修复版本的 TEST 部署/新发送/重生成复验；9 条缺失明细实际恢复、超窗分类及切换窗口 catch-up。
- [ ] 免费模型/角色免费额度、取消先赢/完成先赢、超时、上游错误及晚到 stop 的真实 SSE/主表/钱包/额度验收。
- [ ] generation API 404/429/5xx/超时，DB 占位/metadata/计费/quota 回写失败，重启/多副本/重复回捞；每调用唯一 charge 与对应钱包 ledger。
- [ ] 分析/CS 外部消费者兼容确认与生产容量计划。旧列清理、视图切换独立审阅，不是本次兼容发布必做项。

本任务保持 in_progress，不自动勾选 PRD 全部验收、不归档。未暂存/提交/推送，未执行任何 Production migration、PR 合并或部署。无关 Admin preview task 与问题汇总文件保留。

### T4 本地最终验证

- Backend：84 files / **669 tests**；Shared：15 files / **139 tests**，全部通过。
- `pnpm -r typecheck`、`pnpm -r --workspace-concurrency=2 --if-present build`、`pnpm lint`、`pnpm lint:imports`、`pnpm lint:legacy`、`pnpm lint:migrations`、`git diff --check` 通过。Backend 无独立 build script；build 覆盖有 build script 的消费者；Admin 既有 bundle size 提示不阻断构建。
- `OPENROUTER_TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin bash scripts/test-openrouter-original-fields-migration.sh` 通过；`pnpm test:migration-ledger` 通过。沙箱分别阻止 PG 共享内存/本地 socket，按工具审批在沙箱外重跑隔离本地检查；未连接远端写库。
- `module_knowledge.py check` 与 `task.py validate` 通过；没有执行 module apply/archive。TEST PostgREST HEAD 已验证 anti-join，但本地模拟不能证明多副本真实恢复/钱包/免费额度场景；这些仍属 T3 待办。

## 2026-10-16 用户补充确认与实施授权

最高约束：本次改造不得影响正常发送、重生成、流式回复、取消/超时及对话正文/历史/终态/计费事实的正常落表。调用 metadata 与历史治理不得删除或改写对话正文；异常时保留已观察到的回复及原业务终态，不因诊断写入失败将已落表正文改为空。新增持久化接缝只保护恢复事实，须通过正常/失败落表回归与隔离库删列后真实 repository 验证。历史不明确记录阻断清理，不能影响新对话。

用户已明确授权：补齐下列两类处理规划后直接本地实现，无需再次规划审批。远端迁移/提交推送/PR/部署仍未授权。

- 41 条有 ID 缺 OpenRouter detail：旧 writer 退出后重新计数，核对无 Venice/归属冲突；新增 catch-up 只补安全标量与 ID，非空冲突停止，不复制 raw JSON/主表业务 finish reason。近窗回捞迟到 metadata，超窗保留已知事实；核对缺失与不一致归零，单独检查计费/额度。
- 12942 条无 ID/无 detail：不能据此认定没有可迁移 metadata。聚合分类为“可靠归属+安全字段可迁移（NULL ID）”“无调用事实且业务计费已收口”“计费/额度未收口”“归属/值冲突未知”。只迁可证明 OpenRouter 的安全标量，不能仅因无 Venice 就给无 ID 历史猜 provider；没有信息不伪造 ID。未收口沿原 charge_id/冻结快照/已确定业务原因恢复，信息不足停止自动处理并人工核验。全部分类、可迁移信息已保留且未知项获确认前禁止 DROP。两类数字都是旧快照，切换时重新计算；TEST 165 不替代 Production。

新增 migration 的分类守卫必须拒绝未保全的安全调用字段、不明确 provider、ID 冲突和未完成结算/额度；无法证明原始 JSON 可丢弃时阻断 DROP，由受控内容治理另审，不盲搬或静默删除。本地可用合成 fixture 验证拒绝路径，真实环境未知项不自动通过。

## T9 新增清理范围（已授权实施）

- [x] 用户已审阅授权PRD/design/implement新增专表11重复旧别名范围，ID/data保留现名。
- [x] 审计本地消费者/约束及TEST别名零缺口/零冲突，新增独立专表contract SQL；Production需独立核验。
- [ ] 形成历史JSON和无snapshot结算分类/守卫方案，不将待回捞或旧契约差异判为新业务失败。
- [x] 扩展既有隔离库测试，真正删主表12列+专表11列后关键链路通过，Backend683/Shared147、consumer typecheck/build/lint/ledger通过，文档同步；最终人工审阅待确认。
- [ ] TEST所有共享旧writer升级/退出、窗口复核和逐文件远端门禁；Production独立核验授权。

T9本地结果详见 [专表清退报告](research/t9-provider-alias-retirement-2026-10-16.md)。主表历史JSON处置及无snapshot历史分类只提出策略，未修改或伪造数据；远端仍阻断主表DROP，不把此项勾选为完成。

## T10 历史处置（用户已授权直接本地推进）

- [x] 用户明确PR425作废，本轮门禁排除该环境。
- [x] TEST只读分类：1797旧JSON均有对应provider，1281无快照历史中1268终态账单/dedup、11失败无账单、2真实pending。Production只读账本确认原DROP未执行。
- [x] 实现白名单历史处置与已确认未执行的主表DROP守卫修正；不新建任务、不补扣或假结算。
- [x] 扩展隔离DB回归与consumer验证、同步文档；最终人工审阅待确认，远端未执行。

T10详情见 [历史处置报告](research/t10-history-disposition-2026-10-16.md)。本地实现与验证完成不代表远端已处置/删列，Production业务分类/容量仍未知。

## T11 Production catch-up 失败恢复（2026-10-20）

- [x] Action39367671410、两环境ledger/生产claim与索引/计划只读核对；hash候选实测7.403s，2815有ID候选，Venice快照冲突零。
- [x] 新增forward恢复迁移：最多两批各2000、4001拒绝；不改旧SQL/账本/claim。
- [x] 扩展既有隔离PG/PostgREST回归，完成跨批/拒绝/回滚/消费者/已删列分支检查。
- [x] 类型/构建/既有测试/静态检查、文档和恢复清单同步，交付最终审阅。
- [ ] 经独立批准在TEST/Production正式workflow逐文件执行；旧writer/流量/磁盘/复制/后续清理仍需本环境门禁。

## T12 Grafana 旧字段依赖修复（2026-10-20）

- [x] 用户授权直接修复、验证后提交推送；原无关dirty保留。生产catalog定位3个直接阻塞对象及下游。
- [x] 生产结构/TEST差异/刷新证据收口；新增forward修复，不改原alias/history/drop文件。
- [x] 合成真实定义fixture及双DROP/PostgREST/报表/物化刷新/ACL/回滚/漂移/依赖回归通过。
- [x] 类型/构建/既有测试/静态检查与文档/module载荷同步，按用户授权直接提交推送；交付SHA以本轮Git/远端核对结果为准。
- [ ] 正式TEST/Production文件执行（本轮不自动执行）；完成后再各自核验原alias/history/主表DROP。
