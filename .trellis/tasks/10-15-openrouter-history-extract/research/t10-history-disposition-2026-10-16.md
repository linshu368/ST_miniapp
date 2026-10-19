# T10 历史处置与主表 contract 验证（2026-10-16）

## 授权及结论边界

用户要求直接进行历史数据处置方案与相应迁移验证，并明确PR425作废、不作为本轮阻挡。只读远端聚合和本地实现/验证已进行；未远端UPDATE/DDL、补账、停止环境、创建PR、提交或推送。继续同一Trellis任务，指定无关文件保持。

方案可以解除TEST原历史守卫的误判，但没有声称实际JSON已清空或主表已删列。新SQL需要最终审阅、推送后才可由用户逐文件执行。非白名单历史诊断明确丢弃且不归档，这是远端执行前必须审阅的数据损失边界；正文、业务终态和账务不丢弃。

## 只读TEST分类

目标ref zoqelpfhurwehlvypryl，development；PR431合并/新部署5ed1e217的对话落表证据沿用前轮实时核验，不能代替本轮处置执行证据。

- 主表旧JSON1797条，全部为对象：OR1792、Venice5，已有各自detail，raw ID与专表冲突0。
- 根键包含external_user、http_referer、provider_responses、user_agent等额外字段；只统计键名/计数，未输出字段值。不能整份搬迁。OR表已有49条非白名单诊断，也需规范化。
- 白名单OR上游finish_reason有1542处可补NULL；usage/provider/model无该类缺口。不使用主表业务finish_reason填上游原因。Venice合法白名单原名事实缺口0，不写其明细。
- 主表旧JSON与已有OR诊断并集1806个parent，低于2000预算；OR诊断对象形状/ID/512长度预检异常均0。
- 1281条charge存在但snapshot/settled_at为空的历史：1268已有终态charge或持久dedup；11为无charge/dedup的upstream_error/stream_interrupted；2是真实pending charge+dedup。其中535条有关联quota（521 consumed、14 released），reserved为0。账务用户/调用ID冲突均0。
- `20260911_chat_history_billing_settlement.sql`明确“不回填存量”。TEST实际ledger applied_at为2026-09-14 11:04:05.170 UTC；该1281集合均在边界前且无snapshot。新账务守卫以纯SELECT复算blockers=0。NULL settled_at不能覆盖原账单/dedup事实，也不应为通过DDL伪造结算。

上述是快照，不保证执行时无新流量/依赖变化。两条旧pending仍pending，超24h按原策略停止自动回捞并待独立账务核验；保留原charge_key、原定价账单/metadata、dedup与专表调用ID，禁止重新定价、重发上游或补扣。

## migration 与数据策略

### 1. 新增历史处置

`packages/shared/migrations/20261016_openrouter_history_disposition.sql`

- 先LIMIT2001取候选ID，超过2000立即停止，再读取/指纹TOAST，避免生产大表先遍历原JSON。
- 验JSON对象、唯一provider、snapshot provider、主表/专表/诊断调用ID；不猜provider，不造ID。未知或冲突整笔回滚。
- pg_temp临时白名单函数与当前mapper对齐：id/provider_name/finish_reason/model为最多512字符串；usage/usage_cache/4个native_tokens/latency/generation_time为合法非负数、token整数且int范围内；error只留数值code或空对象。超长字符串拒绝，非法数值不作为调用事实。无cache_discount字段、无原文归档。
- 仅补OR NULL canonical；既有canonical和已有诊断事实优先，已有诊断自身也按白名单规范化。父表raw与专表诊断指纹CAS防变化，变化整笔回滚；最后清父表旧JSON。未知key/自由文本错误明确丢弃，不盲搬原JSON。
- Venice不写明细；其白名单事实若未保全则拒绝。正文/history/status/业务finish、charge/金额/settled_at/snapshot、billing所有账务/额度对象均不写。
- 独立事务，5s锁/60s语句预算；临时表ON COMMIT DROP、临时函数显式删除，无永久新对象/归档层/worker。

### 2. 修正尚未执行的主表DROP

`packages/shared/migrations/20261016_chat_history_drop_provider_metadata.sql`

TEST直接账本与已确认Production的Supabase MCP只读治理查询均证明该文件未执行，因此允许修正未执行文件；任何已执行历史SQL均未改。

新增处置成功账本前置，以快照schema文件固定checksum+实际applied_at区分旧契约。对于关联待删旧字段或缺失detail的未结算记录，校验charge/dedup身份和状态、无reserved额度；旧终态/失败无账单/可追溯原pending分类保留，非空snapshot、边界后漏快照、未知成功、账务身份/状态冲突继续拒绝，SQL NULL逻辑显式fail closed。原pending不是已结算，原账务不改。无旧值且已有专表占位的健康新streaming（含reserved额度）仍可并行，不要求暂停正常对话。

既有12列shape、7个业务保留列、DB依赖/ID/安全标量、raw未处置守卫保持，仍DROP RESTRICT恰好12列。不是通过清空旧标量或伪造settled_at绕过守卫。

## 本地自动与真实DB验证

- Backend85 files/683 tests、Shared15 files/147 tests通过。
- pnpm -r typecheck、所有适用build（Frontend/Admin/CS）通过；Backend/Shared/Renderer无build脚本。Admin原有bundle提示。
- pnpm lint、lint:imports、lint:legacy、lint:migrations通过；新旧migration隔离PG回归及pnpm test:migration-ledger通过。
- 扩展既有bootstrap/shell harness，未创建测试文件。合成治理/billing表仅在隔离库，不是新增产品schema。
- PG17+PostgREST实际执行新处置、专表11别名DROP和主表12列DROP，真实repository正常输入/正文/上下文、ID CAS/回捞、计费恢复查询、cancel/late stop、Venice、view/latest revision/ACL仍通过。
- 覆盖旧JSON未知key/headers/嵌套response清除、error数值code保留、0/NULL及canonical新事实优先、既有OR诊断规范化、Venice不混写、原业务父行/charge/dedup/quota前后集合不变、旧pending与NULL settled_at保留。
- 拒绝：非对象/超长字符串、provider重叠/ID冲突、Venice未保全、2001预算、缺处置账本/旧schema账本checksum漂移、现代边界后漏快照、现代snapshot pending、未知旧成功、用户/状态冲突、关联reserved。与既有依赖/重复DROP等拒绝一起通过。
- 用合成BEFORE UPDATE触发器模拟父表JSON在最终清空时被竞争改写，迁移拒绝且整笔回滚；原JSON及已尝试填的OR字段仍保持原状。
- bash -n、Trellis jsonl/module payload、scoped formatting、git diff --check最终校验见审阅包。

没有声称真实钱包/上游/多副本故障注入已通过；已有三轮真实发送是独立用户反馈+落表核验。只读SELECT预检不等于实际执行migration。

## 执行顺序、Production与恢复

1. 确保选择包含T10修正的分支/最终SQL内容，先执行history_disposition，核对ledger/checksum、raw归零、OR诊断白名单、正文/终态/账务不变及锁/权限。
2. 再单独执行更新后的chat_history_drop_provider_metadata；核对恰好12列消失、业务字段保留、当前视图/专表ID/正常发送与回捞可用。

TEST已执行的前序七份文件不重跑。PR425按用户豁免，不再重复要求处理；不把此豁免外推到Production其他真实消费者。

Production本轮仅MCP读取已确认目标的治理账本，未读取业务行；快照schema checksum一致、两份T10文件未记账。业务候选/分类、外部消费者、锁/磁盘/WAL/复制预算仍未知；预期超2000会安全拒绝，必须另审Production有界批次方案，不改文件放大预算/force_rerun。只交付TEST可审阅验证，不宣称Production可直接执行。

删列后不能回退旧Backend；用两处无旧列验证过的canonical SHA或reviewed forward-fix。非白名单旧诊断按处置策略不可恢复，已保全原名/受控诊断可用；重加NULL列不是恢复，无VACUUM FULL/表重写。

## 最终文件SHA256

- 20261016_openrouter_history_disposition.sql: `944ad4c7dbe64e240eec9fe232bbb7a2e60650f1f5604dcd412279968921e7b0`
- 20261016_chat_history_drop_provider_metadata.sql: `d1b410064f06b63a40a9c15a9b8148e3e43cf3cfdbadaba198b60fcbd7766852`
