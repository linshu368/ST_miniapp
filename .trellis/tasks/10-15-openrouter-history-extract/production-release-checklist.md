# OpenRouter 兼容发布清单（待人工审阅/授权）

方案日期：2026-10-16（Asia/Shanghai）。本文件是执行方案，不代表生产动作已获授权或已完成。环境证据见 [T4 审计](research/t4-final-audit-2026-10-16.md)。本次不删除旧列、不切换旧视图、不改 Venice 行为、不自动提交/推送/合并/部署。

## 当前结论与发布候选

**尚不满足生产执行条件。** TEST 四份 migration 已完成，caebc0c6 的新发送/重生成原名写入已核实；T4 新发现的计费恢复/占位恢复/内容隔离修复目前只在本地，需人工审阅后另行授权提交/推送与 TEST 部署验收。T3 真实免费、取消、超时、错误和恢复场景未全部完成，PR Review required check 仍 HTTP 402，Production 容量门禁未完成。

- PR #424：`dev_openrouter_migrate -> dev`；当前远端 head=`caebc0c6ded5d3fe5688464d136ec0a0c300c421`。
- Production 当前 `main=c759f6de4e4ea1ab1b1f597ad49293b92e288f5c`，deployment=`df7b4385-ce8f-4509-bea2-702a622eaefd`。
- 生产新 Backend 的候选 SHA 必须在 T4 修复提交、目标 base 整合与 CI 后重新填写；不能将当前 caebc0c6 或“最新 main”直接当最终候选。main 自动触发生产部署，合入 main 是部署动作门禁。
- 本任务四份 SQL 文件保持不可变，checksum 以 T4 审计记录为基准；官方入口 `.github/workflows/db-migrate.yml`，每次只运行一个文件。Production ref=`wbtsfzozlmurljvglhpn`；TEST=`zoqelpfhurwehlvypryl`，两者不能互代。

## A. 执行前门禁

- [ ] 人工审阅最终代码/文档 diff、验证结果及文件清单；单独授权提交和推送。任何 SHA/diff 改变后重新审阅。
- [ ] 在 TEST 部署包含 T4 修复的候选，记录实际 deployment SHA；补齐下方 T3 人工矩阵，确认 9 条 missing-detail 的来源/是否仍在窗口、恢复结果和无 Venice 误归属。旧版本 TEST 证据不得覆盖新补丁验收。
- [ ] 核对最新 dev/main/head，按用户指定方式解决分叉并重跑最终候选 CI；不自动 merge/rebase。402 的代码审阅缺口须补足并由维护者按仓库规则处置 required check，不擅自跳过保护。
- [ ] 复核所有运行副本的环境、commit、DB ref 和 sync 开关；不能把 PR 的 TEST 变量/成功状态当 Production 配置。Production 项目名称显示 ST_telegrambot，但目标以 ref 与受控连接校验为准。
- [ ] 再查 Production catalog、账本/claims/events/checksum、默认授权、视图和外部消费者；若 OpenRouter 表/账本与本次“都未执行”基线不同，停止按本方案直接应用。
- [ ] **容量停止门禁**：Production catalog 估计主表 346,623 行、约 23.4 GB；当前未读取生产业务行，未取得精确 eligible/冲突/JSON 类型/可迁移字节数与查询计划。现有约两千行 TEST 回填依据不能直接推广。需在执行前的受控只读预检中输出聚合与 `EXPLAIN`（不 ANALYZE 写入、不导出 raw JSON/正文），评估候选扫描、WAL、磁盘余量与复制延迟。若回填规模超过既有已验证范围，先在隔离副本验证同规模执行，或另审分批 forward migration；不得修改四份历史 SQL，也不能靠调大 timeout 强行发布。
- [ ] 核对锁与窗口：识别长事务/锁等待/生产流量；文件 1/2 没有内置 lock/statement timeout，文件 3/4 为 5s/60s。未形成可批准的执行预算与监控/停止安排前不运行文件 1/2。不要假定 workflow 能接受额外 timeout 输入。
- [ ] 用户明确批准具体 Production migration 文件、执行 ref/SHA、窗口和恢复目标；迁移授权不包含 PR 合并或部署授权。

## B. Production 逐文件迁移（A 全通过且授权后）

执行时冻结所选 workflow ref 的写入，核对 checkout SHA 和文件 checksum。每个文件都使用 `mode=apply`、`environment=production`、`confirm_production=RUN_PRODUCTION_MIGRATION`、`force_rerun=false`。这里只列输入，不触发 workflow。

1. `packages/shared/migrations/20261015_openrouter_chat_history.sql`
   - 前置：表不存在；主表 PK UUID、experience schema/service_role USAGE 存在；无异常 claims/账本；目标连接 ref 正确。
   - 后置：17 列旧别名结构；唯一 chat_history_id、父 FK cascade、generation-ID partial index、created_at index、数值/JSON check。初始 provider 常量约束只是中间态，**不得此时部署任何本任务 Backend**。
   - 权限：仅 postgres/service_role，anon/authenticated/PUBLIC/额外默认授权不得获得访问；明确 RLS=false 与受控 schema/表 ACL 的设计；不要复制主表 ACL。采集 owner、grants、policies、锁/磁盘、耗时和账本 checksum。
2. `packages/shared/migrations/20261015_openrouter_chat_history_backfill.sql`
   - 前置：文件 1 后置条件与容量门禁通过；没有新 writer。
   - 内容：仅 snapshot.provider=openrouter 且有 generation ID 的 parent；不复制 raw JSON 或主表业务 finish reason。安全数值列/ID 从主表复制。
   - 后置：授权的只读聚合核对候选/落表/缺失、重复、Venice 冲突、数值类型/负值、主表未变；不把中间的 provider_name='openrouter' 当真实路由厂商。记录 run、checksum、耗时、WAL/锁。
3. `packages/shared/migrations/20261015_openrouter_chat_history_venice_exclusion_backfill.sql`
   - 虽然文件注释写 T3 TEST，SQL 不绑定 TEST；Production 已确认存在 Venice 表。但必须先用本环境聚合验证“有 ID 且无 Venice 明细 => OpenRouter”的历史不变量。
   - 该文件会拒绝 Venice snapshot 缺 Venice detail、以及两张明细交叠。任一守卫失败即停止，不删冲突行、不重跑旧 Venice migration。
   - 后置：撤销错误常量约束，provider_name 别名允许 NULL/无 default；已知占位厂商修复，排除 Venice 后补齐有 ID parent；核对 eligible/detail、缺失/重叠均为 0、路由厂商映射、唯一/FK/授权。无 ID 记录不猜测；TEST 历史未回填 165 条是 TEST 旧快照，Production 必须独立计数。
4. `packages/shared/migrations/20261016_openrouter_original_metadata_fields.sql`
   - 前置：文件 3 通过，旧别名类型正确，容量预算通过。
   - 后置：28 列、11 个原名字段类型与约束正确；同一行历史值复制保留 0/NULL，llm_generation_id/data 不改；唯一/FK/index/ACL 不漂移；PostgREST schema reload 已可见；service-role 读取列成功。核对复制差异计数为 0，保留实际允许 NULL 的字段。
   - checksum 必须为 `cbd8842ad32380037cacde9d79d0c3146fd95c79aeb04962de2ef88cccef00f1`。

**每个文件后先核验，通过后在授权范围内进入下一文件；异常即停止。** 结果记录至少包含 ref、checkout SHA、workflow run、checksum、账本/claim/event、前后 shape/权限/聚合、耗时/锁/容量和异常处理。新 Backend 必须等四份迁移及全部后置核验通过。

## C. 应用切换与窗口核对（另需合并/部署授权）

- [ ] 记录迁移完成时间、首个新 writer 时间、最后一个旧副本退出时间及部署 SHA；窗口以各副本实际流量时间为准，不以推送时间替代。
- [ ] 经单独批准合入 dev，完成稳定 TEST 复验；生产发布 PR 合入 main 前确认 Production 四份 migrations 成功。main 自动部署，不能先合入再补 migration。
- [ ] 核对 Railway production 的服务、实际部署 SHA、健康与安全日志；不只看 GitHub/Railway SUCCESS。开始少量受控业务验收，观测 generation API 的 404/429/5xx、占位失败、metadata 写失败、billing/quota 重试及终态状态。
- [ ] 每批核对新发送/重生成的唯一 detail、generation ID、原名字段、每调用一笔 charge/对应钱包流水；免费不扣款，取消/超时/错误不被晚到 stop 重开计费；重复 settle/sync 和多副本仍幂等。仅记录安全聚合和状态，不输出正文/完整 ID/raw JSON。
- [ ] 核对窗口中：有 ID 无 detail、旧别名非空原名缺失、ID 不一致、Venice 交叠、snapshot 与 detail provider 冲突、原名完整却未结算、计费已完成但免费预留未收口、超过 24h 未恢复。缺失不因健康检查通过而豁免。
- [ ] 新恢复扫描覆盖近 24h、三路各 50；超窗/容量积压/持续上游 404 的记录需另审 catch-up。不能重跑已记账 backfill/expand 来代替窗口补偿，也不能从 parent 的业务 finish reason 伪造上游原始 finish_reason。
- [ ] 观察至少覆盖一次受控迟到恢复及两次 30s job tick，随后在旧 writer 全退后做完整窗口聚合；24h 边界前再次核对积压。若积压增长、触及容量预算或闸门失败，停止扩大流量/后续清理。
- [ ] 保留主表 13 列、专表 11 别名、current_chat_history 和 Production base_chat_bj。旧报表可能看到旧元数据值；分析/CS owner 确认这种兼容期行为。新的消费者切换/权限开放/删列都要独立审阅，不作为本次完成条件。

## D. 停止与恢复

- **目标/版本/checksum/账本不符**：不执行下一文件/部署；查明 ref 和 checkout。不得用 force_rerun 修 checksum 漂移。
- **SQL 失败、断线或结果未知**：查同一次 workflow、ledger、claim/event 与实际 shape；SQL COMMIT 与记账可能分离，不能根据红灯盲重跑。文件 1/3 不具备可直接重复 DDL 语义；先审查是否已提交，再决定受审查的 forward-fix 或 claim 恢复。不要自动 abandon_claim。
- **容量/锁/权限/归属失败**：按批准的停止方案中止未提交事务；已成功的 additive schema 保留。停止新应用发布，旧 Backend 继续使用主表；不得 DROP 表或丢弃明细“回滚”。
- **新 Backend 异常**：经单独授权回退已记录的生产 deployment/SHA，保留新表/新列及计费事实。旧 Backend 不会把 canonical 数据反写回别名，也不会消费专表全部数据；记录新 writer 窗口，保护已扣账，修复后以同 charge_id 收敛，禁止重新定价/重复扣款。
- **发现错误扣费或取消终态被覆盖**：立即停止发布推进，保留安全证据并按既有计费审计/补偿流程另审恢复；不手改余额、删除流水或清理列。
- `venice_chat_history` 的未记账漂移只记录，不运行 20260929 旧文件；不把当前 Production 已有对象误作本任务迁移成功。

## E. 未完成的 T3（保留为验收项）

- [ ] 包含 T4 修复版本的 TEST 实际部署、原名新发送/重生成复验。
- [ ] 免费模型/角色免费额度：占位与迟到 metadata、0/NULL 语义、quota 收口、钱包不扣款。
- [ ] 取消先赢/完成先赢、取消后晚到 stop、超时恢复：主表终态、SSE、quota、钱包均正确。
- [ ] 上游错误、generation details 404/429/5xx/超时、DB 占位/metadata/计费/额度回写失败、进程重启/多实例重跑；9 条缺失明细实际恢复和超窗分类。
- [ ] 每调用唯一明细/charge/钱包流水；canonical 完整但未结算与 Venice 既有恢复无回归。
- [ ] 切换窗口 catch-up、外部分析/CS 消费者确认与容量计划；旧列清理另审，不要求本次实施。

完成方案与本地检查不等于批准执行以上生产动作。发布前仍需完成 TEST 验收与 Production 只读容量预检；本地修复提交/推送、Production 逐文件迁移，以及之后的 PR 合并/main 部署，分别等待用户明确授权。
