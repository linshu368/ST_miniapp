# B3：长会话历史读取优化（2026-11-11，规划，未实施）

> 已由用户要求的[合并设计](history-combined-design.md)收敛并替代本文实施建议：同时完成分页选键、完整展示投影、真实原子writer、轻量失效及旧数据回填。本文保留当时证据和方案对照，不再按原解析trigger或先只读后决定补投影的顺序实施。AC14含最早页无prompt提取，R10硬门槛不变。

## 证据与边界

- 用户补充：Railway 已出现读取 history 超过 5 秒并超时报错；本次要求将优化加入现有规划，不是执行数据库变更。
- 已连接 Sentry `wangqiao / st-miniapp`（EU）及 Supabase。通过 `get_project` 与 `docs/ARCHITECTURE.md:542`、`.github/workflows/db-migrate.yml` 交叉确认本次 catalog 目标为 **production `wbtsfzozlmurljvglhpn` / ST_telegrambot / ap-southeast-1 / PostgreSQL 17.6.1.063**。没有以其他可见项目代替正式 TEST `zoqelpfhurwehlvypryl`。
- 2026-11-11 只读采集：项目元数据、performance/security/health advisor、pg_catalog/information_schema 的视图、列、索引、触发器名和 ACL。不读取业务行、不运行业务 EXPLAIN ANALYZE、不写远端、不保存原始业务日志或生产响应。
- [Sentry ST-MINIAPP-1C](https://wangqiao.sentry.io/issues/ST-MINIAPP-1C)：`查询会话消息失败：AbortError`，最新事件 **2026-11-10 21:30:35 Asia/Shanghai**，production Backend，栈定位 `ConversationHistoryRepository.listMessages` 的 `AbortSignal.timeout(5_000)`。详情 lifetime 12 次，14d issue search 返回 8 次；统计口径不同，不混为同一窗口计数。
- [Railway production](https://railway.com/project/ce38c0c0-88cd-407a-9c04-06124cd42e97?environmentId=f03d6c61-84e3-434d-a81a-0ae209167ef5)：同一时间点 deploy 流有匹配错误，HTTP 会话详情 GET 为 **500 / 6104ms**。工具传入 `@status:500` 后仍返回了 200，报告在本地再次按状态和路由筛选，不把返回条数当错误数。没有据此推算故障会话轮数。
- [对应 Sentry trace](https://wangqiao.sentry.io/explore/traces/trace/86105c64a0ad43dfba86e5ef56bca54b) 有错误但返回 0 spans，无法从这条 trace 分解 SQL、连接排队、网络和反序列化耗时。
- Sentry 查询 `environment:production span.op:http.server span.description:"GET /api/v1/conversations/:id"`，采集时向前 7d、混合 release/结果：count()=7540、P50=148.65ms、P95=438.66ms、max=6084.31ms。是抽样/聚合的服务端 span 口径，不是完整 HTTP 请求量、成功客户端 API P95、DB P95 或长会话 P95。原任务 1841ms 客户端成功 P95 不被替换。

## 源码与生产结构事实

| 位置                                                                                   | 已确认行为及复用决定                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.ts:44` | 已把 `history` 投影为 `history->0/1`，注释明确它只减少传输/反序列化，库侧仍有 detoast 成本。不能重复把窄投影当新增优化。                                                                                                            |
| 同文件 `:745`                                                                          | `listMessages` 已有 `beforeTurnIndex` 游标，默认 50 条消息，即 25 轮 + 1 轮 sentinel，最大 200 条消息。没有深 OFFSET，也没有精确 COUNT。维持这个外部语义。                                                                          |
| 同文件 `:878/:892/:982`                                                                | 展示需要快照中的 request_id 和开场白；request_id 关联首字前取消，继承消息不公开该字段。不能简单删除 JSON 投影后丢掉这两种语义。                                                                                                     |
| 同文件 `:323/:348`                                                                     | `setPendingRequestId` 委托 `setPromptHistory`，先存占位快照，再存完整 prompt；新读模型必须兼容这个顺序及旧 Backend writer。                                                                                                         |
| `packages/backend/src/routes/conversations.ts:441`                                     | 鉴权、owner/session/displayName → recover/opening → list → active-delivery/placeholder。GET 含恢复写入，不能整段重试。原慢日志主要在成功时输出，失败必须加阶段耗时。                                                                |
| `packages/shared/src/api/conversations.ts:189`                                         | 已有 `GetConversationQuery` / `GetConversationData` / `ChatMessage`；本方案复用，不新增公开 endpoint 或分页协议。                                                                                                                   |
| `packages/frontend/src/lib/api/conversations.ts:60/:132`                               | 已有详情 query、仅 streaming 的 1.5 秒轮询和向前翻页，复用 React Query、取消/缓存隔离及滚动位置。                                                                                                                                   |
| production catalog                                                                     | `current_chat_history` 是按 `(session_id,turn_index)` 选最大 revision 的 DISTINCT ON 视图，还 LEFT JOIN 两个 provider 明细；`session_chat_history` 是自有当前版本与冻结继承的 UNION ALL，再叠加编辑/删除和点赞。                    |
| production indexes                                                                     | 已有 `(session_id,turn_index,revision DESC)` 部分索引、同轮版本 unique、branch `(session_id,turn_index)` PK、override `(session_id,message_id,role)` PK、likes `(session_id,message_id)` PK。默认复用，不按“缺索引”直接建重复索引。 |
| production columns                                                                     | 未见独立 request/opening/display 元数据列；因此不能假设展示已经完全脱离 prompt。                                                                                                                                                    |

**推断待验证**：固定页数仍可能随历史变慢，原因候选包括每个所选轮次的大 JSON 解压，以及 DISTINCT ON/UNION/排序/关联在 LIMIT 前处理过多行。prompt 随有效上下文增长，达到窗口后不一定继续增长；总会话长度、单轮快照大小、重生成版本数和继承比例要分别控制。当前没有长会话样本分桶或 SQL 执行计划，不能断言每次 5 秒故障就是上述原因，也不能排除网络/连接池/锁竞争。

### 用户追加：独立排查整份 prompt 解压

2026-11-11用户进一步要求把解压作为专项一起排查。补充只读结构确认：production `experience.chat_history` 有 TOAST relation，`history` 为 jsonb、storage=`x`（EXTENDED），列 compression 未显式指定。这证明允许压缩/外置，**不证明某条故障行实际大小、压缩算法或耗时**，本次没有查询业务行/TOAST chunk。

机制已核对 PostgreSQL 17 官方源码：[jsonb_array_element](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/utils/adt/jsonfuncs.c) 先调用 `PG_GETARG_JSONB_P`；[jsonb.h](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/include/utils/jsonb.h) 将其展开为 `PG_DETOAST_DATUM`。因此 `history->0/1` 不能理解为只从磁盘读两个小片段，压缩的大 datum 会先被 detoast。是否存在重复 detoast 及具体成本取决于表达式/执行计划，必须实测；不能按两个表达式就直接声称耗时翻倍。首元素还可能是长 system 正文，传回两个元素也未必很小。

专项实验在同一批虚构行、同样过滤/排序/K和冷暖条件下对比：A 仅ID/普通展示列；B `history->0`；C `history->0` + `history->1`（当前）；D 完整history；E 新标量投影。强制消费表达式结果，避免count(\*)将投影优化掉；先不经过视图隔离detoast成本，再通过原视图比较选键/排序/overlay成本。使用可压缩和近似随机正文两组，防止纯重复字符串制造不真实的压缩结果。记录逻辑/物理大小（仅合成数据）、SQL/序列化/端到端耗时、BUFFERS、TOAST访问；对比多轮快照大小，不把整条PostgREST耗时都算解压。

先验证拆分收益再收敛最终SQL与索引形状；若无history对照仍慢，优先定位选键/排序/锁/连接网络，不因解压机制存在就认定它是主要耗时。合成实验默认总容量上限512MiB，大prompt仅放该页及必要邻近轮次，其余轮次用小载荷；避免10000份1MiB与多revision全笛卡尔展开。超过预算的冷盘/容量场景另行记录资源方案，不无限加大本机实验。

**当前执行限制**：本机PATH中没有Docker或psql，未能启动仓库隔离PG17 harness，故本轮未取得该A/B实测结果，也未验证SQL目标。不能用生产MCP突破仅catalog采集规则补跑压测；执行计划中明确在具备Docker的本地/CI环境复现。不因缺本地工具推断数据库不是瓶颈。

官方依据：[PostgreSQL TOAST](https://www.postgresql.org/docs/17/storage-toast.html)、[ORDER BY 与索引](https://www.postgresql.org/docs/17/indexes-ordering.html)、[Supabase 查询优化](https://supabase.com/docs/guides/database/query-optimization)。已查 Supabase changelog；本方案不升级 CLI/SDK，不依赖新日志产品。最终 SQL 形状必须以隔离 PostgreSQL 17 的执行计划和等价性验证决定，不能仅凭视图文字断言 JOIN 一定执行或 LIMIT 一定无法下推。

## 推荐设计：展示读取与完整 prompt 分离

### 1. 小型派生元数据，写时提取，避免读时反复解压

拟新增 `experience.chat_history_display_metadata`：`history_id uuid PK/FK chat_history(id) ON DELETE CASCADE`、`request_id text NULL`、`opening_message text NULL`、`projection_version smallint NOT NULL`。名字是设计候选，实施时核对无冲突；本轮不创建 SQL。

- 一条 metadata 对应一个实际 history revision；主表仍是唯一生成/消息/账务事实，metadata 仅是可重建展示投影。缺行和 version=1 且值 NULL 必须区分，不能靠 `COALESCE(...history...)` 让所有页面永远解压旧快照。
- 使用限定 `INSERT / UPDATE OF history` 的专用 trigger，同一事务从 NEW.history 提取首元素 request_id、前两元素中第一个非空 assistant opening。与当前 head 投影后调用 TypeScript 提取器的类型、顺序、空值和 trim 语义逐项对齐；不复制 system 正文或整份 history，也不把 request_id 当账务幂等键。
- 旧 writer 仍只写 history，trigger 保持派生值同步；新 Backend 不另做跨请求双写。余额/终态/provider 元数据更新不触发提取。限定仅本仓库 session/turn/revision 完整的行，旧 bot 无 session 行不纳入。
- placeholder → 完整 prompt、旧 writer 覆盖和并发 backfill 均由原 history 行锁顺序保证一致。回填先锁定有限 history ID，再读投影并 upsert，避免先读旧快照、后覆盖 trigger 新结果；不 UPDATE history，因此不会重复触发聊天统计、奖励或其他原表 UPDATE 触发器。
- 默认批次上限 100 行、单批 statement_timeout 3 秒、lock_timeout 500ms；最多扫描/解压 100 份 prompt。锁忙跳过并记录剩余覆盖；不重试无限批次、不安装常驻 job。使用按 ID 的可续跑边界，禁止每批从头扫全表。预算不足则缩批并人工继续，禁止一条全表 UPDATE 或全表回填事务。
- 回填作为仓库受控、有限工作量的日期 migration；每次 workflow 只执行一个文件。未完成的范围可由后续审查后的新批次文件推进，不改已执行文件、不给 force_rerun 隐式扩大容量。实现前核实真实容量，只保留结构/计数结果，不导出正文。

### 2. 分页先选键，再组装该页

拟新增内部只读 RPC `experience.list_chat_message_page(p_user_id uuid,p_session_id uuid,p_before_turn_index integer,p_turn_limit integer)`，返回 repository 内部展示行；公开 HTTP/DTO 不变。只允许 service_role/postgres，默认 SECURITY INVOKER、固定 search_path、STABLE；route 的 owner 校验在前，RPC 也拒绝不存在、软删除或 owner 不符的会话。不能在浏览器暴露数据库 client 或任意 user_id。

1. 单一 SQL 语句/快照中，仅从自有 history 的索引键选最新 K+1 个逻辑 turn，再按每个 turn 用 `(session,turn,revision DESC)` 取最大 revision 的 ID。不要先取 K+1 个 revision 再去重，避免一轮大量重生成吃掉整页。
2. 冻结继承从 branch PK 取候选键；保留“任一自有行存在则遮蔽继承”的现有规则和 source user/character 匹配。各分支先施加 session/cursor 及局部 K+1，再全局按 turn DESC 合并限额；过滤必须先于局部 LIMIT，禁止在组装后删除候选导致缺页/错误 has_more。
3. 对最终最多 K+1 个 ID 才读取 user_input/assistant_reply/status/preview/postprocess 及派生 metadata，批量应用当前会话 override/likes；不经 provider 元数据宽视图，不读取 `history`、费用快照或供应商诊断。sentinel 只判断 has_more，返回仍升序，一轮 user 在前 assistant 在后。
4. 选键、版本选择、元数据、overlay 在一个语句快照中完成；不增加每条消息 HTTP/SQL，不新增当前版本指针或进程内权威缓存。命中高修订/继承遮蔽的病态数据时，不承诺严格 O(K)；用计划和基准验证实际扫描量。
5. 开场白沿用仅最早页显示及原 fallback；继承不可意外公开 source request_id，点赞以目标 session 为准，编辑/删除不得还原原正文。streaming preview、首字前 request_id、active-delivery 和 postprocess_version 原样保留。

这是一个专用 repository/RPC 边界，不建立通用查询框架。若基准证明现有窄键视图可实现同等有界选键，可复用 SQL；验收仍要求展示热路径不解压 history，不能把宽视图改名就声称完成。

### 3. 旧数据、兼容与恢复

- Expand（新表/函数/trigger）→ 限额回填并验证 → 新 Backend 读法 → Frontend 无协议变更。旧视图、history、旧 writer 和生成上下文读取保持兼容。不得把模型上下文窗口当成 UI 历史截断方案。
- metadata 尚未覆盖的旧行：RPC同一语句内，仅对最终页缺失 ID 做**一次有界批量条件投影**读取旧 head，最多 K+1 行，仍在 B1 总 deadline 内；明确以缺行/版本判断，完整投影的NULL不触发。只读fallback也保持该语句快照，禁止回到应用逐条查询。记录fallback数量/耗时；不读整会话，不在GET同步写回填。兼容态可能仍有TOAST开销，不宣称已解决该段旧数据性能。
- 展示 fast path 完成标准：发布验证覆盖的历史 cohort fallback=0；未完成范围明确标记兼容态，继续受控回填。投影已计算但值 NULL 不再 fallback。缺历史开场白时沿用原行为，不能换成错误新文案。
- RPC/列缺失、ACL/SQLSTATE/shape 不符直接失败，不以反复 fallback 掩盖 migration 缺失；旧读法整体恢复仅通过回退 Backend 版本，不能每次请求双读竞速。
- 回退 Backend 可继续用旧视图；保留新派生数据及 trigger，停止后续回填即可。只有确认所有新消费者已移除后才另审 drop，禁止回滚 history/用户消息/账务。trigger 若拖慢生成写入，停止 rollout，优先 forward-fix 或在受控迁移中停用新 trigger 并退旧读取，不能静默丢投影仍宣称 fast path 有效。

## 对象归属、安全及可靠性

| 门禁          | 设计                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 域/不变量     | 表、只读分页函数、提取 trigger/function 均属于 experience：会话展示及版本关联，不属于 analytics/public。history_id 与实际版本一一对应；metadata 永远不可成为正文或计费事实源。                                                                                                                                                                                                                                  |
| 写者/生命周期 | 权威输入为本仓库 history writer，派生写者为同事务 trigger 和受控回填；随 history 级联删除，无独立运营生命周期。                                                                                                                                                                                                                                                                                                 |
| 消费者/依赖   | Backend ConversationHistoryRepository 的详情/向前分页及其既有调用方；同 schema 依赖 chat_history/chat_sessions/chat_branch_turns/overrides/likes。用户、角色 FK 沿用既有跨 schema 关系，不新增跨域写依赖。                                                                                                                                                                                                      |
| 权限          | 新表 RLS 开启，无 anon/authenticated policy；显式撤销 default privileges 可能继承的 PUBLIC/anon/authenticated 权限，service_role 只读。trigger 写函数仅因需维护派生表才使用固定 search_path 的 SECURITY DEFINER，撤销外部 EXECUTE，不作为公开 RPC；分页函数不以 definer 绕过 owner。                                                                                                                            |
| 生产 GAP      | catalog/security advisor 发现现有 chat_history RLS=false 且 anon/authenticated 有表权限，current_chat_history 无 security_invoker 选项；仓库 TEST harness 与部分历史定义不同。未验证外部实际可达性，不扩大成本任务为直接改历史 ACL。新表/函数不得继承这些权限；发布前独立核对暴露 schema/现有消费者并登记安全处置，不把迁移文件当生产现状。选择独立小投影表而非往该原表追加公开列，也避免改动所有宽视图消费者。 |
| 超时/重试     | B1 仍只对可识别传输瞬断最多补读一次：首次<=5秒、总读取<=8秒；数据库 statement_timeout/权限/shape/已知慢查询不自动重试。RPC 若配置 DB statement_timeout，应小于 HTTP 剩余预算；HTTP abort 不证明 SQL 已停止。不得让客户端 retry × query retry × Backend retry 乘法放大。                                                                                                                                         |
| 并发/事务     | 单语句读快照；投影与 history 同事务，backfill 先锁 history 再写投影，锁顺序相同。错误使该事务回滚，不吞掉投影写失败继续返回生成成功。评估新增写耗时与 WAL，失败计费恢复仍走原 generation。                                                                                                                                                                                                                      |
| 降级/限流     | 只对明确缺失投影做一批有界旧读取，不伪造空历史，不在失败时扩大 limit。无 Redis、无预读全部会话、无新轮询、无 hedged requests。沿用现有客户端并发帽。                                                                                                                                                                                                                                                            |
| 容量/补偿     | PK/FK 优先，不将正文/JSON INCLUDE 到索引。新增方向索引仅凭真实执行计划证明缺口才提案；已有索引默认不删不复制。新派生表可重建无需业务补偿，backfill 需限额与 WAL/锁预算。                                                                                                                                                                                                                                        |
| 日志          | Pino `{err}`，phase、attempt、elapsed、page_turn_count、has_more、metadata_missing_count、fallback_used、read_model_version 及已有链路上下文；不记录正文/history/SQL文本/凭据。轮数可由现有 session.message_count 派生粗 bucket，但注明它是可见消息计数近似，不能当真实 turn 总数或重新 COUNT。                                                                                                                 |

## 验证与性能判定

1. 复用 `scripts/test-conversation-branches-migration.sh` 的隔离 PG17、实际 migration 与分支/编辑/点赞 SQL 场景。风险评估确认本项需要 SQL 等价性/权限/并发回归及性能矩阵；优先扩展已有 harness，确实需要时允许最小专项 SQL fixture。真实 TEST 结构需另核，不能使用当前可见其他项目替代。
2. 虚构数据组合：10/100/1000/10000 轮，1/多 revision，大 prompt（控制 1KiB/100KiB/1MiB 档）、有/无窗口泄洪、普通/继承/自有遮蔽/全页删除；先做独立维度对照再做最坏组合。每组至少 100 次查询，记录 warm/cold 条件及硬件，运行 `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` 仅限隔离本地或另行授权测试环境，不在生产业务行上压测。
3. 首屏和深翻页均验证：K=25、上限 K=100、sentinel、最大 revision、缺页/重复、最早页开场白；旧/新读法逐 DTO 等价。检查宽 JSON 表达式/供应商 JOIN 没进入新热路径；看实际扫描行、sort spill、buffer/TOAST、SQL及整条读取耗时，不只看返回行数。
4. 工程目标（尚未实测）：固定 K/正文/revision 分布的 10000 轮相对 100 轮 SQL P95 增幅<=2倍，且长会话展示 SQL P95<=200ms；本地 HTTP GET P95<=500ms、受控压测无5秒超时。若不达标先看计划，再决定索引方向/键选择形状，不加 timeout 遮盖。高修订/大量遮蔽另报告，不虚称严格常数复杂度。
5. 旧数据覆盖、投影 NULL、placeholder→full、旧 writer、backfill 与新写并发、锁超时/重复批次、级联删除、RPC 非本人/软删除/anon/authenticated、metadata 写失败原写回滚、缺 migration、总deadline/取消/双失败必须覆盖。发送/重生成/取消/免费额度及生成结算既有测试必须复跑，派生 trigger 不得破坏原事实写入。
6. 前端在已有 `@chat/@roleplay` 场景加入长历史、多次加载更早、最早页开场白、翻页失败重试、切会话旧响应、重生成/编辑/删除/点赞后刷新，以及 loading/error/empty。不引入一次性 mock 服务。此项已列入本地验收系统计划；模拟不能证明 PostgreSQL 性能、真实 Telegram 键盘或供应商/计费。
7. Android/iOS 分别记录 `/chat/:id` SPA/冷启动、初页/深页、普通/长会话 cohort 的 page ready、客户端成功 API、后端/DB P95、N、timeout/error/stall、fallback 与写入耗时。现无长会话或分平台 DB/API 基线，必须 NULL。沿用页面<=2000ms、客户端 API<=2000ms工程目标；后端总体 P95<=500ms（本次实测口径438.66ms），DB目标200ms。总体目标不能代替长会话分桶结果。
8. 发布后同 release 至少24h，每平台/路由/cohort >=100成功前台样本才判断稳态；不足标低样本且延长观察。任何越权/正文还原/投影不一致立即停止；持续15分钟超时率或读/生成写P95较同口径基线恶化>20%、重试率>5%、锁等待/WAL超过预先记录预算，停止回填/rollout并恢复。不能删失败样本制造P95改善。

## 最小充分性

新增内容限制为一个小派生表、同事务提取函数/trigger、一个只读分页 RPC、repository 专用抽取与必要回归/迁移。公开 DTO/路由、UI、模型上下文和计费保持原语义。拒绝 Redis/物化全会话/当前版本指针表/分区/归档旧消息/持久聊天缓存/全历史预加载/自动扩容或自动增加重试；它们没有当前证据支持且扩大一致性或恢复成本。

## 用户确认的硬性验收（2026-11-11）

PRD R10/AC17-20为权威验收要求：页面打开速度不退化、完整历史无缺失、阅读/操作体验不退化、正常回复和既有功能不回退。完整指现有权限/删除/重生成规则下的全部可见记录，不额外公开旧revision或恢复删除内容；现有分页的总可查看记录数不设新上限。

- **完整性证据**：静止合成数据集遍历到最后一页，比较权威预期与新结果的ID/role/revision/顺序/完整正文/状态/开场白/展示版本，缺失、重复、截断、串会话为0。预期由事实与业务规则建立，不能只依赖旧读法以免复刻旧缺陷。并发变更单列场景，刷新后应收敛；不声称跨多次HTTP分页天然具有同一数据库快照。
- **性能证据**：同设备/平台/网络/缓存与数据的前后对照，page ready/首次真实历史可见/API P50、P95及生成准备/首个可见回复/history写P95不得高于各自旧版基线；独立目标仍有效。普通负载、翻页同时生成、回填同时生成分别验证，缺失基线保持NULL，不能用旧混合release服务端P95证明客户端不退化。
- **体验/功能证据**：@chat/@roleplay扩展连续翻页与滚动锚点、失败保留/重试、切会话隔离、草稿与键盘、流式滚动；复跑发送/思考/取消/重生成/分支/编辑/删除/点赞/媒体/后处理/会话管理/身份/账务的适用既有检查。正常发送不得等待全量历史或回填，不新增用户迁移操作。
- **切换判定**：任一硬门槛未验证或未通过，不得宣称优化完成；确认性能/功能退化或记录不一致则停止切换/回填并保留或恢复旧读法。前文20%阈值只是辅助告警，不是允许退化区间；投影可重建也不意味着允许新增trigger导致正常回复失败。
