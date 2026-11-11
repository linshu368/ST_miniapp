# B3设计复核与替代方案（2026-11-11，未实施）

> 已由用户要求的[合并设计](history-combined-design.md)收敛并替代本文实施建议：同时完成分页选键、完整展示投影、真实原子writer、轻量失效及旧数据回填。本文保留当时证据和方案对照，不再按原解析trigger或先只读后决定补投影的顺序实施。AC14含最早页无prompt提取，R10硬门槛不变。

## 结论

原设计的两个方向正确：让展示读取不依赖大型prompt；在读取正文/overlay之前确定该页逻辑turn。但它**尚未证明能解决现有全部超时，也不是当前证据下的最小充分方案**。推荐先验证复用既有请求身份的只读方案，再按基准决定是否增加展示投影；暂不把“新表+解析trigger”作为必须实施项。用户R10/AC17-20的完整记录、打开/回复性能与体验约束不放宽。

本次补充查阅当前运行调用链，以及已确认production `wbtsfzozlmurljvglhpn` 的pg_catalog：`chat_generation_requests`列/约束/索引、`begin_chat_generation_observation`函数体、chat_history触发器定义和统计函数体。全部为结构只读，无业务行、性能压测或远端写入。

## 关键发现

| 优先级 | 发现                                                                                                                                                                                                                                        | 对原设计的影响                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1     | 真实生产writer并非只靠setPromptHistory：generate.ts先登记observation，turn-execution.ts在dispatch前再次调用begin；GenerationObservationRepository.begin最终调用已有begin_chat_generation_observation，原子保存history、请求身份和冻结报价。 | 不能只改旧repository方法就声称覆盖生成路径。原“Backend没有小型request身份”的复用调研不完整，应补查已有事实，而非先复制一份。                                                              |
| P1     | production已有experience.chat_generation_requests(chat_history_id PK/FK, client_request_id uuid NOT NULL)，RLS开启。已有原子RPC验证同一history/request身份，重放不会用占位prompt覆盖完整prompt。                                            | 很多版本可从已有PK关联取得request身份，避免为这个字段新建全量投影。只读关联不能修改原观测/计费事实；旧数据覆盖率仍未知。                                                                  |
| P1     | 原解析trigger会在history写入事务中取JSON元素并upsert附表。该写入发生在供应商dispatch之前。                                                                                                                                                  | 它减少页面读成本，却增加回复准备阶段的数据库工作、锁与失败点；不能凭“写一次读多次”保证首字不退化。优先使用已有输入/原子RPC，避免再读大history提取。                                       |
| P1     | 现有GET的recoverStaleStreaming仍select(TURN_COLUMNS)，其中含完整history；getContextBeforeTurn仍为窗口内多行取history head；findCurrentTurnById用于取消轮询；finalizeTurn/requireTurnById仍可返回完整history。                               | 即使listMessages优化成功，其他读路径仍可能产生快照读取或传输。不能把“展示fast path完成”写成“聊天所有解压与超时均解决”。先分阶段记录耗时和检查真实consumer。                               |
| P1     | 已确认production的trg_refresh_chat_session_stats_from_history在INSERT或UPDATE assistant_reply/status时执行，对整个session_chat_history聚合消息数及preview。                                                                                 | 这是另一条可能随会话长度增长的写路径；会影响正常完成及陈旧恢复。需要作为独立候选瓶颈观测，不宜同时重写计数一致性。仅知道函数定义，不等于它已被证明慢。                                    |
| P2     | “先分页再取正文”目前是文字描述；DISTINCT/GROUP BY/UNION可能仍在LIMIT之前扫描许多turn/revision或继承候选。                                                                                                                                   | 必须用实际计划证明索引范围、逻辑turn选择、局部/全局LIMIT、hydration行数。写了RPC或CTE并不自动有界；不是简单limit K+1条revision。                                                          |
| P2     | 原回填每批100行、缺口用新migration文件推进；没有真实容量。                                                                                                                                                                                  | 100行是事务/工作预算，不应直接推导为每100行永久新增一个文件。先确定有限总范围与真实总量，再按有限文件/事务组织；不能用长事务循环或force_rerun绕过账本，也不应为一个优化先建常驻回填系统。 |
| P2     | 原设计强调“不UPDATE history以避免统计”，但这不足以排除主表追加少量标量。production真实统计trigger只关注assistant_reply/status。                                                                                                             | 仅更新新增metadata列不会因该trigger触发统计，不能把所有主表UPDATE都当作统计重算。仍需评估行更新/WAL/锁、其他trigger及权限。                                                               |

## 原方案能解决什么

1. **已覆盖版本的展示解压**：若最终SQL确实不读取history、CASE fallback未执行，原方案能从这条展示路径移除prompt的读取/detoast，而不是只减少响应大小。用户消息/回复正文原有压缩读取仍可能发生，这是显示完整正文所需成本。
2. **历史查询扫描**：键选择确实走索引且先于正文/关联，能减少宽行处理；不能由返回25轮推导为仅扫描25轮。最大revision、分支遮蔽必须先按语义正确处理，不能以丢记录换更小扫描量。
3. **旧会话**：缺投影fallback仍读旧history，回填完成前并未消除这部分解压。原“解压已经解决”的结论必须限定cohort、页类型和fallback覆盖。
4. **5秒故障**：已有事件只证明listMessages数据库访问链路中止，没有SQL/排队/网络/解压占比。任何方案都不能在无执行计划与对照实验时承诺消除全部超时。

## 推荐：按证据推进的两阶段设计

### 阶段一：优先只改读取，复用已有数据

- 保留原HTTP/DTO、页面分页数量、全历史可访问性和生成写入流程。
- 维持一个内部只读分页边界：owner校验 → 仅索引键选逻辑turn/最大revision/冻结继承 → 最终K+1候选 → 只对该页取正文、overlay/likes及所需request身份。保留has_more的逻辑轮次语义，不能因缺身份行把主消息INNER JOIN掉。
- 已有请求身份通过`chat_generation_requests.chat_history_id = selected_history_id`的PK **LEFT JOIN**读取，且仅作为read-only事实复用；继承消息仍不公开source request_id。不给此表创建虚假“历史观测”，不回填缺失的模式/计费/时间事实来满足JOIN。
- 开场白只在`has_more=false`且确实需要它的最早页，读取与旧算法相同的最早有效候选history前两项，至多一个实际history ID；空会话沿用角色版本firstMes fallback。普通首屏/中间页不为不会显示的opening解析25份快照。
- 请求身份缺失的旧行不能丢request_id或猜测“没有”。仅最终页缺失的非继承ID做同语句条件legacy head fallback，K+1有界；能从单次head提取复用的值不重复读取。完整性优先，不将失败/缺投影视作无更多。
- 本阶段不能承诺所有页都零history：最早页的opening，以及不满足兼容的旧行仍有明确残余成本。分别测身份表覆盖/缺口、最早页开场白与普通页，达到用户性能硬门槛才考虑它是足够方案。

**请求身份复用的强制兼容门禁**：client_request_id是uuid，原history内request_id是text；前端多处按字符串严格相等匹配。UUID大小写/规范化、历史任意string、placeholder→full、终态回收、重放和观测数据生命周期都必须验证，不能直接`uuid::text`替换后声称DTO逐字等价。如果现有身份表不能保留当前客户端所需的精确值，继续legacy读取或进入阶段二，禁止放宽原校验/擅自改全局request_id语义。覆盖率未知时不声称已覆盖所有历史。

选键实现比较现有索引上的streaming group/每turn最大revision查找等专用SQL；最终页键可使用有证据支持的`MATERIALIZED`边界，避免昂贵投影被提前计算。只能materialize有界窄键，不能materialize整个session宽视图。具体取舍由PG17计划决定，不能强行关闭planner或盲加方向索引。

### 阶段二：只有残余成本或兼容缺口阻止验收，才增加小型投影

优先比较以下两种，而不是直接落实原解析trigger：

| 候选                                                                                  | 收益                                                                                      | 代价与准入条件                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 在原chat_history追加少量nullable展示标量，随现有原子history写入一起保存               | 不增加附表JOIN/upsert；新写使用已持有的request/input与首两元素，不从存量大history重新解压 | 需原表ACL/RLS与锁/WAL审核、精确空值/缺投影标记、旧writer覆盖与失效设计；不能只改无人调用的setPromptHistory；必须处理真实admission RPC及其重放guard             |
| 保留原小型附表，但由既有begin_chat_generation_observation在同一事务按实际生效输入维护 | 维持独立权限；避免新history解析trigger及新HTTP往返                                        | 仍增加一次附表写入，必须验证准备/首字P95；只能依据真正接受的snapshot更新，初始登记重放不能擦掉完整opening；支持的旧writer矩阵必须完整，否则需显式失效/fallback |

两者均复用已构造的小输入，不把首两个完整JSON对象复制成另一份大system快照。新增字段/投影仍须域/权限/事务/有限回填/回退设计审核；不预设必须建表或必须加trigger。旧generation writer存在不能同步投影的分支时，需要明确受支持版本及stale失效方案，不能仅用“缺行fallback”掩盖已存在但过期的投影。

原新表+解析trigger保留为兼容多个实际writer时的备选，只有证明统一原子writer无法覆盖且额外准备延迟满足硬门槛才采用。无需为假设中的writer提前部署它。

## 必须补充的观测与停止条件

- GET各阶段：owner/settings、recover、character opening RPC、page key selection、identity/legacy/opening、组装/序列化；成功与失败都留耗时。PostgREST总耗时不能直接算作SQL/detoast。
- 生成侧只先观测已存在阶段：admission、context、dispatch freeze、terminal write/session stats、取消单轮读取；不借本次评审直接改生成/计费状态机。
- 读取对照须先用真实SQL而不是纯js微基准；原表普通列/一项JSON/两项JSON/完整快照/复用身份、原宽视图与新键选择分开测。保留全部页的等价校验、Unicode开场白、UUID大小写、旧任意request字符串、继承与删除、并发重放场景。
- 当前无Docker/psql，未运行隔离PG17实验；生产也未执行EXPLAIN或读取业务行。新发现是复用与故障模型证据，不是新的性能结论。原零缺失及新旧性能不退化门槛继续有效，不能用阶段一“通常更快”代替验收。

## 最终选择门禁

阶段一若在现代/旧会话、最早页/深页均满足用户硬指标，停止增加组件；若剩余旧快照成本仍不合格，再选择阶段二。需要独立权限时优先受限小表+现有原子writer；原表权限/写入兼容具备条件且成本更低时可选同表标量。无论哪种，都不能省略只读选键的计划验证或把模型上下文窗口当UI记录上限。原B3.2/3的强制对象清单应在本复核与基准后收敛，不能直接按旧文字实施。

本复核是替代设计提案，尚未代替PRD所有技术验收。阶段一最早页仍可能读取一份prompt，与AC14原“覆盖路径不读history”的绝对表述存在差异；最终规划必须明确该边界及对应验收，或进入阶段二达到原目标，不能悄悄降低AC14。用户R10/AC17-20零缺失、不退化等硬指标没有此例外，也不因候选方案更简单而放宽。当前仍为planning。

官方依据：[PG17 TOAST](https://www.postgresql.org/docs/17/storage-toast.html)、[LIMIT/排序与索引](https://www.postgresql.org/docs/17/indexes-ordering.html)、[CTE物化规则](https://www.postgresql.org/docs/17/queries-with.html)、[列级trigger触发条件](https://www.postgresql.org/docs/17/sql-createtrigger.html)。这些支持机制判断，不证明实际生产耗时占比。
