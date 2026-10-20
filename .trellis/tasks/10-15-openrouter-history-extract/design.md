# 轻量设计与规划门禁

## 事实、复用与归属

2026-10-15 已确认当前分支 `dev_openrouter_migrate`，Supabase URL 为正式 TEST `zoqelpfhurwehlvypryl`；只读 catalog 证实 13 列和 `venice_chat_history` 实表。未读取业务行。实施前重新核对 TEST/Production schema、迁移账本与部署版本；两库不假定同构。

- 检索并复用 `ConversationHistoryRepository` 的终态/计费写入、`generation/openrouter-metadata.ts` 的唯一字段映射、`settle.ts`、`sync-job.ts`、`VeniceChatHistoryRepository` 和 `20260929_venice_chat_history.sql` 的一对一结构。扩展 OpenRouter 专属 repository/查询，不建立跨供应商通用框架，也不改 Venice 写入逻辑。
- 已检索 `current_chat_history` 视图、`start_chat_history_*` 开轮 RPC、`billing.charge_llm_usage` 计费路径、`packages/shared/src/api/conversations.ts` 消费契约及 Prisma schema。开轮与钱包事实不移入新表；当前 DTO 无元数据字段，若保持不变无需新公开 API。实施时复核所有函数/视图/管理查询依赖。
- `experience` 拥有对话调用产物；`billing` 仍拥有扣费流水，新表不成为第二套计费事实。`chat_history_id` 唯一 + FK cascade；provider 身份固定为 OpenRouter，底层 `llm_provider_name` 另存。仿 Venice 采用最小权限和字段约束，但应按 TEST 当前暴露/RLS 配置重新验证，不机械复制。

2026-10-15 T3 归属补充：用户确认当前只有 OpenRouter 和 Venice 两条调用路径，且每次 Venice 调用均有 `experience.venice_chat_history.chat_history_id`。因此，对已有 `llm_generation_id`、且没有 Venice 明细的主表行，按排除法归属 OpenRouter。TEST 聚合审计未发现明细重叠或快照标记 Venice 却缺 Venice 明细的冲突。迁移增加冲突守卫，保留主表与原始 JSON 不动；无 generation ID 的行没有可转移的调用键，不在这次补迁移内。`llm_provider_name` 实际是 OpenRouter 路由厂商，不能约束为调用方常量；用 forward migration 放宽这一列，同时改 Backend 占位写入。若后续发现 Venice 明细滞后，应停止清理、审计冲突并另做 forward-fix。

## 写入与读取边界

同步终态写主表业务结束原因；OpenRouter generation ID 应在拿到时落入新表占位行，供回捞定位。`/generation` 返回后 upsert 原始明细，只有成功态且上游给出合法原因才更新主表业务原因；取消/超时不可被晚到 `stop` 覆盖。计费快照、实际扣费和结算时间继续写主表。新表 `llm_generation_data` 新写入采用有界、安全字段；旧原始 JSON 回填须先审计内容并确定保留策略。

回捞仍以 24 小时、有限批次扫描，以新表 ID/完成字段及主表结算状态共同判断。`usage_cache` 是可选字段，不作为回捞完成条件；原有“OpenRouter 从不返回该字段”的注释不准确，2026-10-16 已按用户确认保留厂商原名并统一完整性口径。当前视图投影主表旧列，必须在删列前重建受影响投影及消费者。

## 可靠性、发布与恢复

### 2026-10-16 已审核原始字段名调整

- 复用 OpenRouter mapper、repository、settle/sync 和主表计费仓储；将 11 个 OpenRouter 字段改用原名，保留 `llm_generation_id`、`llm_generation_data`。不新增公开 DTO、跨 provider 框架或依赖。
- 新增原名列的 expand migration，保留类型/数值约束与旧别名，按同一行复制已有值；保留 FK/唯一/权限。旧 Backend 可继续写旧列，新 Backend 仅写/查原名。迁移前不得部署新 Backend；切换期间旧 writer 产生的记录由新字段缺失扫描再次回捞，窗口结束需补核并做一次受审查 catch-up，再在无旧消费者后单独 contract。当前不交付删除旧别名的 SQL，也不清理主表。
- Backend 使用单一原名 OpenRouter 元数据类型；计费函数单独返回金额/结算结果，主表仓储显式接收 business finish reason 与计费结果，防止原始 `stop` 覆盖取消/超时。Venice mapper/repository 不改，公共计费接线只做等价参数调整并回归验证。
- `usage_cache` 允许缺失，不把它设为回捞完成的必要条件；缺失不等于零，也不换成 `cache_discount`。
- migration 设置锁等待/语句超时、事务与 shape 检查；本次约两千行规模用单事务回填，超出该规模应重新评估。失败整笔回滚；成功后保留 additive schema 可回退旧 Backend，但新列期间的数据不能靠旧应用回退自动反写到旧别名，恢复时先保留新数据并 forward-fix。
- 必要专项验证：本地隔离 PostgreSQL 执行前序/新迁移并核对所有 11 列值、零值/NULL、重复执行、FK/权限/约束；既有 mapper/结算/回捞/取消测试扩展锁定原名、计费不污染元数据及终态保护。发布后的 TEST 真机验收单列，不以本地结果替代。

- **超时/重试/限流**：沿用有限 24 小时回捞及批次上限；补齐外部请求必须设置明确超时，仅安全读取可重试并退避。无新无限重试或新队列。
- **幂等/并发/事务**：`chat_history_id` 唯一 upsert；结算仍由既有 `charge_id` 幂等。主表业务终态与原始元数据分写，失败可回捞，不把跨网络调用包进 DB 事务。验证取消与晚到上游结果竞争，以及双实例重复回捞。
- **降级/补偿/容量/观测**：元数据写失败不改变已交付回复，保留可回捞的 ID 和计费快照；按现有 pino 记录 ID、阶段、耗时和错误，禁止正文/密钥/完整原始 JSON。回填分批并核对数量、空值和尺寸；索引仅服务 generation ID 与回捞查询，先看查询计划和锁影响。
- **发布顺序**：新增表/权限 → Backend 兼容读写 → 安全回填与核对 → 新读路径/视图 → 停旧写并证明无引用 → 单独清理旧列。若任一步校验失败，停止清理、保留旧列并 forward-fix；删列后不以回滚旧 Backend 作为恢复手段。每个 migration 单文件经手工 workflow 先 TEST 后 Production，Production 需另行审批与验收。

## 2026-10-16 T5 主表清退设计（最新规划，用户已授权实施）

本节取代上文“本轮只保留旧列/不交付清理 SQL”的范围限制；T1–T4 原文作为历史设计保留。业务终态和计费归属不变，移除的仅为 PRD R1 的 12 列。环境证据见 research/t5-retirement-audit-2026-10-16.md。

### 1. 复用调研与最小范围

- 扩展 ConversationHistoryRepository 的 finalizeTurn、pending billing、缺失 detail 扫描：主表只提供业务/计费事实，不再从物理主表取 generation ID；移除 ConversationHistoryRow 的旧 ID 与 finalizeTurn 入参/UPDATE。内部恢复结果改用 generationId/callProvider，避免把专表来源伪装成主表列。
- 复用 OpenRouterChatHistoryRepository 的唯一 parent key、ensureGenerationId、mapper 和有界 metadata 扫描；ID 写入采用仅补空或相同值成功，不允许空占位/并发旧结果清空或替换已持久化非空 ID。
- 复用 execute/upstream SSE tap、GenerationHooks 和 generate 编排；增加最小内部 async 持久化接缝，不新增 shared/API。复用 applyLlmCharge/charge_id 与 quota.finalize，不创建新的钱包/队列/租约系统。
- Venice 仅扩展现有 repository 的占位/ID 持久化和恢复读取接线；不改 mapper、表结构、估价或免费额度规则。未到 metadata 时不写假 token/费用。
- 已检索 Shared conversations DTO、Prisma 和 Frontend/Admin/CS 源码：未发现读取这 12 个主表调用字段的公开消费者；llm_model_catalog、billing.llm_usage_charges 等同名片段不是旧列。实施结束重搜全部代码/脚本，更新旧 fixture。
- 复用既有两视图，CREATE OR REPLACE 显式列投影；复用隔离 PG17 测试脚本基础，但现有 fields 脚本只测 expand，无法代替删列后的真实 repository 验证。风险评估确认需新增一个本地清退专项 harness，并优先扩展已有 Vitest 文件。
- 拒绝新 provider 抽象、第二份 ID/outbox 权威源、重建 Venice mapper、删除专表别名、盲搬历史 raw JSON、增加公开 DTO/依赖。无新业务表或运行时配置。

### 2. 调用开始、ID 持久化与故障停止

当前 settleGeneration 为 fire-and-forget，快照也在终态后保存，不能承担“崩溃前已持久化”的保证。新流程：

1. 在已有 quota/定价/余额预检后、请求上游前，await 保存请求时 billing snapshot，并在对应专表 ensure 空占位。使用已有 parent/charge_id。占位或快照失败即不发送上游；释放预留，正常错误/清理路径收口。重试仅幂等 DB 写，至多 2 次、每次 5s、一次短退避，总体仍服从本轮 deadline。
2. 响应头有 ID 时先 await 专表持久化；否则 SSE 首次解析出 ID 时在该 chunk 的 delta/后续消费之前 await。non-stream JSON 走同一接缝。async 持久化异常必须传出 tap，不可被 JSON parse catch 吞掉；保持 chunk 顺序、背压与取消行为。
3. ID 写入超时属于结果未知：安全读取同一 parent 的专表 ID，相同则成功；NULL 可在有界预算内重试，不同非空 ID 为冲突，停止本轮且报警。禁止重复发送生成请求。失败耗尽后 abort 上游、释放额度、保留可审计占位和主表业务失败；不以主表 ID 兜底。
4. 完成/中断前后可再次幂等补专表 ID，但不覆写已持久化元数据；finalizeTurn 仅写主表终态/正文/charge。取消/超时 CAS 仍权威，晚到 upstream stop 仅写专表。settle 与 sync 均从专表读 ID，不将历史 billing generation_id 作为新的调用事实权威来源。
5. **无法消除的外部窗口**：上游接单后、ID 持久化前进程崩溃，DB 中只有占位/快照，无法通过上游 API 凭空找回 ID。新版本不宣称自动补回：主表 streaming 超过现有 120s 阈值时按既有取消/超时逻辑释放预留、CAS 收口、不扣未知调用；保留“有占位无 ID”的聚合观察。已交付但终态/原始原因不足的记录不猜测 stop、不重新生成，进入明确人工核验停止状态。不得用删除缺失扫描掩盖这些记录。
6. 占位丢失但 ID 已保存是不可能的常规事务状态（同一行）；被外部删除/损坏后没有其他 ID 权威源，按缺失 detail 审计/停止而非制造 ID。拿到内存 ID 的当前请求仍可安全重建专表。历史缺失使用下述一次性窗口补齐。

### 3. 计费与恢复读取

- 保留独立 pending billing 扫描，条件以主表 snapshot/charge/settled_at 为准，不能只扫描 metadata 不全；显式投影业务列并 LEFT JOIN 两张 provider 表的 ID，按对应明细和 snapshot 判 provider，冲突停止且记录计数，Venice 不请求 OpenRouter API。
- OpenRouter 元数据扫描继续直接从专表有界取候选，按 parent 唯一键取业务事实；调用 ID 仅来自专表。usage_cache 可缺失，0 不等于 NULL。metadata 完整但计费失败依然进入 pending 扫描。
- 原 missing-detail 扫描改为检查预先持久化的调用意图/快照和明细缺失或 ID 缺失，不依赖已删主表 ID；不能简单删除。streaming 新记录不被后台提前结算，过期记录复用 stale-turn 终态/额度释放。
- 有已持久化 ID 时沿原 OpenRouter 回捞；无 ID 的失败/取消/超时，已有定档计费可通过同 charge_id 和已确定业务原因收口/释放，不伪造 ID。成功但原始原因未知且无 ID 则停止等待人工核验；历史 usage 计费缺少可信 usage 同样停止，不重新定价。
- Venice pending 从 venice_chat_history 读 ID，继续按主表业务 finish reason/冻结快照结算。重启/多副本重复处理靠 unique parent、固定 charge_id、钱包 RPC 与 quota 终结幂等；进程 isRunning 仅减少本进程重叠，非并发正确性来源。
- 初始维持每源 50 条/24h、DB 5s/30s tick，独立失败隔离、按 parent 去重，明确缺失/冲突/超窗/推进计数；避免永久无 ID 阻塞正常 pending（分开候选预算）。不引入无限重试；超窗积压另行受审查 catch-up。hasOpenRouterKey 不应阻止 Venice-only 计费恢复；只跳过需要该 key 的上游读取。

### 4. 历史与视图切换

交付三份新 SQL（文件名为规划候选，实施后核定 checksum/顺序）：

1. 20261016_openrouter_retirement_catchup.sql：最后旧 writer 退出后补窗口和安全字段。只将已证明 OpenRouter 的 parent ID/可控标量补入专表；有 Venice 明细的 ID 只核对/补其专表空 ID，不改变 mapper/结构。非空不一致、两明细重叠、Venice snapshot 无明细时拒绝。禁止迁入原始 generation_data 或将主表 finish reason 当上游原因。按实际缺口规模与 EXPLAIN 确定有界批次；超过已验证预算即失败停止，不能调大 timeout 硬跑。
2. 20261016_chat_history_provider_metadata_views.sql：current view 的 12 个输出字段改来自 o canonical 或 v 既有列，按明细存在性选择对应 provider，禁止单纯 COALESCE 将两 provider 混合；业务 llm_finish_reason 始终 h.llm_finish_reason。无明细返回 typed NULL，不能继续引用 h 旧列。历史 raw JSON 不复制，只透出现有专表受控诊断。保持 DISTINCT ON(session_id,turn_index)/revision DESC、不新增过滤/放大行数、列序和类型显式检查/必要 cast。已有 base_chat_bj 一行一个 parent，latency 同样按 provider 选择，保留北京时间投影；TEST 未存在则跳过并在隔离 fixture 测试生产分支。
3. 20261016_chat_history_drop_provider_metadata.sql：独立事务，前置断言 12 列 shape、允许的保留列、零 DB 依赖与覆盖守卫，ALTER TABLE DROP COLUMN 显式 12 列、RESTRICT、lock_timeout 5s/statement_timeout 60s。不 CASCADE、不改终态/计费/专表旧别名。应用与运行证据是外部门禁，SQL 不能伪造其通过。

视图归属不变：current 属 experience 互动当前版本投影，base_chat_bj 属 miniapp_analytics 报表；Backend 为明细权威 writer，视图无独立生命周期/写入权威，依赖 experience 三表且与主表父行同生命周期。沿用 owner/security mode/现有 ACL，不复制主表 anon/authenticated grant 给专表。Production current 为 security_invoker=true，cs_persona_reader 需要对应专表的最小列级 SELECT（parent key、视图实际投影的 canonical/ID/受控诊断），仅该角色存在且既有 current view SELECT 时授权；不授表级 ALL、不切 definer 绕过 RLS。原 analytics view 保持其既有安全模式与 ACL。本地必须 SET ROLE 验证正反向读取，不只检查 has_table_privilege。

### 5. 发布、容量与恢复

- 实际顺序由当前结构决定：四份历史 migration 已在两库执行 → 本轮无旧列依赖 Backend 部署（单独授权）→ 确认所有旧副本/旧 job 退出与请求 drain → 独立 catch-up/历史覆盖 → 视图切换 → 四类无依赖门禁 → 最后独立 DROP。Backend 本轮不依赖新增表结构，可在旧列尚在时运行；在旧 writer 仍写入时过早切视图会丢失窗口可见性，因此不先机械改视图。
- Production 本轮 catalog 主表约 34.7 万行、23.45 GB，专表约 24.65e7 bytes；精确数和覆盖见审计。包含 billing_snapshot 的全量聚合在 55s statement/60s client 预算中失败；必须优化为按 ID/时间有界扫描、与小表连接、单独审计快照冲突，不能扩大预算或把一次失败视为“无冲突”。旧表长行/TOAST 与统计误差均需考虑。
- DDL 需 ACCESS EXCLUSIVE，元数据删列也会等待锁；执行前核对 pg_stat_activity 长事务、pg_locks、流量窗口和复制/磁盘余量。不将高开销覆盖扫描放进持有 DDL 锁的事务；预检与 DROP 紧邻、部署冻结后执行。锁超时整笔停止，不自动重跑；结果未知核对 shape 和 ledger/claim/events。
- 删列前可经授权回退至支持旧结构的候选，但视图切换后的旧 writer 可能不写专表，回退须同步停止视图推进并重审窗口。删列后仅能回退到已验证“12 列不存在也可运行”的发布 SHA，或发布同等 schema-compatible forward-fix。若必须恢复旧应用，须另审补回列/投影与重建安全标量/ID的数据方案；原 raw JSON 不可凭专表还原，不承诺无损恢复。不把重新加 NULL 列当恢复成功。
- 删除列不立即回收磁盘，无 VACUUM FULL/表重写。远端迁移、PR/部署/提交仍不在当前授权内。

### 6. 规划自检

复用、超时/重试、幂等/并发、事务、降级/补偿、限流/容量/观测、归属、兼容与 forward-fix、失败路径/消费者/真实删列验证均已列出。没有新 UI、公开 API、依赖或通用框架；不需要修改 Frontend/Admin/CS 产品代码，若复核发现新直接消费者先补证据与规划。用户已授权实施；本地实现与验证已完成，结果见 research/t8-local-retirement-verification-2026-10-16.md，真实环境门禁仍未通过。

## 2026-10-16 用户补充确认与实施授权

最高约束：本次改造不得影响正常发送、重生成、流式回复、取消/超时及对话正文/历史/终态/计费事实的正常落表。调用 metadata 与历史治理不得删除或改写对话正文；异常时保留已观察到的回复及原业务终态，不因诊断写入失败将已落表正文改为空。新增持久化接缝只保护恢复事实，须通过正常/失败落表回归与隔离库删列后真实 repository 验证。历史不明确记录阻断清理，不能影响新对话。

用户已明确授权：补齐下列两类处理规划后直接本地实现，无需再次规划审批。远端迁移/提交推送/PR/部署仍未授权。

- 41 条有 ID 缺 OpenRouter detail：旧 writer 退出后重新计数，核对无 Venice/归属冲突；新增 catch-up 只补安全标量与 ID，非空冲突停止，不复制 raw JSON/主表业务 finish reason。近窗回捞迟到 metadata，超窗保留已知事实；核对缺失与不一致归零，单独检查计费/额度。
- 12942 条无 ID/无 detail：不能据此认定没有可迁移 metadata。聚合分类为“可靠归属+安全字段可迁移（NULL ID）”“无调用事实且业务计费已收口”“计费/额度未收口”“归属/值冲突未知”。只迁可证明 OpenRouter 的安全标量，不能仅因无 Venice 就给无 ID 历史猜 provider；没有信息不伪造 ID。未收口沿原 charge_id/冻结快照/已确定业务原因恢复，信息不足停止自动处理并人工核验。全部分类、可迁移信息已保留且未知项获确认前禁止 DROP。两类数字都是旧快照，切换时重新计算；TEST 165 不替代 Production。

新增 migration 的分类守卫必须拒绝未保全的安全调用字段、不明确 provider、ID 冲突和未完成结算/额度；无法证明原始 JSON 可丢弃时阻断 DROP，由受控内容治理另审，不盲搬或静默删除。本地可用合成 fixture 验证拒绝路径，真实环境未知项不自动通过。

## T8 最终实现校正

最高约束落实为显式业务投影与已收到正文先入 snapshot，metadata 写失败不得清空 SSE 当前 chunk/此前正文或非流式完整 body；各 provider ID 操作每次 5s、总 10s、有界两次写和读回。恢复实际为五路：两个 provider pending 各 50、missing identity、metadata、stale streaming 各 50/24h；单源/单行隔离，无 OpenRouter key 仍处理 Venice/已存事实/超时清理。空上游字段不清既有 canonical 值，usage_cache=0 保留。DROP 的历史结算守卫只挡 legacy/missing-detail cohort，不要求中断专表已有占位且旧列为空的正常新 streaming 调用。旧 raw JSON 非空明确阻断 DROP，未新增自动清空/迁移 raw JSON 的脚本；其内容处置留待真实历史审阅。

## T9 专表旧别名清退设计（已审阅授权，覆盖此前不清别名的边界）

复用 OpenRouter 原名 mapper/repository、专表 UNIQUE(parent)/FK、既有视图及真实 PG17/PostgREST harness，不建新表/状态源/通用 provider 框架。主表原 12 列范围不变；专表仅清理 PRD T9 明列的 11 个重复别名，保留 llm_generation_id/data、canonical 字段及 parent key。

两库已执行的六份相关历史 SQL 不修改/不重跑；专表 contract 必须另新增 migration，先做 canonical 缺口/冲突聚合，旧别名非空而 canonical 为空时仅补可信安全标量、不覆盖新事实。冲突停止；不把旧 llm_finish_reason 强行当上游原始终态。检查旧 CHECK 约束、视图、函数、触发器、RLS、索引与 ACL；对已确认的旧别名 CHECK 约束定点替换/清理，不能用 CASCADE。NULL metadata 允许正常回捞，不能要求所有 canonical 都非空。

先合并430并确认 development 实际部署新 SHA；升级或停止/隔离 PR425 等所有同库旧 writer 后，重新审计切换窗口（catchup 已记账不能重跑）。主表与专表 contract 分文件执行，分别验证，不能把合并视为删列授权。现有主表 SQL 仍会拒绝1797条旧JSON/1281条历史记录，须先完成受审阅的分类/内容处置方案；无snapshot的历史不能直接按 settled_at NULL 宣判失败，也不能伪造已结算。

每个 contract 独立事务、有限 lock/statement timeout、RESTRICT 与 shape/coverage 守卫；短锁窗口失败停止，不自动重试。容量与并发仍用原预检，不进行表重写。删列后只用两处列清退均验证过的兼容 SHA 或 forward-fix；旧Backend不可直接回滚。最小新增文件是专表 contract SQL，扩展既有测试/harness；若窗口审计证明需要新数据修复，再另审有界 forward migration，不预建批处理框架。

### T9 实施校正

新增 `20261016_openrouter_chat_history_drop_legacy_aliases.sql`，独立于主表contract：逐组核对11对列的类型、拒绝非空冲突、仅补NULL原名值（总候选最多2000），移除8个既定的单旧列CHECK后DROP11别名。未知依赖/混合CHECK/shape漂移/两provider重叠拒绝。canonical校验、ID/data、UNIQUE/FK、审计列和ACL保留，不新增对象。与原名字段完全空的占位/待回捞记录兼容，不新增计费或metadata完整性门禁。

TEST两前序已记账、视图已适配，因此本轮实际可按“所有共享旧writer退出/覆盖核对 → 专表11别名contract → 验证 → 历史治理及主表门禁 → 主表12列contract”推进。先清专表不要求主表历史JSON处置，主表DROP则仍拒绝未知旧JSON和历史结算。主表SQL未修改，不通过伪造settled_at或复制不受控JSON绕过。原任务6份已执行SQL均未改动；原主表DROP未改动。

## T10 最小充分历史处置方案（直接本地推进授权）

复用现有OpenRouter mapper白名单、PG/PostgREST harness、repo_migrations、billing.llm_usage_charges/llm_usage_charge_dedup和character_free_chat_quota_decisions。不建历史归档表、常驻worker、通用JSON搬运器或新公开API。新migration只涉及experience的既有调用明细/旧诊断字段；跨域只读billing与治理账本，业务正文/终态、钱包/账单/额度均不写。临时函数/候选表只在pg_temp随事务消失，无持久新对象。

新增历史处置SQL：原始JSON必须是对象、有唯一provider明细且调用ID匹配；同现有mapper白名单逐项验类型/长度/非负数/integer上界，未知字段与自由文本错误被丢弃，不整份迁移。OR仅补NULL canonical和NULL诊断，当前非空事实优先；Venice仅清父表已冗余JSON，不改其mapper/表/明细，原父表安全标量/ID须已保全。每文件最多2000条旧JSON，生产超限拒绝另审有界批次。锁/语句5s/60s，全部写同一事务，失败整笔回滚，不能自动重跑已记账文件。

主表DROP在两库均未记账（TEST直接账本、Production MCP只读治理查询），允许修改此未执行文件；已执行历史文件不改。新守卫要求历史处置记账；以20260911快照migration真实ledger applied_at（checksum匹配）为旧契约边界，旧无快照只在账单/dedup身份一致、状态已分类且无reserved额度时允许元数据清退；旧pending需保留可追溯的原账单与专表调用ID，不能视为结算完成。新contract历史和未知/缺证明成功调用继续拒绝。执行前再次核对两库账本，不可用无快照日期猜测新记录。

原DROP对业务列/ID/标量保全、DB依赖、raw JSON未处置的守卫保留；本次只区分旧账务契约，不清空其他旧标量来绕过原守卫。实际删除前仍核对应用/运行/历史覆盖，PR425按用户明确豁免，不再自动阻挡。恢复采用兼容forward-fix；丢弃的非白名单旧诊断无法靠新表恢复，用户需在远端执行前审阅明确这一边界。

T10补充证据：TEST专表自身有49条非白名单诊断；同一历史处置同时按现有mapper白名单规范化已有OR诊断，当前诊断优先，父表raw与专表诊断使用指纹CAS，变化则整笔回滚。Venice明细仍不写，缺少有效原名事实会停止。候选为旧父表JSON或已有OR诊断的并集，总数超过2000停止，不先清空再核对。

## T11 catch-up 恢复设计（2026-10-20）

复用调研：读取原 catch-up/expand/alias contract、正式 ledger runner、retirement harness/bootstrap、views/drop 及各 repository 现有约束。复用既有映射与测试 harness，不改应用、HTTP 契约、mapper、索引、权限或迁移工具。新增一个 forward SQL，不改已执行文件，不清 claim、不伪造原文件成功记录。原 claim 同 checksum 不符合 abandon_claim 条件，保留作为失败审计。新文件取代本次生产 catch-up 步骤，后续视图/DROP仍独立。

生产只读证据：原计划沿主键全表 merge join，Action 60s 超时；会话禁用 merge join 后同一候选 SELECT 7.403s 完成，2815 候选全有 ID、Venice snapshot 冲突零。需要另审分批而非只调大 2000 常量。本地方案每批2000、最多两批、总候选4001即停止；这是新增恢复文件的独立预算，不修改原2000预算。候选阶段只投影ID并先截到4001，明确 LIMIT 不是扫描成本上限；仅候选阶段采用hash join规避随机遍历，恢复原会话计划设置，不全局调参/增加work_mem。单事务60s与锁5s仍保留，不无限重试。

归属：无新持久化表/视图/函数；仅 pg_temp 候选清单，experience 调用事实仍由既有专表持有，事务结束即删除，无新运行时消费者或跨schema业务依赖。已删完12列且有原DROP账本的目标跳过；部分缺列、缺账本或表不存在拒绝。

故障模型：候选超过4000、provider重叠、ID冲突、Venice快照无明细、非法类型/数据库约束、锁/执行超时均整笔回滚；无网络重试/补偿/队列。ON CONFLICT 仅补NULL，已存在canonical优先；最后复核身份/provider以拒绝并发冲突。旧writer退出仍为外部门禁，不以迁移替代。两批同一事务，无部分提交，失败修正后重新走workflow；成功保留additive事实，禁止回滚删除专表数据。拒绝永久索引、后台批处理框架、全局timeout和复制旧账本。

## T12 设计：现有 Grafana 兼容对象的前向迁移

复用：读取原alias DROP的pg_depend守卫、父表DROP、provider views、PG17/PostgREST harness、真实生产pg_get_viewdef/columns/ACL/comments/index/dependency图；仓库无analytics_grafana定义，不能从TEST推断生产。仅新增一个shared forward文件与必要的合成fixture，不改应用/HTTP/contracts/历史SQL/账本工具，不CASCADE，不建立通用报表迁移框架。用户明确直接修复并推送，无需再次等待规划/提交授权。

归属：报表业务派生属于miniapp_analytics；analytics_grafana是现场既有外部报表兼容schema，范围只原地保留其已有对象名称，不新建schema/新的业务事实源，也不迁入public。暂存两张替代MV沿原schema兼容位置构建，成功切换后不留额外持久对象。权威writer仍experience/billing/app_core，报表只读；生命周期与既有Grafana看板一致，下游只用原查询名。跨schema只读依赖沿用，无新线上运行时依赖。若对象部分存在或定义不匹配所采样指纹，停止。无该schema的TEST只跳过，不制造一套生产报表。

最小方案：临时表保存5对象的源定义/owner/ACL/options/comments/列契约及2个唯一索引；用精确已采样旧定义指纹约束有界替换，仅ch/o待删metadata引用改为o canonical，保留ch.llm_finish_reason和所有其他表达式。两张新MV先在暂存名称WITH DATA构建并建唯一索引，再短事务切换阶段将旧MV改名、新MV改为原名、CREATE OR REPLACE包装视图以更新引用并保留其OID/ACL及下游。v_llm_calls原地replace保留下游MV/视图OID；旧MV最后RESTRICT删除，索引恢复原名，原owner/表列权限/注释恢复，检查对象shape和无待删列依赖。每条耗时CREATE受60s、锁5s保护，所有步骤在同一事务；构建失败或未知下游依赖回滚到完整旧状态，不暴露空MV。正常refresh命令仍使用原MV名称。拒绝直接DROP CASCADE、修改pg_catalog、未填充MV上线、重建整个Grafana域或扩大超时。

可靠性：前置源定义/索引指纹、shape与未知依赖守卫；构建只读业务表，旧MV和报表继续可用至短切换锁；限制每次迁移只重建两个MV。锁/超时/权限/DDL并发漂移/未知依赖均停止回滚，不自动重试。切换前再次复核原对象定义/OID，避免构建窗口被外部DDL改写。新对象撤销默认ACL后恢复原ACL（含grant option与列级权限），未知grantor情形停止；权限不扩大。单事务可能额外使用两张MV空间/WAL，生产容量和刷新调度窗口仍须执行前确认。本地不提供物理源表写入/补扣/清理。恢复优先forward-fix；失败rollback，成功后不回退到引用旧列的报表定义。后续alias/history/drop仍各自门禁。

T12兼容补充：切视图前复用原alias contract的类型/非空冲突/最多2000行守卫，仅将OR同一行旧别名补入NULL canonical，避免旧字段尚有独占事实而报表先切空值。此为调用metadata补齐，主表/正文/账务不写；0与已有canonical优先。若主表metadata与canonical存在旧新差异，报表改取已确认的新专表权威事实，保留计量单位与公式，不承诺旧错误/滞后值完全不变。
