# OpenRouter 调用元数据拆表与主表清退

## 目标与阶段

T1–T4 交付专表、历史回填、厂商原名字段和 Backend 初步接入。2026-10-16 新增 T5–T8：完成消费者切换，交付独立删列 migration，并在隔离本地数据库真正删列后验证关键链路。兼容发布不等于整个清退任务完成。T3 未完的真实验收继续保留，不新建任务。

## 已确认背景

- 原分支 dev_openrouter_migrate，本地 HEAD 597df0e1；PR #424 已合入 dev（f7f79f43）。本轮实时核验 PR #429 仍 OPEN；Production Backend 为 c759f6de，development 为 50c121f4；执行前重查。
- TEST zoqelpfhurwehlvypryl、Production wbtsfzozlmurljvglhpn 的四份历史 migration 实时账本/checksum 均与本地一致，不能重跑/修改。Venice 实表存在但 20260929 文件未记账，只记录漂移。
- current_chat_history、Production base_chat_bj 和部分恢复代码仍依赖主表旧列。证据见 research/t5-retirement-audit-2026-10-16.md。

## 需求与边界

R1. 清退 experience.chat_history 恰好 12 列：llm_provider_name、llm_usage、llm_usage_cache、llm_native_tokens_cached、llm_native_tokens_reasoning、llm_native_tokens_completion、llm_native_tokens_prompt、llm_latency、llm_generation_time、llm_model、llm_generation_id、llm_generation_data。全量审计 Backend、类型/测试/Prisma、Shared/API、Frontend/Admin/CS、脚本及 DB 视图/函数/触发器/策略/索引/外部分析。

R2. 主表 llm_finish_reason 保持业务终态、取消/超时裁决、SSE 和计费闸门；专表 finish_reason 仅是上游原始结束原因，晚到 stop 不覆盖取消/超时。主表 model、llm_charge_id、llm_billing_snapshot、llm_billing_settled_at、llm_intended_deduction、deduction_rate 保留。

R3. OpenRouter 调用事实唯一来源为 `experience.openrouter_chat_history`：provider*name、finish_reason、usage、usage_cache、四个 `native_tokens*\*`、latency、generation*time、model；llm_generation_id/data 保持现名。不新增 cache_discount；按本次新增范围清理专表 11 个重复 llm*\* 别名（见 T9），不保存 prompt、正文、凭证或不受控 raw JSON，不盲迁历史 raw JSON。

R4. metadata 完整而 charge/quota/主表回写失败仍可恢复；占位/ID 写入失败、重启、多副本、重复回捞、超窗均有恢复或停止条件。各 provider 从各自专表提供调用 ID。保持 Venice 计费/额度语义，不引入通用 provider 框架，不重构 Venice mapper/表。

R5. current_chat_history 和已存在的 base_chat_bj 改取对应 provider 专表，保留输出字段、顺序、类型、基数、业务 finish reason 和角色访问能力。禁止 DROP CASCADE；权限最小化，不向浏览器角色开放明细。TEST 不存在 analytics view 时不新建生产报表体系。

R6. 有 ID 且无 Venice 明细的历史 parent 可归 OpenRouter，但必须先核对本环境冲突。无 ID/无明细历史单列，不伪造 ID/原始结束原因；TEST 的 165 条不代表 Production。按实际部署/流量核对窗口与旧副本退出。

R7. 新增 SQL 仅位于 shared migrations；应用无依赖、DB 内部无依赖、实际运行无旧列读写、历史和窗口覆盖四项同时通过后才单独 DROP。明确锁/容量/超时/停止条件及删列后 forward-fix，不承诺直接回退旧 Backend；不做 VACUUM FULL 或表重写，不把删列当即时空间回收。

## 验收标准

- [x] AC1 / R1–R3：运行时代码不从主表读写这 12 列，所有消费者分类审计完成；专表合法同名字段和冻结历史 SQL 不误删。
- [x] AC2 / R2、R4：回归覆盖发送/重生成、免费/付费、取消/超时/晚到 stop、上游错误/迟到 metadata、完整 metadata 未结算、占位/ID 失败、重启/多副本/重复恢复/计费幂等及 Venice。
- [x] AC3 / R5：本地 PostgreSQL 验证两个视图字段/类型/基数/NULL/0/最新 revision、provider 路由、owner/security_invoker/权限及负向拒绝。
- [x] AC4 / R6–R7：交付必要窗口补齐、视图切换和独立删列 SQL；隔离库真正 DROP 12 列后，真实 repository 关键读写/恢复查询/视图仍可运行，主表终态/计费列保留。mock 不替代此项。
- [x] AC5：本轮 Backend/Shared 测试、全消费者 typecheck、build、lint/import/legacy/migration、ledger 协议、diff 检查有结果；受限检查说明原因和风险。
- [x] AC6：同步 README、架构、spec、task 和发布清单；分别记录自动回归、用户反馈、真实 TEST/Production 验收，不把未知勾选为通过。
- [ ] AC7：远端 DROP 四类门禁有本环境证据及独立授权；本地完成不代表远端已清退。

## 授权与排除

允许本任务内调查、规划及规划审阅后的本地实现/验证。远端 migration、提交/推送、PR 创建/合并、部署均需另行授权；忽略 PR Review 自动化问题，其他适用 CI 必须通过。保留无关 Admin preview task 与 docs/后处理规则-实际应用问题汇总.md，不暂存或覆盖。

用户已授权更新规划后直接实施；T5–T8 本地实现/验证已完成，真实环境验收和远端 DROP 仍独立。结果见 research/t8-local-retirement-verification-2026-10-16.md。

## 2026-10-16 用户补充确认与实施授权

最高约束：本次改造不得影响正常发送、重生成、流式回复、取消/超时及对话正文/历史/终态/计费事实的正常落表。调用 metadata 与历史治理不得删除或改写对话正文；异常时保留已观察到的回复及原业务终态，不因诊断写入失败将已落表正文改为空。新增持久化接缝只保护恢复事实，须通过正常/失败落表回归与隔离库删列后真实 repository 验证。历史不明确记录阻断清理，不能影响新对话。

用户已明确授权：补齐下列两类处理规划后直接本地实现，无需再次规划审批。远端迁移/提交推送/PR/部署仍未授权。

- 41 条有 ID 缺 OpenRouter detail：旧 writer 退出后重新计数，核对无 Venice/归属冲突；新增 catch-up 只补安全标量与 ID，非空冲突停止，不复制 raw JSON/主表业务 finish reason。近窗回捞迟到 metadata，超窗保留已知事实；核对缺失与不一致归零，单独检查计费/额度。
- 12942 条无 ID/无 detail：不能据此认定没有可迁移 metadata。聚合分类为“可靠归属+安全字段可迁移（NULL ID）”“无调用事实且业务计费已收口”“计费/额度未收口”“归属/值冲突未知”。只迁可证明 OpenRouter 的安全标量，不能仅因无 Venice 就给无 ID 历史猜 provider；没有信息不伪造 ID。未收口沿原 charge_id/冻结快照/已确定业务原因恢复，信息不足停止自动处理并人工核验。全部分类、可迁移信息已保留且未知项获确认前禁止 DROP。两类数字都是旧快照，切换时重新计算；TEST 165 不替代 Production。

新增 migration 的分类守卫必须拒绝未保全的安全调用字段、不明确 provider、ID 冲突和未完成结算/额度；无法证明原始 JSON 可丢弃时阻断 DROP，由受控内容治理另审，不盲搬或静默删除。本地可用合成 fixture 验证拒绝路径，真实环境未知项不自动通过。

## T9 新增范围：OpenRouter 专表旧别名清退（已授权本地实施）

用户要求主表旧调用列与专表重复旧别名均清理，前述排除专表旧别名的范围现被本节取代。主表仍删既定 12 列；专表新增删 11 列：llm_provider_name、llm_finish_reason、llm_usage、llm_usage_cache、llm_native_tokens_cached、llm_native_tokens_reasoning、llm_native_tokens_completion、llm_native_tokens_prompt、llm_latency、llm_generation_time、llm_model。保留对应 11 个原名列；按此前明确命名约定保留专表 llm_generation_id、llm_generation_data，不将调用身份或受控诊断误当冗余别名删除。若要求这两列也去前缀，需要单独确认 rename 契约及先部署兼容 writer，不可直接 DROP。

- [x] AC8：本地物理删除主表 12 列和专表 11 别名后，生成落表、ID 持久化、metadata 回捞、计费恢复、取消/超时、Venice、视图及权限验证通过。
- [ ] AC9：专表旧别名的安全值缺口/冲突、DB 与所有共享环境消费者依赖均核对；原名未回捞为空不是调用失败，但旧别名中仅存的有效事实不能静默丢弃。

2026-10-16 PR430 只读核验：部署 272f144a / TEST；3 条新调用输入/回复/上下文/快照/结算齐全，专表 ID 齐全、主表 12 列为空；专表 usage/finish_reason 待回捞不算失败。TEST 两前序新 migration 账本/checksum 一致，主表列级依赖零，current 1307 行与预期一致。development 50c121f4、PR425 5856cc3 同连 TEST 且仍依赖主表旧列；旧 JSON 1797 条与历史结算守卫 1281 条（均无 snapshot）尚待分类，不将其自动判为业务失败。此为当次快照，执行前重查。

用户随后确认PR430已合并，授权按本规划继续本地实现，并在完成后提交推送；不开新Trellis任务。本轮远端迁移、其他环境升级/停止及新PR创建仍不自动执行。专表旧别名清理不等于主表历史JSON处置已获授权；主表DROP原守卫保留。

## T10 历史诊断处置与主表 contract 守卫（用户授权直接推进）

PR425已由用户明确判定作废并排除本轮门禁，不再要求处理该环境。用户授权本地形成处置方案和相应migration验证，未授权远端执行。

R8：旧主表JSON仅保留现有mapper允许的类型化调用标量和受控诊断白名单（id/provider_name/finish_reason/model、usage/usage_cache/四token/latency/generation_time、error数值code）；非白名单字段如external_user/http_referer/provider_responses等明确不归档、不复制，丢弃；保全后清空主表旧诊断列，为最终DROP准备。先验证provider/ID/shape，非空canonical优先、只补缺失，不把主表业务finish_reason当上游原因。无安全归属、ID冲突、非法JSON或超预算停止。

R9：按计费快照列实际引入前后区分历史与当前契约。无snapshot/无settled_at不能直接当未结算；终态账单/dedup、未产生账单的失败、真实pending分别分类。旧pending保留账单/去重/调用ID/metadata，不重新定价/扣款、不伪造settled_at；超24h停止自动恢复、待独立账务核验。新契约中仍关联待删旧字段/缺失detail的未完成结算或reserved额度继续阻断；纯专表的健康调用可并行，不以此放宽新故障恢复。

- [x] AC10：隔离库历史JSON安全保全/非白名单丢弃、事务回滚/预算/身份拒绝通过；不改正文/终态/计费事实，Venice不误写OpenRouter。
- [x] AC11：覆盖旧终态/留存dedup/失败无账单/真实pending与新契约缺快照、pending、reserved额度；删除主表后pending记录与幂等身份仍在，无补扣或假收口。

T10补充证据：TEST专表自身有49条非白名单诊断；同一历史处置同时按现有mapper白名单规范化已有OR诊断，当前诊断优先，父表raw与专表诊断使用指纹CAS，变化则整笔回滚。Venice明细仍不写，缺少有效原名事实会停止。候选为旧父表JSON或已有OR诊断的并集，总数超过2000停止，不先清空再核对。

## T11 Production catch-up 超时恢复（2026-10-20）

用户要求检查并修复本次生产失败，范围为本地修复/验证与只读实况。原文件已在 TEST 记账，保持不可变。恢复仍只补安全调用字段/ID，正文、业务终态、账务和 raw JSON 不动；独立远端执行/提交推送门禁保留。验收：真实生产只读查询计划与候选规模有证据；恢复迁移处理 2815 的当前规模，每批最多 2000、最多两批、总候选 >4000 拒绝且不写入；身份/provider/NULL/0/当前值优先/回滚/幂等/TEST 已删列分支有隔离 PG17 回归。
