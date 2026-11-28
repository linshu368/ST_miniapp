# 规划证据与复用调研

核验日期2026-11-27。当前HEAD fae9e1d0，产品工作树初始无修改；原报告是本线程新增文件。

## 代码与复用

- G02：app/providers.tsx:88–110在effect调用initTelegramSdk；lib/telegram/init.ts:17仅not_started允许初始化；app/layout.tsx已有early startup脚本。安装版本SDK-react3.3.9、SDK3.11.8、bridge2.11.0。bridge/dist/index.js:207由真实监听器建立TelegramGameProxy.receiveEvent，不能假接收器替代。早到回调是否能可靠转交要先复现实验，不能直接加重试。
- G03/G13：chat-composer.tsx:149 onChange；hooks/use-memory-draft.ts:12 selector读取单entry，:22写store；stores/memory-draft-store.ts:38每次write提升revision。还检索useChatDraftRecovery、useChatHistory和useChatSession：现有缓存/草稿所有权必须保留；“同值写产生通知”不是已确认的全部反馈根因，不直接批量改为no-op。
- G04：conversation-stream.ts:351–426建立stopped与readConversationStream的Promise.race；cleanup移除外部abort；reader.cancel已有catch。用实际挂载/卸载与终态竞态复现，不能因栈指abort就断言stopped没有catch。现有conversation-stream.test.ts约421起覆盖普通abort，未证明全部卸载竞态。
- G05：reply-renderer/worker-scheduler.ts已有启动5秒/执行预算、generation、idle error销毁、messageerror、原文fallback；这些来自上一轮，不能重复修复。ReplyRenderer已有onFallback。需核故障静态块的实际装配和结果，不先堆备用Worker。
- G08：generation/call-costs.ts:120为成本UPDATE、:136为missed job INSERT；ops.llm_cost_jobs在20261119_db_reorg_p6a2c2_surplus_expand.sql:26定义call_id主键，6a2c3扩kind与次数，不能未经核验就改ON CONFLICT键。原表有prompt_tokens/completion_tokens/updated_at；报告P2010不能证明缺列。复用call-cost-rules、surplus-call-costs、relay-call-costs及runObservedJob，不另建补查框架。
- G10：first-token-reports.ts已有限3次即时+最多1次恢复，保留owner/TTL/去重；GenerationObservationRepository.report有3秒RPC期限；receiptDiagnostics已经stage/rpc_ms/unknown。旧诊断不是根因修复。复用现有report_chat_first_token和billing交付判定，先查函数/锁/最终提交语义，不新增账务出口。
- G11：MiniappUserSettingsRepository.getGenerationContext并行读偏好/资料/指令，任一失败整体失败；UserProfileRepository.readNames及generation-config hook是消费者。不能静默把数据库故障变默认设置。
- G12：characters.ts列表Promise.all逐卡resolveCharacterDisplayAvatarUrl；features/creator/covers.ts已有resolvePublicCreatorCoverUrls批量签名、限时、缓存与缺图降级，可复用但仅供已授权的公开卡，不改变私有ownership。
- G09：lib/cs-service.ts已有observed support.proxy、默认5秒/带图20秒；frontend lib/api/support.ts背景未读20秒轮询、30秒缓存；routes/support.ts透传信封。客服独立仓库仅在发现上游修复确有必要时读取其AGENTS/spec，不跨仓盲改。
- G01/G06/G07：复用现有safe诊断、请求signal、QueryObserver与可观测出口；不再新增高基数身份或采集正文。

## 已有任务 / 提交

复用11-24-sentry-g1-g5-remediation、11-19-mobile-performance-round2、11-19-cold-start-round2、11-19-creator-editor-performance、11-19-conversation-read-reliability、11-02-first-token-delivery-repair和11-27-chat-call-cost。它们的记录是历史证据，不改其规划状态或假装当前修复已完成。

实际51948a7b补丁相关四文件与故障c046f213一致；祖先关系false可由合并路径不同造成，不能据此说未上线。d328f55e含草稿实现，5633f73e在成本源码历史中，均不是已确认根因提交。精确release和生产链路见错误报告§6。

## 基线验证

首轮Frontend4文件、Backend5文件、Renderer全测试均在Vitest启动前因缺@jridgewell/sourcemap-codec失败，未执行断言。
pnpm install --frozen-lockfile --ignore-scripts显示up-to-date但未恢复内容；随后pnpm install --force --frozen-lockfile --ignore-scripts从已有锁和缓存重建1107个依赖，未改lockfile/版本，未运行安装脚本。

重跑：Frontend上述4文件50项通过；Backend上述5文件34项通过；Renderer全套1文件35项通过（共119项）。这些是既有覆盖基线，尚不能证明报告中的真实故障恢复；未实施产品修改。

Supabase技能的通用直接execute_sql建议与仓库AGENTS冲突时，以仓库更严格的迁移源/只读结构采集规则为准。首轮规划未连接数据库；后续仅确认目标并读取生产catalog结构，详见[investigation-2026-11-27.md](investigation-2026-11-27.md)，没有业务行读取或数据库写入。已读取[官方变更索引](https://supabase.com/changelog.md)；最新CLI/平台权限变更不要求本次升级CLI或改部署。通过Supabase官方search_docs补查到[abortSignal](https://supabase.com/docs/reference/javascript/using-modifiers-abortsignal)及[RPC](https://supabase.com/docs/reference/javascript/rpc)：abortSignal控制fetch请求；官方片段未提供取消后的事务最终态保证，因此本任务保留unknown，不推断已回滚。

规划校验：task.py validate通过（implement/check各13项真实引用）；独立调用validate_module_impact、validate_mobile_performance及validate_logging_integration均通过；日志规划CLI通过；Markdown/JSON Prettier通过。四份大型spec的自动上下文注入会截断，当前为单代理内联执行，实施时必须按目标章节直接完整读取原文件，不能只靠注入摘要；不得放宽context大小或修改项目规范消除提示。Git diff --check通过。原错误报告SHA256仍为ffcf0a827dbf4d7fe1ad8347ee3add8951fd664894db623584dc16d7d4e0816e，未覆盖。任务保持planning、implementation_authorized=false，没有产品代码修改或数据库/生产写操作；后续只读结构取证见追加调查。

## 证据边界

没有复制原始Sentry事件/用户/会话/请求参数/签名资源URL到本任务；生产证据沿报告安全引用。
“必须处理”说明需推进处理，不保证每个异常已经有可落地的代码根因；未定位项不得伪造修复，也不得以新增日志作为任务完成。

追加基线：既有UI的Worker降级和多行输入场景在android/narrow共4项通过；没有新增测试或产品改动。当前生产成本表所需列、call_id主键、kind/次数约束均存在，catalog未见用户自定义触发器；不能凭P2010推定缺列/缺主键。详细查询边界、真实覆盖和隔离PG17工具缺口见[追加只读调查](investigation-2026-11-27.md)。
