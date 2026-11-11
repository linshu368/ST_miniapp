# B3 合并设计：分页选键与展示元数据分离

2026-11-11，按用户“两个方案结合、避免后续整改”的要求收敛。本文是 B3 的实施设计依据，替代 history-read-performance.md 的原解析 trigger 方案及 history-design-review.md 的“只读优化后再决定是否补投影”顺序；两文保留调查证据。用户随后已批准实施，本地代码和 PG17 实验见 [验收记录](implementation-validation.md)；未执行远端迁移或生产发布。

## 1. 一次设计完整，按兼容顺序交付

同时实施两项：先用窄键确定当前页逻辑轮次和实际 revision，再读取该页正文及小型展示元数据。开场白也进入投影，最终包括最早页在内的展示读取不再为 request_id/opening 解压 prompt。旧数据回填属于本次交付，不能把“新会话快了，旧会话仍慢”当完成。

复用现有请求身份表和原子 admission RPC，但不直接把 uuid 转字符串取代历史 request_id。独立小表只保存精确展示值，不另造请求/生成/计费状态源。现有 chat_generation_requests 继续是请求身份事实；展示表是原 history 展示语义的可重建派生物。

这能同时覆盖两类已知候选成本，不是保证所有 5 秒故障都消失。网络/连接池、陈旧恢复、上下文读取及终态统计仍需端到端定位。用户 R10/AC17-20 的完整性、速度、体验和正常回复硬门槛不降低。

## 2. 复用与对象边界

| 对象/能力                                               | 合并后的用途                                                                                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 现有 session/turn/revision、branch、override、like 索引 | 默认复用，先验证选键计划；无证据不加重复索引                                                                                                         |
| experience.chat_generation_requests                     | 复用身份关联、幂等校验及既有生命周期；不得为旧数据伪造 observation。uuid 身份与原展示 text 分别校验                                                  |
| begin_chat_generation_observation                       | 在实际接受 history 的同一事务内维护投影；保留原身份、冻结报价、重放 guard 和业务返回语义                                                             |
| experience.chat_history_display_metadata（新增）        | history_id PK/FK ON DELETE CASCADE、request_id text NULL、opening_message text NULL、projection_version smallint。一个实际 history revision 对应一行 |
| 内部 list_chat_message_page（新增）                     | 服务端只读、单语句分页，不增加公开 HTTP 接口或改变共享 DTO                                                                                           |
| 小型失效 trigger/function（新增）                       | 仅在 UPDATE OF history 时将既有投影标记失效，不访问 OLD/NEW.history 内容、不比较 JSON、不解析快照                                                    |
| 现有 PG17 harness、@chat/@roleplay                      | 扩展完整性、并发、失败恢复和性能验收；不创建另一套 mock 系统                                                                                         |

新对象均归 experience。权威消息、prompt、revision、账务和请求事实仍留原表；投影不参与计费决策，无独立运营生命周期。消费方是 Backend 历史展示及经逐项证明只需要展示标量的内部读取。依赖既有同域 history/session/branch/overlay/like/request；沿用用户/角色归属约束，不新增跨域写入。

选择独立小表而非给原表加展示列，是为了隔离已发现的原表 RLS/ACL 差异，并避免改所有宽视图消费者。不是声称原表更新必然触发统计；已核对统计 trigger 只监听 INSERT 或 assistant_reply/status 更新。小表新增写成本必须实测，独立权限不是性能免责理由。

## 3. 写路径：用已经接受的输入，不重新读取存量快照

当前真实入口为 GenerationObservationRepository.begin → begin_chat_generation_observation，既有初始登记和 dispatch 前冻结两个调用点。不能只修改当前未被运行链路调用的 setPromptHistory。

1. 保留原 RPC 参数及校验。仅在原 guard 确认本次 history 实际生效的分支，从已持有的有效输入按现有提取器语义计算 request_id 与 opening_message，再与 history 同事务写投影。不能由客户端传入未经约束的独立展示值作为权威事实。
2. 不 SELECT 已存储 history 重新提取；不复制前两个完整 JSON 对象/system 正文。输入 JSON 解析和存储本身仍有成本，不能宣称所有生成侧解压/CPU 为零。新投影只保存展示必需的完整字符串，开场白很长时也不能截断。
3. 初始 placeholder → 完整 prompt 可更新投影；已冻结 prompt 后重放初始登记不得擦除完整 opening。空值表示已计算的 NULL，不能被误当成未计算。原 RPC 拒绝、回滚或未接受新 history 时，不能提前写出对应的新投影。
4. 保留 request_id 原字符串与原 trim/类型/缺失语义。现有 uuid 事实用于身份一致性验证，不能把大写 UUID、历史任意字符串或缺失 identity 行改写成另一种展示值。继承消息仍不公开源 request_id。不新建第二套 identity 状态机。
5. 投影写失败使本次原子事务回滚，沿用现有 generation 错误恢复，不吞错继续生成。所有原 RPC grant、owner、search_path、幂等和冻结报价语义保持；禁止为了写小表给浏览器或服务端扩大任意表写权限。

### 旧 writer 与过期投影

仅“缺投影 fallback”不足以防止已有投影过期，因此保留一个只做失效标记的 trigger：

- UPDATE OF history 无条件使该 history_id 已有投影的 projection_version=0；不读取/比较 JSON，即使同值更新也保守失效。没有投影行则不创建。INSERT 默认缺投影，原子 writer 随后建立；DELETE 由 FK 清理。
- 支持的新原子 writer 先按原逻辑锁/更新 history，触发失效，再在同事务写 version=1。读者只看到提交前或提交后的完整状态，不会看到事务中间的失效状态。
- 旧 Backend/维护代码只写 history 时，提交后 version=0，读路径使用准确的有界旧提取，不能返回旧 request_id/opening。不以静默接受过期数据换速度，也不强迫旧 writer 新增网络请求。
- UPDATE status/assistant_reply 等未涉及 history 的路径不触发失效。禁止 trigger 写回 history 引发递归；不使用每次 GET hash 全量 prompt 判断新鲜度。
- 失效 trigger 仍可能新增一次索引查找及标记写；随后 upsert 也有成本。锁顺序统一为原 history 行再投影，必须审查原 RPC 其余锁顺序，覆盖死锁、热点及 WAL；不得先声称对首字无影响。

发布前列出所有实际 writer：真实 admission RPC、setPromptHistory/旧 Backend、导入/维护/回填、其他数据库函数。支持的普通写入由数据库失效机制兜住；禁用 trigger 的 restore/超级用户维护不在自动一致性保证内，维护后必须重建并验证后才能启用新读取。旧 writer 的持续流量会让 coverage 回退，属于发布阻断项，不能把一次回填完成当永久覆盖。

## 4. 读路径：同一快照先选页，再读取该页

流程：原鉴权与 owner/recover 顺序 → 内部只读 SQL 的窄键选择 → 当前页正文/投影/overlay/likes → 原 DTO、active-delivery/placeholder。

- 按原 cursor、session、用户/角色和继承遮蔽规则选逻辑 turn，再取最大 revision；禁止先 LIMIT 原始 revision 再去重。自有候选与冻结继承各自过滤后限额，再合并取 K+1。
- 页面 K 维持默认 25 轮/上限 100 轮；sentinel 保持原 has_more 语义，不能因投影缺失、正文删除或展示后消息数少而提前结束。最大 revision、删除/编辑、继承冻结和点赞规则不变。
- 最终最多 K+1 个实际 ID 才关联小投影和必要正文，不经过 provider 宽视图；昂贵表达式不能被提前到全会话。仅在计划证明有效时物化有界窄键，不物化整份 session。
- version=1 的投影即使字段 NULL 也不读 history。缺行/失效/不支持的版本才在同语句对选中缺口做有界兼容提取，最多 K+1 个 ID；不逐条 HTTP、不 GET 写回、不重取全会话。正确区分结构缺失/权限错误与数据缺口：缺 migration 或 SQL 错误直接失败，不伪装成正常 fallback。
- 最早页开场白从与旧算法相同的实际候选 history_id 投影中取得；空会话保留角色版本 firstMes 行为。首屏、中间页、最早页均不需要从已覆盖 history 解压。长开场白/消息正文自身的读取成本仍然存在。
- 单次分页有一致语句快照；多次 HTTP 翻页仍沿用现有并发刷新语义，不宣称形成跨请求数据库快照。静止数据集需遍历全部页验证零遗漏；并发新消息、重生成、编辑/删除需验证刷新收敛。

最终上线版本是完整合并路径，不把“最早页还读一份 prompt”的只读阶段当最终设计。现有 identity 表的 JOIN 仅在当前 consumer 有实际需要时保留，不能为宣称复用而平白增加每页关联；复用重点在权威身份与原子写入。

## 5. 旧数据、权限、发布和恢复

顺序为 expand（小表、失效机制、兼容原 RPC、只读函数）→ 验证所有写者与原读法 → 有限回填和覆盖核验 → 验证全部硬门槛 → 灰度切换 Backend 读取。Frontend 无协议改造，不要求用户等待迁移，不全量预加载。

回填锁定有限原 history ID 后读取有效快照、写投影，与正常 writer 同顺序。锁忙跳过；必须保留跳过范围和重访清单，不能 cursor 前移后永久遗忘。不能先读旧值再无条件覆盖新投影。无论批次重放、并发新写或删除，均以当前原行和事务为准。

起始每事务最多 100 行、statement_timeout 3 秒、lock_timeout 500ms，容量不足则缩批。这是工作预算，不是“每 100 行永久新建一个 migration 文件”。先确认受控范围和容量，再将有限批次安排到遵循仓库 migration 账本/逐文件 workflow 的有限文件与事务中；禁止长事务循环、改历史文件、滥用 force_rerun 或新建常驻回填平台。不能实现安全事务边界时暂停回填编排，不扩大预算绕过。

回填不 UPDATE history，不触发原消息统计/奖励。原始快照保留；投影随 history 删除。历史覆盖核验不采集正文到日志或 Git。当前 MCP 权限仍只允许已确认环境的结构采集；生产容量/覆盖检查应由符合项目规则的后续发布流程获得，不能直接用 MCP 查询业务行。

新表开启 RLS、撤销 PUBLIC/anon/authenticated 默认权限。原 admission RPC 是 SECURITY INVOKER，保持其安全模式，因此 Backend service 需要投影表 SELECT/INSERT/UPDATE，不授予 DELETE；并非仅 SELECT。失效维护函数固定 search_path、最小 owner 权限且撤销外部 EXECUTE。分页 RPC invoker，校验 owner/软删除并限制调用角色。现有原表 RLS/ACL GAP 需要独立记录和发布前核对，不能在本优化中悄悄改变旧客户端权限。

完成标准包含新旧可见历史、普通页/深页/最早页的有效覆盖，发布 cohort fallback=0；未覆盖范围明确属于未完成兼容态，不能宣称整个优化已完成。已知 NULL 是覆盖，失效不是。兼容读取保证数据正确性，但不能保证未回填旧数据没有解压成本。

回退新读路径时保留原 history、旧视图与既有业务状态，不删除消息/账务。若只是读路径异常，恢复旧 Backend 读取并停止回填。若是新原子写/失效机制拖慢或导致失败，仅回退 Backend 不够：还需按已演练的数据库恢复文件撤回新增维护分支/失效 trigger，并让所有消费者退回旧读法。保留小表供排障但标记不可用，后续重建验证后再启用。数据库函数恢复以本次变更前已验证定义为依据，不覆盖其他人的后续变更。

## 6. 同时排查相关成本，避免漏掉整个 GET 链路

| 路径                                                   | 本次处理及边界                                                                                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| listMessages                                           | 必须完成上述选键+投影、全页覆盖及计划验证                                                                                                                        |
| recoverStaleStreaming / requireTurnById / finalizeTurn | 逐个检查真实 consumer；只需状态/账务标量的分支使用专用最小列，禁止为获取小字段读取完整 history。确实消费完整快照的分支保留并单独测量，不改恢复/结算语义          |
| findCurrentTurnById / 首字前取消轮询                   | 核对精确 request 字符串；可复用同一有效投影，兼容缺口和继承规则，不创建第二份缓存。不能改变取消幂等或终态匹配                                                    |
| getContextBeforeTurn                                   | 列出每个返回字段真实用途；若只为 request/opening 读 history，可复用同一投影。模型真正需要的上下文和窗口不裁剪，UI 全历史不受窗口限制                             |
| admission / dispatch freeze                            | 分开测原输入解析、原落库与新增失效/投影成本；首字前准备 P95 不允许退化                                                                                           |
| terminal write / session stats                         | 已发现整会话统计 trigger，单独测随轮数增长的成本。未证明慢不重写计数；若导致 GET 恢复或正常回复不达标，作为本次交付阻断缺口处理，不能把“list 更快”当全部问题关闭 |
| 连接/网络/组装                                         | 分离获取连接/请求总时长、SQL、序列化等可见阶段。没有数据库细分证据的 PostgREST 时长只能标总耗时，不能全部称 detoast                                              |

移除其他路径的大字段前需完成 consumer 清单和现有回归；无法证明只需标量的分支保持原行为并明确剩余成本。此设计不预先重写计费、生成或统计状态机。观测成功和失败，记录 phase/elapsed/attempt/投影缺口及版本等摘要，不记录正文、prompt、request 字符串、密钥或高基数用户标签。

## 7. 验收与停止条件

1. PG17 对照普通列、JSON 单/双元素、完整快照、只读身份复用、合并投影；10/100/1000/10000 轮，prompt 大小/压缩率、revision、继承、编辑/删除分维度。复用原 512MiB 合成容量预算，不在生产压测。
2. 计划证据确认窄键范围和 hydration 上界，不只看返回行数。有效投影时包括最早页均无 history JSON 提取，改变 prompt 大小不应导致该展示路径 TOAST 成本增长；需区分正文自身 TOAST 和邻接页缓存影响。
3. 完整分页与事实推导序列逐项等价，缺失/重复/截断/串会话为 0；NULL、Unicode trim、UUID 大小写/旧字符串、缺 identity、继承、空会话、全页删除均覆盖。
4. 并发及恢复：placeholder→full→初始重放、旧 writer 修改已有有效投影、同值 history 更新、backfill 与 writer 交错、跳过锁后重访、失败回滚、硬删除、缺 migration、越权、数据库写恢复，均纳入现有 harness。
5. 原 SQL P95<=200ms、本地 GET<=500ms、10000 对 100 轮 P95<=2 倍目标不变；Android/iOS 页面/客户端目标及 R10 更严格的新旧不退化验收同时满足。首次真实历史可见、普通发送/并发翻页/回填下准备与首字/写入分别比较，缺基线为 NULL，不能以整体 P95 或 UI stub 替代。
6. @chat/@roleplay 本地验收覆盖连续翻页、滚动锚点、失败保留、重试、切会话、草稿/键盘/流式及既有发送/取消/重生成/分支/编辑/删除/点赞/媒体/后处理/会话管理/账务。真实移动端和供应商时延仍需相应环境验证。
7. 任一硬门槛未验证不能切换；确认记录/功能/性能退化即停止灰度与回填，按受影响的读或写路径恢复，不接受 20% 退化容忍。覆盖回退或相关慢路径仍造成 5 秒故障时不能宣布完成。

本机此前无 Docker/psql，实施时已用临时 PostgreSQL 17.11 完成部分隔离基准和恢复演练，详见验收记录。完整成对不退化、正式环境容量/覆盖及统计成本仍需验证；不把待验证项写成已解决。
