# T10 当前推进顺序（2026-10-16，覆盖下方历史门禁记录）

用户明确PR425作废并排除本轮门禁，不再等待该环境。PR431已合并、dev部署5ed1e217，专表11别名contract已在TEST执行；本轮历史处置与主表DROP均未执行远端。TEST不代表Production。

## 当前两文件

1. `packages/shared/migrations/20261016_openrouter_history_disposition.sql`：先保全11个白名单类型化调用事实，规范化已有OR诊断，丢弃非白名单旧诊断及自由文本错误，清父表旧JSON。最多2000候选，超过停止；指纹变化/身份/provider/shape/保全缺口停止，全部回滚。**丢弃的非白名单诊断不归档，无法从专表恢复；执行前审阅这个处置边界。** 不写正文/终态/账单/额度或Venice明细。
2. `packages/shared/migrations/20261016_chat_history_drop_provider_metadata.sql`：使用本轮更新后的文件，先核对文件checksum；仅该文件两库均未执行，故本轮允许修正，其他已执行文件不改。必须先查到处置文件的成功账本。旧无snapshot历史按真实快照schema引入账本时间区分，校验原账单/dedup的身份/状态及额度；不伪造settled_at。旧pending保留原账务与可追溯ID，超24h停止自动回捞、独立账务核验；新契约未知/缺快照、身份冲突、reserved额度关联待删旧字段仍阻断，空旧列+已有专表的健康流式可并行。

前序七份已执行文件（TEST含专表别名DROP）不要重跑。逐文件workflow、账本/claim/events、前后shape/权限/正文与专表ID/无新旧读写/锁复核后再下一文件；migration不自动部署。主表12列、业务终态及计费保留边界不变，DROP不做CASCADE/VACUUM FULL，不回收即时空间。

## 当前真实证据与停止条件

TEST旧父表JSON1797条（OR1792/Venice5）有对应detail，raw ID无冲突；OR既有49条非白名单诊断；白名单字符串无超512、Venice原名事实缺口0。1281无快照历史分为1268终态账单/dedup、11失败无账单、2真实pending，身份冲突/未结束reserved为0。SELECT复算新账务分类守卫0阻挡不代表迁移已执行；原raw JSON仍在，直接执行旧DROP仍失败。TEST正常三轮对话落表证据见前轮，空metadata待回捞不当失败。

Production本轮仅核对治理账本：原主表DROP未记账，快照schema文件checksum匹配；未采集Production业务JSON/账务分类，不能沿用TEST数字或放行Production。预计超2000候选会被新文件主动拒绝，需另审按环境批次/容量方案，不能调大超时硬跑或重复已记账文件。

本轮没有远端JSON清空/旧账补扣/状态改写或DDL。最终本地验证/文件校验值见 research/t10-history-disposition-2026-10-16.md；恢复只用无12+11列兼容SHA或forward-fix，不能直接回退旧Backend。

---

# OpenRouter 主表清退发布清单（2026-10-16 本地交付，远端待独立授权）

本文件替代旧兼容发布清单。四份历史 SQL 已在 TEST/Production 执行且本轮 checksum 对齐，禁止重复执行；本次交付目标包括主表 12 列清退 migration。远端迁移、提交/推送、PR 创建/合并、部署均未授权。详细证据见 research/t5-retirement-audit-2026-10-16.md；三份新 SQL 已生成并通过本地真实 DROP 回归，详见 research/t8-local-retirement-verification-2026-10-16.md。

## 当前状态

TEST：development deployment bc82947a-f9f5-45ef-ab72-b914385110f5 / 50c121f4；1,970 parents、1,800 OpenRouter、5 Venice，ID 聚合无缺失/重叠，165 条无 ID/无 detail。历史 T3 部分真机通过，免费/取消/超时/错误/恢复等未整体通过。

Production：PR #429 OPEN，Backend df7b4385-ce8f-4509-bea2-702a622eaefd / c759f6de；347,601 parents、333,281 OpenRouter、1,337 Venice，有 ID 非 Venice 缺 OpenRouter 41，无 ID/无 detail 12,942；ID 聚合无 provider 重叠/Venice 不一致。全量 snapshot 冲突未验证，不能宣称可删。旧主表列、current view、base_chat_bj 都还存在。

两环境 Venice 旧 migration 未记账漂移不修账/不重跑。review 自动化不列为修复目标，其他适用 CI 仍需通过。任务文档中 T1–T4 旧环境数字为历史，以上是本轮快照，执行时仍重查。

## 顺序与独立授权

1. 本地审阅并实现本轮不依赖主表 12 列的 Backend、三份新 SQL、真实 DROP 后验证和文档。先通过本地质量检查；用户最终审阅后才考虑提交/推送。
2. TEST 部署本轮 Backend，记录精确 SHA/所有副本和 job/最后旧 writer 请求退出；复验发送/重生成/计费/免费/取消/超时/错误/迟到/重启多副本。
3. 旧 writer 退出后执行新 catch-up（20261016_openrouter_retirement_catchup.sql），仅修已证明归属的安全标量/ID，不迁 raw JSON，不伪造上游 finish_reason。单文件检查 ledger/checksum/claims/events、前后聚合/锁/容量。超过已验证批次预算则停止另审。
4. 覆盖通过后执行视图切换（20261016_chat_history_provider_metadata_views.sql）：current/已有 base_chat_bj 按对应 provider 表取值，核对列名/序/类型/基数/语义/权限。current 保持 security_invoker，既有 cs_persona_reader 只补最小列权限；TEST 没有 analytics view 不凭空新建，生产分支在本地 fixture 验证。
5. 独立执行 20261016_chat_history_drop_provider_metadata.sql 前，以下门禁全部满足并获得该文件/目标/窗口明确授权。先 TEST，TEST 实际验证后再单独审批 Production。不得一次 workflow 跑多文件。
6. Production 按同样顺序独立核验；当前 #429 是否先发布既有接入不代替本轮退休版本及旧副本退出证明。四份历史 migration 不再列为待执行。

具体顺序基于本轮没有新增运行时结构：可以先停旧写，再 catch-up 与切视图，避免旧 Backend 仍持续写主表而新视图读不到窗口数据。文件名与当前 checksum 见 T8 报告末尾；SQL/diff 变化后须重新核对。

## DROP 前四类硬门禁

- [ ] 应用：全量扫描确认生成/结算/恢复/类型/脚本/全部应用无主表 12 列读写；provider 专表合法字段、业务 llm_finish_reason 与冻结历史 SQL 保留。
- [ ] DB：pg_depend、视图定义、函数/动态 SQL、触发器/策略/索引和外部消费者均完成审计；不再依赖目标列；无 DROP CASCADE。
- [ ] 运行：最终 SHA 已实际部署，旧副本/worker/job 均退出，入站请求 drain；按首新/末旧 writer 时间观察并保留无旧列读写证据及分析/CS owner 确认。没有观测不能自动勾选。
- [ ] 覆盖：全历史及窗口按 provider 核对（含 Production snapshot/provider 冲突），现存 ID 缺 detail/不一致归零；无 ID 历史单列并确认不可迁移边界；metadata 完整未结算、quota/账单/钱包终结及超窗积压可收敛。TEST 165 不替代 Production 12,942。

## 锁、容量、超时与停止

Production 主表 catalog 约 23.45 GB；包含 snapshot 的全量聚合本轮未在 55s/60s 有界检查内完成，去除 snapshot 后 ID 聚合完成。不能在 DDL 锁事务里重跑昂贵全历史扫描。先用 EXPLAIN/有界 ID 或时间批次完成剩余覆盖，核对执行预算、长事务/pg_locks、磁盘/WAL/复制延迟、流量窗口；当前这些没有通过。

DROP 拟 lock_timeout 5s/statement_timeout 60s、显式 RESTRICT 12 列；排他锁超时整笔停止。迁移结果未知时核查同一 workflow、shape、ledger/claim/events，不盲重跑/force_rerun。四类门禁不齐则保留旧列但任务保持未完成，不再称“清退已完成”。删列不即时回收空间，无 VACUUM FULL/表重写。

## 恢复方案与边界

- 删列前保留 additive schema；回退旧应用需单独授权，且重新核对 view/旧 writer 窗口，不能假设旧应用继续维护专表。
- 删列后只允许回退到已在“12 列不存在”数据库验证的兼容 SHA，或发布审阅过的 schema-compatible forward-fix。原 c759f6de/597df0e1 等旧 Backend 不能直接使用。
- 若必须恢复旧 Backend，先另审新增列+安全标量/ID 重建与视图恢复方案；canonical 与业务 finish reason 不互相伪造，历史未迁 raw JSON 无法靠空列还原。不把“重新加 NULL 列”当完整回滚。
- ID 持久化前崩溃的未知上游调用不盲重发/伪造 ID，按既有业务超时释放预留；成功但无可信结束原因的记录停止等待人工审计，不猜测计费。
- 发现扣费/取消终态错误，停止发布/清理推进，保留 charge_id 幂等与钱包流水，按既有受审查补偿流程处理，不手改余额或删流水。

## 交付证据待填

本轮代码/三份 SQL 已本地完成，自动回归及真实 PG17/PostgREST DROP 验证通过；TEST/Production 实际新部署和业务验收尚未执行。交付时分别填代码路径、SQL checksum/顺序、每项本地命令、真实环境矩阵/缺口、四类门禁和最终兼容 SHA。PR/CI 成功、mock 测试、历史真机反馈不得互相替代。

## 2026-10-16 用户补充确认与实施授权

最高约束：本次改造不得影响正常发送、重生成、流式回复、取消/超时及对话正文/历史/终态/计费事实的正常落表。调用 metadata 与历史治理不得删除或改写对话正文；异常时保留已观察到的回复及原业务终态，不因诊断写入失败将已落表正文改为空。新增持久化接缝只保护恢复事实，须通过正常/失败落表回归与隔离库删列后真实 repository 验证。历史不明确记录阻断清理，不能影响新对话。

用户已明确授权：补齐下列两类处理规划后直接本地实现，无需再次规划审批。远端迁移/提交推送/PR/部署仍未授权。

- 41 条有 ID 缺 OpenRouter detail：旧 writer 退出后重新计数，核对无 Venice/归属冲突；新增 catch-up 只补安全标量与 ID，非空冲突停止，不复制 raw JSON/主表业务 finish reason。近窗回捞迟到 metadata，超窗保留已知事实；核对缺失与不一致归零，单独检查计费/额度。
- 12942 条无 ID/无 detail：不能据此认定没有可迁移 metadata。聚合分类为“可靠归属+安全字段可迁移（NULL ID）”“无调用事实且业务计费已收口”“计费/额度未收口”“归属/值冲突未知”。只迁可证明 OpenRouter 的安全标量，不能仅因无 Venice 就给无 ID 历史猜 provider；没有信息不伪造 ID。未收口沿原 charge_id/冻结快照/已确定业务原因恢复，信息不足停止自动处理并人工核验。全部分类、可迁移信息已保留且未知项获确认前禁止 DROP。两类数字都是旧快照，切换时重新计算；TEST 165 不替代 Production。

新增 migration 的分类守卫必须拒绝未保全的安全调用字段、不明确 provider、ID 冲突和未完成结算/额度；无法证明原始 JSON 可丢弃时阻断 DROP，由受控内容治理另审，不盲搬或静默删除。本地可用合成 fixture 验证拒绝路径，真实环境未知项不自动通过。

## 当前额外停止条件

DROP 实现会拒绝任何非空主表 llm_generation_data；本轮没有证明其内容可以安全丢弃，不能盲迁或直接置空。仅合成 fixture 为验证拒绝路径而清除测试值，不是生产处置方案/授权。历史未结算 guard 区分 legacy/missing-detail 与专表已建、旧列为空的新 streaming 调用；正常新调用无需为历史清退被强制中断。ID 首次落库/metadata/正文与计费事实的正常路径已本地回归，仍需部署后真实业务验收。

## T9 新增专表清退范围与当前操作顺序（本地实施）

可先合并430使development部署无主表旧列依赖的Backend，但PR425仍共享TEST且旧代码有依赖，必须升级或停止/隔离，并核对所有旧进程退出。合并不等于可以执行现有DROP。前两份新SQL已在TEST记账，不能再次运行；停止旧writer后重新审计窗口，需要修补则新增受审阅forward migration。

现有DROP仅删主表12列，不会清理OpenRouter专表。新增范围为专表11重复llm\_\*别名，保留canonical列与llm_generation_id/data现名，另交独立contract文件；两处DROP分别有本环境门禁。TEST旧JSON1797和历史守卫1281均须分类解决；不能因metadata空判新调用失败。原名覆盖/旧别名约束与消费者检查、隔离库双处物理删列回归完成后，再列最终文件顺序与checksum。专表删列文件现为 `packages/shared/migrations/20261016_openrouter_chat_history_drop_legacy_aliases.sql`；原主表DROP守卫保持，不自动处置旧JSON。

### T9 已核验与执行边界

- PR430已合并，merge f15fb73d；development部署de247e4f-7931-4702-b6e3-868b8e27e847 / f15fb73d SUCCESS，旧bc82947a REMOVED。TEST专表11对字段缺口及非空冲突均0，两份DROP账本均未执行（本次只读快照）。PR425共享TEST旧writer上次仍在线，执行前重查/升级或隔离，不能仅依据dev更新放行。
- 新增专表contract可先执行，前提是本环境全部别名消费者退出、DB依赖和窗口覆盖通过。原名metadata为空允许待回捞，不要求为了删别名重新调用上游。先核对alias/canonical冲突和补齐候选预算，未知约束停止。
- 顺序：已完成的catchup/views不重跑 → `packages/shared/migrations/20261016_openrouter_chat_history_drop_legacy_aliases.sql` → 验证 → 原JSON/历史分类/无主表旧消费者门禁通过后，单独执行 `packages/shared/migrations/20261016_chat_history_drop_provider_metadata.sql`。后者当前仍不能直接执行；本轮未授权或执行远端JSON清空/补账/停止PR425。
- 回退只能到已通过主表12+专表11列不存在验证的canonical writer，不能回退旧别名writer；如需空列重建另审数据恢复，不执行表重写。Production未执行本轮专表preflight，不沿用TEST零冲突数值。
