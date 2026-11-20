# 设计

## 复用调研与取舍

| 已检索对象                                                                      | 决策                                                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/story-memory/{compress-job,text,validate,worker,config}.ts`           | 扩展现有编排与提示词；保持计数字符、完整分区和防异常缩水校验，不另建压缩服务。                                                              |
| `features/generation/story-memory-compress.ts`、`upstream.ts`                   | 仍由 generation 发起平台成本的非流式 OpenRouter 调用，保留 120 秒、256 KiB、12000 output tokens；提供安全的响应诊断，而非复制 HTTP 客户端。 |
| `platform/observability/{safe-log,logger-options,labels.zh-CN,jobs,context}.ts` | 复用 Pino、job 根 trace 和逐会话 ALS，精确增加有限标量投影；测试 actual stdout，而不只断言 callback 被调用。                                |
| `StoryMemoryRepository` 及 claim/commit/finish RPC                              | 不新增数据库函数/字段/查询日志；按需 claim 一条，沿用已有租约与 CAS；收尾使用原返回状态。                                                   |
| `20261110_story_memory.sql`、`20261120_story_memory_retry_guard.sql`            | 只读对照语义，不改历史 migration、不重复修退避；后者生产执行状态为发布前核验条件。                                                          |
| shared story-memory config/prompt、Frontend/Admin consumers                     | 不改外部契约、模板存储或运营配置。输入仅运行时渲染；在线 prompt 版本单独记录。                                                              |
| compress-chunk/story-memory/logger 现有测试；story-memory replay CLI            | 扩展既有虚构样本；不对用户真实会话调用付费回放。生成与 worker 边界需要专门回归，规划确认其必要性。                                          |
| UI components/hooks、通用队列、模型切换框架                                     | 本任务不涉及 UI；无新增 hooks/helpers 层或共享公开 API。拒绝新增队列、持久化诊断副本、自动换模型及无限重试。                                |

## 日志数据流与字段

模型响应 → generation 安全诊断 → 压缩校验 → worker 业务事件 → safe-log 标量投影 → 实际 Pino JSON → Railway。原 transport 只证明响应头；新的压缩终态证明正文已读完及校验结果。

- `stage`: `pre_shrink` / `merge` / `shrink`；`attempt` 为阶段内 1-based，`job_attempt` 为领取时 attempts+1；不用 attempt=0 混淆预精简。
- 每次模型调用只输出一次 `story_memory.compression.completed` / `story_memory.compression.failed`；拒绝沿用 `story_memory.validation.rejected`。压缩成功必须通过正文读取及校验，`outcome` 明确区分 succeeded/rejected/failed，不把 HTTP200 等同于校验通过。
- 字符字段：`output_chars` 为去围栏后非空白 Unicode code point 数；`prompt_chars` 为实际发出的 prompt 同一计数；`history_chars/recent_chars/old_memory_chars` 表示本次实际输入，精简调用不携带历史则为 0；`source_history_chars` 可用于关联原块规模但不冒充实际输入。
- 限制：`hard_max_chars` 运行时配置；`validation_max_chars` 本次真正校验值（预精简为 85% 总上限，主阶段为总上限）；`target_chars` 真正写入本次提示词的目标；`over_limit_chars=max(0, output_chars-validation_max_chars)`。
- 资源：`input_tokens/output_tokens/max_output_tokens`、`response_bytes/max_response_bytes`、`timeout_ms/duration_ms`、有限 `finish_reason/upstream_status/error_code`；异常没有可测输出时省略 output_chars 和 usage，不伪造 0。
- 关联：既有 job trace/span、可信 session/user/character ALS；每块记录 `chunk_index/chunk_count/range_start/range_end`，模型及 `prompt_version`。标识只进既有 Railway 关联，不加 Sentry 标签/正文。
- 预精简失败使用 warn，记录安全错误码和回落；后续正常并入仍可成功。主阶段终结失败沿用 error；任务摘要保留真实已提交块数与覆盖终点。finish 未知或 lease_lost 不得记录 succeeded。
- 只在明确白名单中增加数字/布尔/有限文本。不要开放任意 `*_chars` 字段或任意对象，不输出 prompt、档案正文、原始响应、供应商自由文本错误、昵称或 secrets。日志异常不能改变压缩、提交及计费结果。

## 有界稳定性方案

1. 主调用维持 85% 总上限目标；旧档案超过该线时仍最多预精简一次，65% 目标、85% 验收线，失败回落原档案并记录原因。修正提示词“未超过总上限却声称超限”的描述。
2. 主阶段最多三次调用。首次输出结构完整但 too_long 时，立即把这份输出交给精简提示词，目标为总上限 80%；再次 too_long 后目标降至 60%。不再为同一个超长问题重发全量原历史。每次仍执行全部现有校验。
3. 若修复输出缺分区/含思考，保留上一次结构完整的候选供剩余精简尝试，并附有限原因反馈；不能用坏候选覆盖它。若首次失败非 too_long，沿原完整输入纠错重试；没有结构完整候选时不进入档案精简。仍不超过三次。
4. 不新增网络重试，401/403/402/429/5xx/超时交给任务退避。未完整结束的响应（finish_reason!=stop）不接受；记录实际 output/token/finish_reason 以区分 token 截断与字数超限，不自动提高 token 上限。
5. 每轮最多三次“claim一条→执行→finish”；上一条收尾之前不领取下一条。批次共享已读取的配置和 prompt，空领取立即退出。单块最多 4×120秒调用，仍在15分钟租约内，逐块成功提交续租；不预领取等待。
6. 任务结果以已有数据库提交与 finish 返回为准。保留部分成功进度，后续失败重跑从数据库覆盖终点开始；commit/finish 结果未知不重发写入、不声称完成。DB ownership/CAS 继续防止跨 worker 覆盖。

## 可靠性评估

| 故障模型                      | 处理与边界                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 超时/断流/大响应/坏 JSON/截断 | 原120s和256KiB保护；取消贯穿正文读取；终态保留有限诊断，拒绝任何半成品。测试静止响应体的 abort 能结束读取，若现实现不满足则在同一 generation 读取函数修正取消清理。     |
| 重试与容量                    | 三次主调用+可选一次预精简，不增加调用次数；80%→60%只是提示词目标，硬校验不放松。最多100轮读取/块边界不变；每轮处理最多三条，增加的 claim RPC 有界，原串行模型并发不变。 |
| 幂等/并发/事务                | 原SKIP LOCKED、租约、版本CAS和RPC事务；按需领取避免等待租约过期；无新事务、锁、补偿写入。                                                                               |
| 不可用/降级                   | 无配置用现有规则；预精简失败可回落，最终失败旧记忆保留。没有新模型容灾或语义截断，无“失败当成功”。                                                                      |
| 持久化未知/收尾失败           | 不自动重试 mutation；让已有 lease/CAS 恢复。摘要 failed/unknown 与业务成功分开，不伪造 attempts/next_attempt_at。                                                       |
| 限流与退避                    | 不立即重试429，数据库是唯一退避源；新消息是否保持退避需确认既有retry_guard执行。没有新增限流器、租约表或任务状态。                                                      |
| 可观测/告警                   | 中间拒绝warn、最终失败error；连续第三次失败一次现有Sentry告警，不新增通知规则、不关闭现有告警，不把单次校验拒绝发成P0。                                                 |

## 演进、发布与恢复

无数据库/公开契约变化，先通过本地验证再随正常 Backend 发布；本轮按已批准方案本地实施，不部署。发布前只读核验 TEST 和 production 的 retry_guard 函数/迁移状态，二者分开记录。若生产缺少已有 guard，另走既有迁移测试与明确生产授权，不把缺失偷偷纳入本次发布。

发布后按相同模型/prompt/配置版本观察24小时，对比此前24小时：主阶段最终拒绝率、too_long超限分布、每成功块调用数/耗时/输出tokens、任务积压/覆盖推进、lease_lost；无分母或样本不足不报改善率。连续3个真实任务未推进、lease_lost增加或模型消耗/延迟显著上升时停止扩大并复核；回滚应用保持已提交版本、原CAS与数据库退避，不回写历史档案。发布前后人工核验重复失败告警一次/第三次、后续成功恢复覆盖。

后台与聊天同进程，发布后另按Android/iOS现有页面与API采样验证无退化；没有按端P95样本，不补零或宣称性能达标。测试不会证明语义记忆完整，真实上下文抽样核验只在受控环境由有权限的人进行。
