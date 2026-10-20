# 执行计划与 T4 收尾

2026-10-16 字段名调整已由用户审核并实现，TEST expand 与 Backend 推送已完成（68bf9085/caebc0c6）；T4 实时证据见 research/t4-final-audit-2026-10-16.md，生产方案见 production-release-checklist.md。以下为 T2R 原执行顺序：新增 expand migration → OpenRouter 原名类型/仓储/结算/回捞消费者 → 计费输出与原始元数据分离 → 扩展现有回归与本地迁移验证 → 同步文档与结果。远端 migration、提交/推送和部署不在本次本地实现步骤中自动执行；新 Backend 依赖该 migration。T3/T4 状态按真实验收保留。

1. 复核当前分支、目标库、迁移账本、全部 DB/代码消费者和历史行可归属规则；形成 TEST/Production 各自的前置结构记录。若归属或旧 Backend 兼容未明确，暂停删列阶段。
2. 在 `packages/shared/migrations/` 新增一张 `experience.openrouter_chat_history` 的前向 migration，并在 Backend 生成/结算/回捞仓储接入占位与幂等补齐。主表业务结束原因及计费事实仍走原路径；不新增公开 DTO 或跨层依赖。
3. 在 TEST 按文件逐一执行并验证 shape、权限/RLS、FK、唯一性、重复 upsert、失败与并发路径；安全分批回填已确认 OpenRouter 的历史行，核对缺失、空值、重复和 raw JSON 内容。改回捞及 `current_chat_history` 消费者后再评估旧列清理，清理另设停止点。
4. 优先扩展现有相关回归测试，覆盖免费/付费、取消/超时、迟到用量、重复回捞和计费失败恢复；若现有测试无法锁定关键迁移/并发风险，审阅后再创建专项测试文件。运行 shared/backend 相关测试、受影响包 typecheck、`pnpm -r typecheck`、build、lint、migration 静态检查及 `git diff --check`。记录 TEST 人工 SSE/结算/回捞场景及失败路径。
5. 更新 README、架构和相关 spec 的实际读写位置、发布顺序及 rollback/forward-fix；给出 Production 单独迁移与验收方案，不自动执行 Production、部署、提交或推送。

## T4 最终审阅发现的必要修复（2026-10-16）

现有已审核规划要求计费失败恢复、Venice 行为不变和有界无内容 metadata；最终 diff 发现新专表扫描丢失主表 pending settlement 条件，且仅黑名单过滤 JSON 不能证明内容隔离。此次在既有模块内修复，不新增任务、依赖、公开 API 或 migration：

1. 复用主表仓储增加有界未结算扫描；保留专表原名字段扫描；补上专表占位缺失的 anti-join 恢复，明确排除 Venice。三路分别最多 50 条、24h、5s timeout，按 parent ID 去重，避免 metadata 队列占满挤掉计费恢复。Venice 只沿原主表 finish reason/charge_id 恢复，不调 OpenRouter API。
2. 原始诊断改为有界 allowlist，只保留厂商元数据字段和数值错误码，不持久化未知字段/error message；fetch 失败日志使用安全诊断。保留 canonical 字段/zero/NULL 语义。
3. 扩展现有 repository/sync/mapper 测试，覆盖元数据完整但结算失败、Venice 恢复、缺失占位、重复候选和恶意未知正文/凭证。这是既有计费/隐私风险回归要求，无新增测试文件。
4. 运行 Backend 全测试、Shared 测试、workspace typecheck/build、lint/import/legacy/migrations、本地迁移回归。人工 TEST 验收继续独立保留；本地修复不代表 PR/部署已包含。

可靠性：DB 唯一键与 charge_id 仍是幂等事实；多实例可重复读取/收口；不引入跨网络事务、无限重试或队列。暂停/恢复仅回退本地补丁，保留 additive DB 与新旧字段；Production 仍需逐文件独立批准。超出 24h 的遗失占位/旧 writer 窗口需审查 catch-up，不宣称自动恢复。

## T5–T8 清退执行计划（2026-10-16，取代前述兼容发布终点）

用户已明确授权补齐两类历史处理和正常落表约束后直接实施。T5–T8 本地实施已完成；实际结果及真实环境缺口见 research/t8-local-retirement-verification-2026-10-16.md。

1. **T5 只读与规划**：读取全部要求材料、记录 dirty baseline/分支；核验 PR424/429、实际两环境 deployment、四份账本/checksum、catalog/ACL/依赖和必要聚合，输出 research/t5-retirement-audit-2026-10-16.md。更新 PRD/design/task/manifests/release。生产快照冲突全量核验、外部消费者 owner 与实际日志观察仍是执行门禁。
2. **T6A ID 和意图持久化**：先扩展现有 repository/upstream/execute/generate/types。预检后上游前 await snapshot+provider 占位，ID 首次观察时 async await 专表写入；有界重试/结果未知读回/不同 ID 拒绝。改 tap 不吞 DB 异常，header/SSE/non-stream 全覆盖。移除 finalizeTurn 的主表 generationId 参数和写入/主表 row 类型旧列。不让 fire-and-forget 作为唯一可恢复事实。
3. **T6B 恢复**：pending 主表只投影业务/计费列，JOIN 各自专表 ID；metadata 与 missing/无 ID 诊断各有预算、独立失败隔离，provider 冲突不猜测。恢复 stale/no-ID 的终态和额度释放；完成 metadata 仍重试 charge/quota/回写。Venice-only 不因缺 OpenRouter key 停止。不改钱包语义/重新定价。清理相关 fixture，保留历史 SQL 和合法专表字段。
4. **T7 migration**：按设计新增 catch-up → view → DROP 三文件。先本地验证 shape、历史/窗口守卫、安全标量 NULL/0、provider 冲突、view 类型/基数/最新 revision/权限；再隔离库真实 DROP 12 列。新增清退 harness 的必要性由不可逆 DDL+计费风险确认，扩展现有 upstream/execute/generate/repository/sync/settle 测试，避免镜像实现的无效测试。
5. **T8 最终验证/交付**：全范围复查、必要缺陷修复，更新 README/ARCHITECTURE/Backend+DB spec、module-updates、task 与 release。远端门禁保持未勾选；交付本地完成情况、新 SQL 顺序/恢复、环境实况和未验收矩阵，不自动暂存/提交/推送/PR/部署。

### 本地自动验证（本轮已执行，结果见 T8 报告）

- Backend 既有全测试和 Shared 测试；优先 targeted test 快速定位，再各跑一次全量：
  - pnpm --filter @miniapp/backend test
  - pnpm --filter @miniapp/shared test
  - pnpm -r typecheck
  - pnpm -r --workspace-concurrency=2 --if-present build
  - pnpm lint
  - pnpm lint:imports
  - pnpm lint:legacy
  - pnpm lint:migrations
  - pnpm test:migration-ledger
  - OPENROUTER_TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin bash scripts/test-openrouter-original-fields-migration.sh
  - 新清退 harness：隔离 PG17，无远端凭证，真实 repository SQL/读写在 DROP 后运行；失败 shape/锁/事务回滚、最小权限、重复执行安全失败和两个 provider fixture。
  - python3 ./.trellis/scripts/task.py validate 10-15-openrouter-history-extract
  - python3 ./.trellis/scripts/module_knowledge.py check .trellis/tasks/10-15-openrouter-history-extract
  - git diff --check

### 风险回归矩阵（AC2–AC4）

- 付费/免费各发送及重生成；每 revision 唯一 detail、每 charge 唯一扣费/额度终结。
- 取消先赢/完成先赢、超时、晚到 stop、上游 4xx/429/5xx/挂流/迟到 metadata；主表终态优先且不重开计费。
- metadata 完整但 wallet/quota/主表回写分别失败；重复 worker 与多副本重入依旧同 charge_id。
- 上游前 snapshot/占位失败不发请求；首 ID 写失败/结果未知/冲突；进程在 dispatch 前、ID 前后、charge 后/回写前退出；无法找回 ID 的调用明确停止并释放预留。
- Venice ID 取自其专表，失败恢复不调用 OpenRouter、不丢额度/计费；无 OpenRouter key 时 Venice 恢复仍运行。
- view 无明细/两表冲突、NULL/0、OpenRouter 与 Venice、旧 revision 和无 session 历史；列序/类型/基数/owner/ACL/security_invoker/RLS 不漂移。
- 隔离库真正删列后开轮、finalize、取消/超时、billing outcome、专表 upsert、候选扫描、current/analytics SELECT 仍通过；明确真实 DB 验证范围，上游/钱包 mock 不宣称真实验收。

### 真实环境门禁（仅记录，需之后授权/验收）

分别按 TEST/Production 记录最终 SHA/所有副本退出/首末 writer 时间、ledger/checksum、权限、历史覆盖/快照冲突/无 ID 分类、窗口 catch-up、EXPLAIN/锁/复制/容量、外部分析 owner 与旧列读写日志。现有 T3 免费/取消/超时/错误/恢复/多副本真机矩阵仍未完；不由自动测试勾选。Production #429 尚未合入，不能假设现在已运行专表 writer。所有远端写操作都等单独授权。

## 2026-10-16 用户补充确认与实施授权

最高约束：本次改造不得影响正常发送、重生成、流式回复、取消/超时及对话正文/历史/终态/计费事实的正常落表。调用 metadata 与历史治理不得删除或改写对话正文；异常时保留已观察到的回复及原业务终态，不因诊断写入失败将已落表正文改为空。新增持久化接缝只保护恢复事实，须通过正常/失败落表回归与隔离库删列后真实 repository 验证。历史不明确记录阻断清理，不能影响新对话。

用户已明确授权：补齐下列两类处理规划后直接本地实现，无需再次规划审批。远端迁移/提交推送/PR/部署仍未授权。

- 41 条有 ID 缺 OpenRouter detail：旧 writer 退出后重新计数，核对无 Venice/归属冲突；新增 catch-up 只补安全标量与 ID，非空冲突停止，不复制 raw JSON/主表业务 finish reason。近窗回捞迟到 metadata，超窗保留已知事实；核对缺失与不一致归零，单独检查计费/额度。
- 12942 条无 ID/无 detail：不能据此认定没有可迁移 metadata。聚合分类为“可靠归属+安全字段可迁移（NULL ID）”“无调用事实且业务计费已收口”“计费/额度未收口”“归属/值冲突未知”。只迁可证明 OpenRouter 的安全标量，不能仅因无 Venice 就给无 ID 历史猜 provider；没有信息不伪造 ID。未收口沿原 charge_id/冻结快照/已确定业务原因恢复，信息不足停止自动处理并人工核验。全部分类、可迁移信息已保留且未知项获确认前禁止 DROP。两类数字都是旧快照，切换时重新计算；TEST 165 不替代 Production。

新增 migration 的分类守卫必须拒绝未保全的安全调用字段、不明确 provider、ID 冲突和未完成结算/额度；无法证明原始 JSON 可丢弃时阻断 DROP，由受控内容治理另审，不盲搬或静默删除。本地可用合成 fixture 验证拒绝路径，真实环境未知项不自动通过。

## T9 执行计划：专表重复别名（已授权实施）

1. 全量检索专表11旧别名的运行时消费者/脚本/视图/约束；历史migration只读。核对canonical缺口、冲突及权限，不读取/导出聊天正文或raw JSON。
2. 提交可审阅的历史JSON处置和无snapshot结算分类方案；保持正常对话落表优先，不把待回捞当失败，不伪造状态或账务。
3. 新增专表独立contract SQL；保留ID/data现名，原名字段/唯一FK/权限，定点处理旧别名约束，不CASCADE。主表drop未执行时如需调整其守卫，先实时确认两库账本，并纳入最终审阅；已执行文件不可修改。
4. 扩展既有隔离PG/PostgREST harness，真正删除两处列后验证正文/ID/metadata/恢复/计费/取消晚到/并发/Venice/视图；测试缺口、冲突、权限、依赖和重复执行拒绝。运行Backend/Shared相关测试、全消费者typecheck/build、lint/import/legacy/migrations/ledger和diff检查。
5. README/架构/spec/task/清单同步；最终diff人工审阅后方可提交。实际合并/升级/停止其他环境/远端SQL各需授权；逐库逐文件核验，不沿用本地或旧快照宣称通过。

T9范围校正：本轮只读核验并提出历史分类策略，不对未审阅历史JSON做处置，不修改原主表DROP守卫。先完成可独立验证的专表contract；旧记录无snapshot/无settled_at仅表明旧契约缺乏证明，不算新调用失败，不生成补扣或假结算。真正的历史处置仍需独立可审阅方案和数据授权。

## T10 执行计划（用户要求直接进行）

1. TEST只读聚合JSON形状/字段名频次、provider/ID、账单与dedup/额度；Production仅核对治理账本确认原DROP未执行。输出必要计数不导出内容。
2. 新增历史处置migration，2000预算、pg_temp白名单、typed原名补缺、清父表旧raw；保留正文/终态/账务，不能补扣。修改尚未执行的主表DROP账务守卫，依赖历史处置账本与旧schema边界/明确分类。
3. 扩展既有隔离PG/PostgREST fixture/harness：新增billing治理最小合成结构，测试旧closed/dedup/paid-failure/pending、新snapshot/current-missing/reserved、raw身份冲突/unknownprovider/非法形状/预算/回滚；真实DROP后业务与账务不变。
4. Backend/Shared tests、所有consumer typecheck/build、lint/import/legacy/migrations、ledger、旧expand、脚本类型/语法及diff检查。同步README/架构/spec/task/清单；最终人工审阅后才能提交，远端单文件执行由用户另行操作。

T10补充证据：TEST专表自身有49条非白名单诊断；同一历史处置同时按现有mapper白名单规范化已有OR诊断，当前诊断优先，父表raw与专表诊断使用指纹CAS，变化则整笔回滚。Venice明细仍不写，缺少有效原名事实会停止。候选为旧父表JSON或已有OR诊断的并集，总数超过2000停止，不先清空再核对。

## T11 执行计划（用户本轮要求检查并修复）

1. 只读核对Action/两库ledger+claims+catalog，EXPLAIN后以15s上限测量备选SELECT及聚合，不输出业务行/内容/凭证。记录来源与时间。
2. 在既有in_progress任务内新增20261020 forward恢复SQL；最多两批各2000，4001拒绝，保留60s/5s、全部安全边界；不改原已执行SQL。已删列分支需核对账本。
3. 扩展既有retirement harness（迁移/并发风险必须回归，无新测试文件），验证2815跨批、4001拒绝及失败全回滚、NULL/0/不覆盖、未知归属不写、冲突、重复执行、两处真删列后可跳过、无账本及部分shape拒绝；继续真实PostgREST消费者回归。
4. pnpm lint:migrations、lint:legacy、test:migration-ledger、Shared test、pnpm -r typecheck、workspace build、git diff --check；检查历史SQL checksum不变。同步README/架构/DB spec/发布清单与报告。最终人审后才可提交/推送，远端迁移独立批准。
