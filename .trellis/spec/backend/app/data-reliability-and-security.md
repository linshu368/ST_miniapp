# Backend 数据、可靠性、安全与可观测性

## 数据访问边界

- Prisma 只映射 `app_core`、`miniapp_features`、`billing`；schema 变更唯一源是 `packages/shared/migrations/`。
- 其他域通过显式 schema client/RPC/repository。跨域写入用事务/RPC或明确补偿，不在 route 串联多次写后忽略半成功。
- repository 返回领域对象，不泄漏数据库行。列表必须稳定排序、有界分页；批量/导出评估行数、内存、超时，避免 N+1。

## 配置、秘密与鉴权

- `platform/config.ts` 统一解析启动配置并 fail fast；运行时运营配置只走 `runtime-config.ts` 的 TTL/version/降级机制。
- 禁止 secret、token、完整 initData、签名材料、DB URI、消息正文进入源码、Markdown、URL或日志。
- MiniApp 用 `requireTelegramAuth`；CS/Admin/Bot 沿用各自 token/session/webhook secret。鉴权后仍需资源 ownership/角色授权；service role 仅在后端。
- CORS 只允许配置 origin；不得用带凭证的无约束 `*`。

## 故障模型硬规则

| 风险 | REQUIRED                                                                          |
| ---- | --------------------------------------------------------------------------------- |
| 超时 | 每个 HTTP/LLM/TTS/Telegram/支付外部调用有明确 timeout；整体 deadline 不因重试重置 |
| 重试 | 有限、退避加抖动；仅幂等读或具幂等键写；尊重 429/Retry-After                      |
| 幂等 | 支付、奖励、归因、开轮、语音指定业务键和重复请求结果                              |
| 并发 | 会话、钱包、结算使用行锁/unique/原子 RPC，不用进程锁替代 DB 一致性                |
| 事务 | 多表不变量使用事务/RPC；跨外部系统写清提交点、补偿、对账                          |
| 降级 | 配置有安全默认；非核心通知/遥测失败不破坏主交易；关键失败不静默吞掉               |
| 容量 | SSE、导出、轮询、音频/大 JSON 有大小、并发、时间上限                              |
| 恢复 | 重启后可重放或由 sync/reconciliation job 收敛，记录停止条件和人工入口             |

高可用不是默认增加队列/缓存/adapter。只有真实故障需要且可验证时才增加组件；优先数据库约束、有限重试、已有 job 和清晰错误。

## 可观测性与发布

### Railway 可读性输出契约

1. **适用范围**：所有 Backend Pino 日志；新增事件/模块/任务或改调用场景时，核对 `platform/observability/labels.zh-CN.ts`，不能仅依赖 operation.started/terminal 排障。
2. **签名**：纯 `createLogPresentation(catalog)(safeRecord, numericLevel)` 返回 msg/module_name/scenario/result/error_message；项目词表注入，SDK 不导入中文词表或应用装配。Pino hook 生成摘要，formatter 仅接受内部生成展示字段，业务传入的同名字段/插值消息被丢弃。
3. **契约**：msg 最多700字符。`call_scene` 只允许 method:已注册HTTP模板或 job.稳定任务名，在独立请求/任务根创建并由子 span 继承；不读原始URL/请求参数。保留英文事件/operation/module/等级、原始状态和耗时精度及 trace/request/span；不采样/删除基础事件。中文展示不作为告警匹配条件。
4. **错误矩阵**：没有 outcome 的 info→已记录；unknown/SSE200→结果未确认；探测 unavailable/策略失败→分别显示真实结果，不能由 HTTP200 推断成功。已识别 code/cause/class→固定中文说明；未知错误→未分类及安全源码位置，绝不放行任意 Error.message/SDK details。展示异常→固定事件降级，原日志/业务继续。
5. **案例**：正常为会员请求→同一 call_scene 的 DB 子操作；基础为独立任务→其 job 场景；错误为嵌套 probe/strategies 整体传 logger 后以为能查到结果。任务应显式投影结果、渠道、错误分类和有界计数，不输出 URL/交易号/钱包 DTO。
6. **验证**：既有 logger/http/SDK 测试验证实际 JSON、child/setBindings、并发场景隔离、已投影 cause、未知事件和展示失败；probe/precheck/repository 验证跳过/配置错误/部分失败/查询异常、原返回值及执行一次。用户明确免除本地 UI 时，不启动浏览器；真实 Railway 展示/P95 随发布核验。
7. **正误对照**：错误是恢复任意中文插值或将总 info 推断成功；正确是集中维护固定词表、显式记录实际结果、让摘要引用稳定机器字段，并保留结构化检索。

日志实现、测试及规则集中在 `platform/observability/`；`alert-rules.json` 是唯一规则来源，LOG_ALERT_RULES 环境变量已移除读取。总开关默认关闭时零文件 I/O，开启时只读固定模块相对 URL 并冻结快照，文件错误 fail fast。业务仍通过 runtime-config 的统一 getter 取得配置。模块/业务模块、HTTP/上游状态分别精确匹配；停用专项规则不抑制后续兜底。`logging:validate` 和 CI 校验真实文件，无数据库或通知副作用。SDK 候选入口不导入 runtime、配置、文件、Pino、DB 或具体渠道；业务字段与框架适配保持显式，完整契约见 [模块 README](../../../../packages/backend/src/platform/observability/README.md)。

### 统一运行时事件接入契约

1. **范围**：`platform/observability/` 为统一事件底座，分模块接入；运行时 stdout 由 Railway 捕获，不新增日志存储或重放。底座存在不代表全仓覆盖完成。
2. **签名**：`createObserver(sinks)` 提供 `emit/start/observe/observeSync`；`start().finish()` 一次有效；`withContext(context, run)` 使用隔离作用域，嵌套操作继承 trace 并新建 span。
3. **契约**：只投影 EventFields 白名单。固定字段和关联标识不可由扩展字段覆盖；传原始 err，出口过滤未知消息，只保留受控类型、有界源码位置和 cause。`observe` 执行一次，原结果/异常回传；写操作异常默认 outcome_known=false，不推断是否提交。
4. **错误矩阵**：输出同步抛错/异步拒绝只增加健康计数；摘要提取失败记录 unknown，不替换业务成功；关闭可选输出不代表基础 stdout 可被诊断等级关闭。
5. **案例**：正常为父子 span 和独立请求上下文；基线为无 HTTP 的根操作；错误为记录完整 SDK Error.message、body 或按异常重执行业务。
6. **验证**：核心回归覆盖并发隔离、嵌套、原值/异常、执行一次、重复 finish、输出故障、摘要异常、敏感字段与超限；每个接入模块另验证其协议终态。
7. **正误对照**：错误做法是将 Error 序列化后直接写出或用 enterWith 污染其他请求；正确做法是受控错误投影及 run 作用域，业务自己决定实际结算和交付结果。

HTTP 根级 `registerHttpObservation` 在 CORS/鉴权之前运行，使用回调 hook 在 `withContext` 内继续；响应头回传 X-Request-Id/X-Trace-Id。raw finish/close 与 onResponse 共用一次终态守卫，hijack SSE 也记录传输结果；SSE HTTP 200 业务结果保持 unknown，由流所有者另报。默认 Fastify 请求日志关闭，避免双份开始/终态。基础 stdout 与 LOG_LEVEL 独立，测试默认静默；logger-options 独立于配置/数据库初始化，错误对象及 Pino 自动生成的 msg 都须清洗。

出站客户端在原模块声明 `clientFetch(operation, provider)`，只包装该客户端的 fetch；`observedFetch` 可传入已有 undici/代理实现。记录到 response_headers，不读取正文、不改 signal/timeout/redirect、不添加重试。非成功 HTTP 是 attempt 失败，不等于业务失败；写入抛错为 outcome_known=false。Supabase 从既有 observedSupabaseFetch 接入（含非 REST 请求）；Prisma 从 measureDbOperation 接入 model/raw/unsafe raw。SDK 返回的业务错误仍由 repository/业务边界判断，禁止把 HTTP 200 当作 RPC 业务成功。

共享与 dedicated Prisma 都必须应用 `applyPrismaObservation`，保留原单连接/transaction 语义；pg advisory lease 用 observer 包装原 connect/lock/unlock/close。AST 门禁现在核对 Prisma/Supabase/pg 创建边界及实际包装；新增其他 SDK/动态入口仍需独立评审接线。不新增日志 SQL 或查询参数；锁竞争未取得是业务 skipped，不是数据库执行失败。

生成入口 `execute` 用独立子操作记录安全结果，不输出正文；原执行/计费及 hooks 不变。`createReplyStreamSink` 在 open 建立交付操作，流内 error 和 done 提供应用结果；断连优先记录 interrupted，后续后台生成成功不能改写已中断的交付。`observeGenerationAttempt` 与 `observeBackgroundJob` 的基础事件在可选工程遥测开关之前输出。工程 OTLP exporter 拆至 engineering-telemetry-exporter，原指标口径及出口配置不变。

- 使用现有 pino、`requestLogger`；原始异常写 `{ err }`。Sentry 先脱敏再附 context。
- 关键流程记录阶段、耗时、状态/计数、安全幂等摘要、provider/request id；job 记录扫描/推进/失败数，禁止逐行高频 info。
- 发布顺序：兼容 migration → backend producer → consumers → 清理旧字段。说明旧数据、灰度/停止条件、rollback 或 forward-fix。生产 migration 手动逐文件，先 test 验证 shape、RLS/权限、读写、锁/容量和回滚。

### 运行时日志补充（2026-11-13，本地未部署）

定时任务用 runObservedJob 建独立上下文，由已有 observeBackgroundRun 提供真实终态；resolved void 不能推定成功。支付语义事件使用脱敏业务键，禁止原订单/用户/metadata 进入通知。

Pino 标量白名单与 Sentry 各出口过滤原始内容；短剧诊断必须走 validatedDramaLog 的 shared schema 保留完整安全结构。生产代码禁止 console，离线 CLI stdout 是明确例外，CI 执行 lint:backend-logging。LOG_ALERTING_ENABLED 默认关闭；开启时第一条规则匹配即直接发送安全通知，4并发/2.5秒/无持久化无重试。内部通知故障事件不递归。完整配置与错误契约保留边界见 docs/backend-observability-runtime.md。

审计补充：Pino 子 logger 会重置绑定 formatter，必须在 onChild 重建安全绑定缓存，同时过滤后续 setBindings；升级 Pino 验证实际 JSON 输出。SDK 普通错误对象仅保留受控 code，foundation 再投影不能丢失有限 cause 链。数据库异常转换使用 `new Error(compatibleMessage, { cause: originalError })`，已映射业务错误也保留 cause，禁止只复制 message；捕获后返回响应的业务边界仍须记录 `{ err }`，不能依赖不会触发的 onError。无 event 的 warn/error/fatal 以固定 logger.warn/logger.error/logger.fatal 兜底，业务优先登记稳定 event；默认告警仍只匹配 error/fatal。告警保留 error_code/public_error_code 两个事实，error_codes 兼容匹配任一，public_error_codes 精确匹配公开码；关闭时仍不进行匹配或通知。HTTP 各完成回调共用等级判断，禁止首个回调遗漏 severity 后锁死错误等级。

新客户端的 fetch 默认值、别名和 SDK transport 注入也要显式登记；新定时 worker 必须建立独立 runObservedJob 上下文。静态 AST guard 检查这些边界并在 CI 跑自测，但不替代异步上下文、终态和返回身份测试。计数字段使用明确的 Count/\_count 名称，不传整个业务对象来获得排障信息。

每轮任务的结果/异常回调必须处于同一根上下文中，不能只包装 runPass 后在作用域外记录汇总。AST 按实际 setInterval 回调、sleep 轮询循环检查，不依赖 job/worker 文件名或同文件出现过任意 wrapper。新 scripts 默认检查，新增离线例外必须核对其人工 stdout 协议及运行时消费者；当前例外和具体语法边界见 `scripts/check-backend-logging.mjs`、`scripts/logging-boundary-checks.mjs` 与运行说明。

## 场景：Railway 业务关联字段（2026-11-14）

### 1. 范围与触发条件

用户/会话/角色创作/短剧日志接入，以及修改 Pino 白名单、ALS、身份缓存或 Sentry 出口时适用；本地实现不代表线上已部署。

### 2. 签名

`bindBusinessContext(fields: BusinessFields): void` 补充当前请求；`withBusinessContext<T>(fields, run): T` 克隆并行业务作用域；`contextLogFields()` 展平安全字段供 Pino/observer 使用。没有新的公开 API/数据库对象/环境变量。

### 3. 字段契约

`user_id/session_id/character_id/creation_id/drama_id/video_id` 只接受 UUID 并规范为小写，legacy camelCase 输入统一为 snake_case。`telegram_user_id` 只由鉴权成功路径绑定为安全正整数字符串，不把 Telegram 数字混入 user_id。当前创作以角色卡为实体，creation_id=character_id；不要虚构 project_id。business_module 采用固定词表，与技术 module/operation 分开。HTTP 参数目标不等于 ownership 证明。

补充审计：影像创作的 `image_conversation_id`（兼容 legacy conversationId）与聊天 session_id 分开，`attempt_id/work_id/artifact_id/message_id/audio_id/image_id` 使用同样 UUID 投影和出口排除。路由映射同时识别 :id 与 :sessionId；getSession ownership 读取成功后补角色，而不是仅在空会话复用分支绑定。图片/影像/记忆 worker 逐实体克隆上下文，支付语义事件从已有可信事件取内部用户，群 webhook 验 secret 和身份后绑定，不增加查库。业务模块还覆盖 growth/community/support/wallet/vip/free_zone。

根上下文各有独立关联容器，子 span 共享，HTTP started 后补入的身份可用于 raw finish/close 终态。不同对象的并行任务用 withBusinessContext，不能修改共享父容器。内部身份缓存和 inflight 的每个调用者必须在 await 后绑定，不能只在实际查询分支绑定。禁止为了日志额外查库；无映射身份时留空。只允许 Railway stdout 输出这些 ID；Sentry 的所有出口、告警和指标保持排除。

### 4. 校验与错误矩阵

非法/缺失 ID → 丢弃；鉴权失败 → 无身份字段；身份查询失败 → 不虚构 user_id；资源不存在/越权 → 可保留请求目标但结果为原拒绝；SSE 断开 → 已有关联字段+interrupted，一次终态。日志不新增重试或改变业务异常。

### 5. 正常、基础与错误场景

正常：按用户/会话找到 trace，再查 DB/provider 子 span。基础：短剧只需 Telegram 鉴权，不增加用户查库。错误：把用户 DTO 整体传 logger，或并行卡片处理共享一个可变对象。

### 6. 必须验证

既有 core/http/logger/user/auth/sentry 测试覆盖真实 JSON、共享 inflight/cache、不同请求/作用域隔离、延迟补字段、断开、非法 ID 和所有遥测出口。业务 route 测试保留协议；发布后按运行说明在 Railway 实测检索，真实 P95 仍按任务窗口记录。

### 7. 错误与正确做法

错误：只在 `resolveDbUserIdentity` 内绑定用户，等待同一 Promise 的其他请求丢身份。正确：`const user = await loadDbUserIdentity(tgUser); bindBusinessContext({ user_id: user.id });`。并行业务用 `withBusinessContext({ session_id }, () => run())`；日志白名单允许 ID 后仍应单独验证 Sentry beforeSendSpan，不仅验证 beforeSend。

## Scenario: 文字回复取消与残留恢复

### 1. Scope / Trigger

文字回复无首字、断流或异常后不能永久占住会话。显式取消与离页断网分别处理。

### 2. Signatures

`POST /api/v1/conversations/:id/cancel`；详情 `GET /api/v1/conversations/:id` 和发送/重生成开轮前负责过期恢复。复用 `experience.chat_history`，不新增数据库对象。

### 3. Contracts

请求 `{ assistant_message_id: string }`（UUID），返回 envelope 内 `{ message: ChatMessage }`，是该条实际服务端终态。ownership 必须先于取消/恢复操作。取消标记 `streaming.llm_finish_reason=cancelled`；取消终态 `stream_interrupted`。成功抢占必须仅匹配 streaming 且无取消标记。免费预留释放先于取消终态，统计/回捞不能覆盖取消标记恢复计费。send/regenerate 允许可选 request_id UUID；它仅关联取消，装饰 history JSON 首条记录的落库副本并由 ChatMessage.request_id 公开，不得污染上游 prompt，不得用作计费幂等键。首字前定位同时匹配 request_id/turn/revision。旧客户端/旧行可选兼容。无新环境变量；producer-first 发布。

### 4. Validation & Error Matrix

- 非法 session/message UUID → 400；未鉴权 → 401；非本人/不存在会话 → session_not_found。
- 非当前回复 ID → 不改当前回复；重复取消返回实际状态。
- 有可见正文的自然完成先赢 → 返回 complete，保留正常计费；终态空回复仍记录 empty 明细但不扣费；取消先赢 → interrupted。旧cancelled仍免扣；新显式user_cancelled在冻结原价后按原权益结算，免费轮消费额度，系统timeout仍免扣。
- 暂未确认取消 → CANCEL_PENDING，保持生成占用并允许重试；不是取消成功。
- 开轮后上下文/上游/落库异常 → 条件终态恢复；详情/开轮前回收超过 120 秒 streaming 并释放预留；开轮 RPC 陈旧阈值传 24 小时，避免历史 guard 在 120 秒临界绕过额度释放。

### 5. Good/Base/Bad Cases

- Good：取消标记锁定结果→停止上游→释放额度→终态→重新生成仍正确使用额度。
- Base：断网只断本地，重进详情恢复真实状态并可取消。
- Bad：仅浏览器 abort 或前端解禁；生成完成后再无条件覆盖 DB；进程 Map 作为跨副本取消事实来源。

### 6. Tests Required

CAS 取消先赢/完成先赢、重复/错误/非本人 ID、取消等待失败、额度释放后再允许重生成、旧 revision 不覆盖、prep 异常/残留恢复、上游挂流/缺 done。真实 TEST/Preview 与 Telegram、钱包/额度人工矩阵见任务 manual-regression.md，单测不替代实况。

### 7. Wrong vs Correct

Wrong：`controller.abort(); setGenerating(false)`，仍留下服务端 streaming。

Correct：绑定具体回复调用服务端取消，只有响应真实终态才清除本地占位；生成在计费前争抢没有取消标记的 streaming，取消先释放预留再收口。

## Scenario: AI 回复后处理版本发布与消费

### 1. Scope / Trigger

跨 Admin、Backend、Shared、Frontend 与数据库的文本后处理会改变回复展示，并包含正则、受限 HTML/CSS、并发发布和历史版本稳定性；必须把 source、compiled artifact、正式指针和消息版本作为显式契约处理。

### 2. Signatures

- Admin：`GET /api/admin/text-postprocess`、`PUT /draft`、`DELETE /draft`、`POST /publish`、`POST /rollback`、`GET /requests/:requestId`。
- MiniApp：`POST /api/v1/text-postprocess/versions`，请求最多 20 个去重正整数版本，响应逐版本返回 snapshot 或 unavailable。
- DB：`experience.start_chat_history_turn_with_current_postprocess` 与 `experience.start_chat_history_regeneration_with_current_postprocess`；成功返回非空 `postprocess_version`。

### 3. Contracts

- source/artifact 固定 `schema_version` 与 `policy_version`；发布快照不可变。runtime config 只保存当前正式版本/source identity 指针，不保存 artifact。
- 发布/回滚请求携带 UUID `request_id`、当前版本和草稿/目标 CAS 前提。回滚重新编译目标 source 并创建新版本，不修改目标版本。
- `ChatMessage` 与 SSE `start` 的 `postprocess_version` 向后兼容可选；新开轮成功必须非空，旧行可为 `NULL` 且不回填。
- 日志只记录环境、版本、request id、规则/诊断计数、耗时和结果；禁止 source、artifact 正文、聊天正文、token 或原始数据库错误。

### 4. Validation & Error Matrix

- source/flags/HTML/CSS/预算非法 → validation error，保留草稿，不创建发布版本。
- 编译 Worker 超时/崩溃 → `VALIDATION_UNAVAILABLE`，不进入发布事务。
- 草稿或当前版本 CAS 冲突 → conflict，客户端重新读取并人工处理，不覆盖。
- mutation 响应超时/断开 → `RESULT_UNKNOWN`，按原 `request_id` 查询 outcome，禁止盲重试。
- runtime 指针缺失/协议错版/快照缺 artifact/新 RPC 未部署 → 开轮整事务失败，不调用 LLM、不计费、不发 SSE、不留 history 半写。
- 批次中的单个 artifact 非法/不存在 → 仅该版本 unavailable，其他版本正常返回。

### 5. Good/Base/Bad Cases

- Good：发布 v2 时旧轮继续绑定 v1，新轮原子绑定 v2；reload 后每条消息仍按自身版本展示。
- Base：旧 `NULL` 消息或 unavailable snapshot 展示完整原始 Markdown。
- Bad：Frontend 编译 source、使用 `MAX(version)`、发布时先切指针后写 artifact、结果未知自动重复发布。

### 6. Tests Required

- Shared：source/artifact schema、恶意 HTML/CSS、正则边界、预算与确定性。
- Backend：Admin 鉴权/CAS/request replay/unknown lookup、Worker 终止、批次好坏隔离、日志不泄露。
- SQL：发布原子性/不可变/最小授权、开轮发送与重生成、非法指针零半写、旧显式 `NULL` 兼容。
- Consumers：Frontend/Admin/renderer typecheck、测试与 build；真机验证流式稳定、终态 choice、双击和版本切换。

### 7. Wrong vs Correct

Wrong：Backend 超时后传 `NULL` 开轮，或客户端拿 source 即时编译并选择最新版本。

Correct：数据库开轮事务读取权威指针并绑定不可变 artifact 版本；消费者只读消息自身版本，任何不可用都退化为完整原文。

## Scenario: OpenRouter 明细、计费恢复与原名字段

### 1. Scope / Trigger

OpenRouter 原始调用事实移入 `experience.openrouter_chat_history`；主表继续拥有业务终态、generation ID 兼容恢复键与计费事实。拆表不能缩小原有计费恢复覆盖面或改变 Venice 行为。

### 2. Signatures

- `OpenRouterChatHistoryRepository.ensureGenerationId(historyId, generationId)` / `upsert(metadata)`；唯一键 `chat_history_id`。
- 主表 `listRowsPendingBilling({ since, limit })`、`listRowsMissingOpenRouterDetail({ since, limit })` 与专表 `listRowsMissingGenerationData({ since, limit })` 独立扫描，再按 parent ID 去重。
- `recordBillingOutcome({ historyId, deductionRate?, intendedDeduction?, finishReason?, billingSettledAt? })` 只接受主表事实；不传入整个 provider metadata 对象。

### 3. Contracts

11 列使用厂商原名：provider_name、finish_reason、usage、usage_cache、native_tokens_cached/reasoning/completion/prompt、latency、generation_time、model。只保留 `llm_generation_id` / `llm_generation_data` 两个命名例外。usage_cache 可缺失且 0 有效，不新增 cache_discount。

恢复窗口 24h，各来源最多 50、DB 调用 5s；独立扫描失败不阻断其他来源。pending billing 与 metadata 是否完整独立，包含 Venice；缺失占位恢复通过左右明细 anti-join，排除 Venice 明细及明确 Venice snapshot。只剩 parent ID 时仍可恢复，故兼容期不能删 parent generation ID。

`llm_generation_data` 只允许 id 与原名 metadata 字段；字符串最多 512 字符，错误仅允许数值 code；不持久化任意嵌套对象、error message、正文或凭证。主表取消/超时与上游 finish_reason 独立。

### 4. Validation & Error Matrix

- metadata 已完整但 billingSettledAt 缺失 → 主表 pending 扫描重入同 charge_id，补 quota/金额收口。
- placeholder 失败 → 24h 内通过 parent ID 恢复；超窗须审查 catch-up，不能声称自动恢复。
- Venice pending → 既有本地业务 finish reason 结算，不请求 OpenRouter API、不写 OpenRouter detail。
- 一路扫描失败 → 安全日志记录 source/err，其余来源继续；唯一/FK 与计费 RPC 幂等处理重复/多副本。
- cancelled/timeout 后上游 stop → 专表可记 stop，主表终态与非计费结果不变。

### 5. Good/Base/Bad Cases

Good：metadata complete、quota finalize 暂失败，独立 pending 扫描补收口。Base：metadata 迟到，保留占位并有界回捞。Bad：只查专表 NULL 字段，把“metadata 完整”当作“结算完成”，或将 Venice 从恢复路径排除。

### 6. Tests Required

扩展既有 mapper/repository/sync/cancel 测试：原名/zero/NULL、未知嵌套内容排除、完整 metadata 的计费恢复、缺失占位、Venice、重复候选、单路扫描失败、取消/超时晚到 stop。既有测试与本地迁移检查不能替代 TEST 真机、钱包/quota、多副本/故障恢复及 Production 独立验收。

### 7. Wrong vs Correct

Wrong：`rows = detailRowsWithMissingMetadata` 后假设全部计费都会被修复；黑名单删掉 prompt 后保存剩余任意 JSON。

Correct：独立扫描 `pendingBilling + missingDetail + incompleteMetadata` 并按 parent 去重；诊断字段用有界 allowlist，业务金额/终态显式写主表。

## Scenario: Provider 调用身份清退主表

### 1. Scope / Trigger

清退 chat_history 的 12 个调用元数据列时，必须保持正常对话正文/历史/终态落表和计费/额度恢复；业务 llm_finish_reason 保留，不以调用专表原始结束原因取代。

### 2. Signatures

GenerationHooks.onBeforeDispatch(snapshot: LlmBillingSnapshot)、onGenerationId(generationId: string) 均为内部 async 接缝；ConversationHistoryRepository.finalizeTurn 不接收 generationId。listRowsPendingBilling({since,limit,provider}) 按两个具体 provider 专表取 ID，listRowsMissingProviderIdentity/listStaleStreaming 独立扫描；无新公开 API 或运行时 env。

### 3. Contracts

请求上游前 await 请求时快照和对应专表空占位；header/SSE/non-stream 首次 ID 持久化再转发该 delta。ensureGenerationId 仅写 NULL，已存在相同值为成功，不同值拒绝；每个请求 5s、总 10s，最多两次写及一次 100ms 退避，写超时读回确认，不重发生成请求。SSE 当前收到的文本先进入 snapshot，数据库异常通过 pipeline 清理，不吞进 JSON parse catch；已收到正文不因 metadata 失败丢失。OpenRouter NULL 统计不覆盖已有事实，0 保留，usage_cache 可缺失。

### 4. Validation & Error Matrix

- 快照/占位失败：不发送上游，按原清理释放预留并收口主表。
- ID 写结果未知：同 parent 读回；不同 ID 拒绝；预算耗尽停止调用，保留已接收文本和已落表状态。
- ID 持久化前崩溃：不能凭空找回上游 ID；超时 streaming 复用 120s/额度释放；成功但原因不足保留人工审计，不猜 stop、不重生成。
- metadata 完整但账/额度/主表回写失败：用专表已存事实和原 charge_id/冻结快照重入。无 OpenRouter key 不停 Venice 或超时清理。
- provider 专表交叠或与明确快照冲突：停止该记录、保留诊断，继续其他候选。Venice 明细证明来源但旧快照无 provider 时，用 Venice 来源标记恢复，不默认 OpenRouter。

### 5. Good/Base/Bad Cases

Good：五路（两个 provider pending、missing identity、metadata、stale）各限 50/24h/5s，去重和源/行错误隔离。Base：metadata 完整直接补计费，不额外依赖上游可用。Bad：删掉缺失扫描，或 SELECT \* 顺带读取待删列，或晚到 stop 覆盖业务取消/超时。

### 6. Tests Required

既有 generation/execute/upstream/sync/settle、生命周期和 repository 回归；本地隔离 PG17+PostgREST 实际删除 12 列后验证正文/上下文/终态、ID CAS/多请求、NULL/0、计费候选/缺失候选、业务取消与视图角色权限。真实钱包 RPC、上游与真机/多 Railway 副本仍独立验收，不能以本地 fixture 代替。

### 7. Wrong vs Correct

Wrong：finalizeTurn 写 parent.llm_generation_id，detail 写失败靠主表补救。Correct：上游前持久化意图/专表占位，首 ID 写专表并读回不确定结果，finalizeTurn 只维护主表正文与业务终态；失去调用键时明确收口或停止审计。

## 图片生成结算结果未知

存图后结算 RPC 可能已提交但响应丢失；返回 error、Promise reject 或无法确认状态时不得直接删除成果，应保图并传递结果未知，不重发 Provider/扣费。仅明确余额不足等已确认未扣款分支允许清理。后续失败标记必须保留处理中状态条件，不能覆盖原子结算已落下的 ready。消费查询需同时覆盖 image_generation 与 image_plaza_generation，余额缓存应在新 ready 后失效，不能把202受理视作已扣款。虚拟回归只证明应用边界行为，不代替数据库事务或真实扣款验收。

## 历史：首 token 阶段与总预算（2026-10-26，竞争策略见文末）

### 1. Scope / Trigger

自研会话发送/重生成，普通和思考模式都执行默认首发4秒、兜底2秒、用户总10秒。用户时长由客户端测量，后端独立从路由入口保护。

### 2. Signatures

`forwardWithFirstTokenFallback({timeoutMs,fallbackTimeoutMs,remainingFirstTokenMs,forward(...,onDispatch)})`；`FirstTokenDeadlineError(stage)`；现有 begin/report RPC 签名不变。

### 3. Contracts

型号等待由实际POST派发回调起计，路由/请求体准备另计；绝对阶段截止复核防止事件循环延迟让迟到token抢交付。总限优先，剩余不足缩短/跳过首发，`budget_skipped` 不填虚构派发/首字。新增nullable `fallback_timeout_ms/client_wait_finished_ms/server_timeout_stage`；旧行保持NULL，v1/v2和配置分组。原型号价格/权益一次结算。

### 4. Validation & Error Matrix

同型号不重复POST，仍执行首发上限；无公开思考同样切兜底。阶段失败返回 `primary_first_token_timeout/fallback_first_token_timeout`，总限为 `first_token_timeout`。安全释放/终态后发start身份再发error，支持真实客户端回报；未确认额度释放保持占用。阶段或总截止停止所有在途尝试。

### 5. Good/Base/Bad Cases

Good：前置1.5秒、首发4秒、切换0.1秒、兜底1秒，用户分布取实际显示约6.6秒而非4+1。Base：已开思考3秒可见，正文10秒仍可继续。Bad：为给兜底留2秒而暗中把用户总限延长。

### 6. Tests Required

既有fallback/execute/lifecycle测试覆盖实际POST起计、迟到计时器、总限优先、同型号、思考、一次计费/额度释放；PG17+PostgREST验证nullable兼容、身份与首次回报、ACL、配置、Grafana查询及2截断/1其他失败/1显示/1缺报对照。

### 7. Wrong vs Correct

Wrong：provider latency或后台写出视为用户看到，提前阶段失败漏出超时率。Correct：客户端可见结果是业务依据；时间截断率分子仅时间原因，分母为前台已知结果（显示+时间失败+其他上游失败）；缺报不算成功，另示覆盖率。

## Scenario: 可见首 token 后才允许结算（2026-10-26）

### 1. Scope / Trigger

新建 observation 的文字轮次；服务端完成而客户端超时无字不能扣星尘或免费次数。

### 2. Signatures

`billing.chat_delivery_billing_gate(charge_key)` 返回 legacy/visible/pending/waived；既有 charge/finalize RPC 签名不变；`applyLlmCharge` 返回实际 pending。

### 3. Contracts

experience 的 requires_visible_token 是交付协议标记，存量 false、新轮 true；billing 资格函数锁定请求后读取身份绑定的首个客户端结果。缺报 pending，服务器预算加 15 秒回报宽限后 waived，宽限不改变前端总限。报价、完整成功、钱包策略、单 charge_id 仍由服务端约束；已终结零费用不得被 sync 重新扣。

### 4. Validation & Error Matrix

客户端 timed_out/not_observed 或服务端首字超时 → waived；observed 且真实显示时间小于总限才允许通过原计费闸门。缺报期间不消费预留；失去回报按不收费处理。权限仅 service_role/postgres；故障先失败闭合，不用上游 stop 推断可见。

### 5. Good/Base/Bad Cases

Good：服务端 stop 先到，账单 pending；客户端随后超时，零费用终结、额度释放。Base：7.2 秒显示含思考的 token，完整成功后按原价一次结算。Bad：以服务端完成或厂商 latency 直接扣用户费用。

### 6. Tests Required

真实 PG：先结算后报告、timeout/missing、晚到重放、免费 pending/release/consume once、并发报告与结算；Backend apply/settle/sync pending 传播；Frontend 轻提示与安全取消。

### 7. Wrong vs Correct

Wrong：先扣款再以用户投诉判断退款。Correct：未确认可见不扣费，既有持久化账单终态防止后续补扣。

主动停止扩展（2026-10-26）：客户端明确reason，服务端策略位与取消CAS RPC裁决新手动停止user_cancelled和自动timeout；没有原价快照/未受理/预检拒绝不收费。手动停止先收口免费权益再终态解锁，钱包按日常后台结算/回捞，可选供应商统计由既有sync补，不阻塞停止。消费权益/扣费按原charge_id幂等；系统截止资格waived优先，历史取消不重价。仅客户端自称超时或省略字段不能选择免扣政策；stage=primary/fallback即使全局flag=false仍免扣。

## 可恢复交付协议 v3（2026-10-27）

本节取代旧版“当前未可见→自动取消/免单”的运行规则。后端4秒首发、2秒兜底、10秒总首字预算仍由正式配置决定；模型在预算内选中有效首字后立即放行，意图/身份持久化与传输并行，结算前必须确认。断连写入返回false，不冒充客户端已收到；断连不终止生成。

客户端v3记录真实接收/显示时间，收到后视口未显示不触发取消；hidden/page_left是观测中断，返回实际显示可更新记录且保留后台标记。前台超过预算未收到的事实锁存，不因后续可恢复而抹除。新策略拒绝旧页面的first_token_timeout取消指令；真实截止由生成服务控制，明确user_stop仍走原价一次结算。

回复恢复复用有权限的会话详情与原活动轮询。活动快照最多128轮、125秒，每轮正文256Ki字符/公开思考64Ki字符，按user/session/revision隔离；一次first_token_preview检查点最多2048字符，最终正文仍由chat_history持久化。跨实例/进程重启读取检查点和最终结果，不宣称进程内快照持久。公开思考不写入正文或后续prompt。

recoverable_delivery仅新Backend显式启用；旧请求/终结账单不回填、不追扣。离页/后台已完整保存且可取回的正常回复不免单；真实系统截止/前台无接收超时免费，主动停止原报价原权益一次。缺回报继续pending，预算+15秒仍缺报按保守免单处理，避免服务端完成先扣费而客户端随后报告失败。只有思考无完整正文不自动收费。内部billing gate复用visible返回值表示已满足该轮交付策略，并非声称用户当时正在看。

唯一新增迁移20261027_recoverable_chat_delivery.sql：experience拥有策略/首字检查点，billing资格函数读取事实；analytics只追加无正文的策略/时刻/失败锁存字段。无新cron、逐token数据库写、业务回填或公开权限。先TEST、后生产迁移、后Backend/Frontend。回退保留新增对象和终账，必要时forward-fix。

验证：本任务release-review记录自动化、真实PG、TEST流/浏览器和生产版本证据；测试通过不等于线上1%目标已达成。看板v3区分前台等待超时与系统无首字截断，显示分布只用浏览器业务侧实际时长，后台/缺报不填0。

## 短剧慢启动详情（2026-10-29，本地实现）

### 1. 范围与触发

短剧达到五秒的实际终态详情需事后查询；复用OTLP→Alloy→Cloud Loki，不新增快照、服务或Supabase分析写入。

### 2. 签名

`POST /api/telemetry/drama-timing` → `observeDramaStartupDiagnostic(report: DramaTimingReport): void` → `drama.startup_diagnostic` JSON日志正文。

### 3. 契约

仅 `type=playback`、`phase=final|network`、`elapsedMs>=5000`；出口再次strict shared校验，报告32KiB上限。ID/数组仅放正文，既有日志属性120字符限制不能承载完整诊断。沿用ENGINEERING_TELEMETRY_ENABLED/ENGINEERING_OTLP_ENDPOINT、256条队列与2秒出口预算；202仅接收，不保证Cloud落盘。接口不再调用旧Supabase分析队列/RPC，即使旧持久化flag开启；历史对象/导入器保留。

### 4. 验证与错误

缺鉴权401、未知字段400、超body413、接收限流429沿用。SDK关闭/队列满/出口失败不改变202或播放结果，失败由原工程健康指标呈现；缺报不补0。iOS媒体计时受限仍为limited，无首字节/Range头保证。

### 5. 正常与边界案例

6000ms终态完整保存，迟到network同ID补证不算第二次启动；4999ms不进入新详情流，16007ms保持实际值。没有final的network不能算成功；强退未送达仍未知。

### 6. 回归要求

扩展既有OTLP真实HTTP接收测试验证完整media/queries/marks、五秒边界、终态/网络、禁密字段、出口关闭/失败隔离；路由验证旧DB flag为true仍零RPC。保持既有鉴权/限流/容量测试。

### 7. 正误对照

错误：把JSON塞入120字符属性，或接收后仍enqueue分析DB。正确：受控完整JSON写日志body；使用正文观察ID关联，路由不构造DB队列。回退旧应用前先独立审批关闭旧DB flag，避免恢复新写入。

## 短剧请求计时

短剧路由在自身 Fastify 封装作用域记录 `drama.request_timing`（现有 requestLogger/Pino，source=backend）。短剧专用 Sentry 指标已移除，按现有 X-Request-Id 关联前端。新增鉴权 `POST /api/telemetry/drama-timing`：shared schema 校验有界客户端报告，写 `drama.frontend_timing`（source=frontend），保留 observation/list/request ID，接收请求 ID 独立为 upload_request_id；接收端无论legacy/unified或旧持久化flag都不再写分析表；达到5秒的播放final/network另经Backend OTLP写Loki。32 KiB body、12 queries/4 attempts、每用户每进程 120 次/分钟及全进程 1000 次/分钟限额，限流表最多 2000 项；202仅接收、不保证日志落盘，429 不重试。客户端自报数据不能用作计费/权限事实。onResponse 覆盖成功、鉴权拒绝、参数/不存在、查询错误、无视频和签名失败，保留 auth/db_read/assemble/sign/total 毫秒与签名缓存 hit/miss/inflight。鉴权直接发送响应时 onResponse 可能早于 preHandler finally，需要采集当前阶段已用时间。

`db_read` 是 repository 整体等待（含 PostgREST 往返），不是 SQL 独占时间。日志不得包含 object_path、签名 URL 或 Token；前端输入拒绝未知字段和任意正文。观测失败不能改变业务响应。无数据库或部署配置变更；具体口径与验证见 [短剧耗时排查](../../../../docs/drama-playback-timing.md)。

媒体启动详情通过同一 shared schema 的可选 `media` 接收并映射日志，不建新路由或数据库写入。最多 32 条有限事件、一个即时 snapshot，嵌套字段严格校验，不接收原始异常/媒体 URL/请求头。旧报告仍接受；扩展 Backend validator 必须先部署，新 Frontend 才能发送 media，否则旧 Backend 返回 400。32 KiB、限流和观测故障隔离保持原值；客户端媒体状态不能推断成服务端传输或安全事实。

## 首发明确失败立即兜底（2026-10-27）

首个可见 token 前，HTTP 非 2xx、连接/读取异常、空 EOF/DONE、流内 error、refusal 或无输出 finish_reason 立即进入同一条单次兜底流程，不等首发阈值，也不等结束帧后的连接关闭。先看到公开思考或正文则保留该模型，不混入另一模型；显式取消、全局截止和观察期限终止不触发重试。首发型号等于兜底时，明确失败允许一次顺序重试，静默等待仍不并发重发相同型号。切换清掉旧首发计时器，兜底仍受自身2秒和原总10秒预算约束。失败观测复用原 attempt；报价/权益/charge_id 沿用用户选择，成功一次结算、两次失败免扣，不新增表、统计任务或 API。验证由 first-token-fallback.test.ts 和 execute.test.ts 覆盖双平台、付费/免费及取消/期限竞态。

## 出字路径与数据库容量的发布检查

新增高频查询（包括计费门禁、幂等补偿、每轮/每秒轮询）必须在目标环境核对索引、过滤条件与 EXPLAIN，不以小 TEST 库的单测通过替代生产规模评估。按唯一身份查找不得无索引扫描大表；轮询只投影状态字段，不拉取正文或完整 prompt。容量诊断优先日志聚合、统计元数据和 EXPLAIN，禁止为了验证慢而在生产跑无界 EXPLAIN ANALYZE。

出字前每项数据库读写须说明业务必要性和依赖：权限、权益、幂等身份、可恢复报价必须保留；观测、供应商补录走异步且有限并发，独立准备可并行。新增定时任务说明窗口、频率、并发与查询计划；不允许逐 token 落表或全历史反复刷新。发布验收包含真实派发偏移和用户点击到首 token 的分布，不能用供应商 latency 代替，不以延长截止掩盖自身等待。

## 首发与兜底竞争交付（2026-10-28）

首发实际派发后达到型号阈值（默认4秒）启动兜底，首发继续；两路共用原10秒首字截止，任一路先出现有效正文或已开启公开思考即锁定唯一赢家，立即中止败方。`fallback_timeout_ms`字段保留兼容，默认2000仅作为前置过慢时提前启动兜底的预留时间，不再是兜底自身硬截止。同型号不并发重复请求，可等到总截止；首发明确失败只允许一次顺序兜底。历史阶段预算不回填，新旧策略按实际发布时刻分窗；客户端仍用v4，总耗时不相加两路并行等待。

只消费赢家的replay与原charge_id结算，原报价/权益、超时免扣、主动停止和离页恢复规则不变。败方立即取消，不为排查drain；只把已接收的正文/公开思考有界片段和race_lost原因并入原attempt一次异步终态写，不发给用户、不进上下文、不另计费。正常attempt最多派发/终态两次observe；删除旧首发额外元数据补读，无新cron/轮询。diagnostic保存不阻塞首字，赢家身份仍须持久化才能结算。

新迁移`20261028_first_token_race.sql`扩展现有attempt诊断列并解除禁止首发回赢的守卫，保留数据库单赢家CAS/PT409；Grafana仅获原指标列权限，不能读诊断正文。先本地与TEST验证、合dev，再生产迁移和应用/Admin/看板。回退应用保留诊断列与原账务，不扩权限，不改历史数据。

## Scenario: 短剧生产 CDN 对照

### 1. Scope / Trigger

普通 `/api/dramas/:id/play` 在已鉴权、剧／集归属通过后选择路径。默认关闭；生产专用源／CDN／签名配置，TEST 仍隔离。部署与实况见 [操作说明](../../../../ops/drama-cdn-rollout.md)。

### 2. Signatures

runtime-config 统一读取 DRAMA_CDN_ENABLED、DRAMA_CDN_BASE_URL、DRAMA_CDN_TOKEN_KEY、DRAMA_CDN_EXPERIMENT_ID、DRAMA_CDN_EXPERIMENT_KEY。delivery helper 纯 HMAC 稳定分桶，20% Bunny／80% Supabase；不同 HMAC 域推导实验用户去重码，仅在鉴权遥测接收端附到日志。

### 3. Contracts

shared DramaPlayback.delivery 包含实验版本、原 group、实际 provider 和 reason。timing 可选 recovery／入口总等待／seek，旧字段缺失保持 unknown；客户端不能发送身份去重键。接收接口沿用上游不写分析库；seek 只走原 Pino，不进入 startup 工程分母，不新增 DB 对象。实验核验 legacy 完整 start／结果，不能拿采样 Pino 或仅慢日志 Loki 作为总体。签名缓存按实际 provider、源、目录、签名配置与对象隔离，同 key single-flight；失败不伪造成功或自动换组。

### 4. Validation & Error Matrix

鉴权／归属失败不签名；生产源错配、凭据非法、路径／签名篡改失败闭合。关闭保留实验 ID／key，全部实例生效后新播放重新取 Supabase 地址，不能用旧缓存绕过。遥测故障不阻塞播放。

### 5. Good/Base/Bad Cases

Good：原 Bunny 分组关闭后实际 provider=Supabase，原失败仍在。Base：旧客户端无实验字段保持 unknown。Bad：把重试后短成功覆盖原失败，按会话数算独立用户，或用超时截断代替真实等待。

### 6. Tests Required

稳定分桶／多实例／关闭、环境错配、源／CDN token绑定、缓存隔离、接收端身份与白名单、seek不入startup RPC、重复／冲突／缺报比较；生产 Range／小段字节／热缓存负例和 iOS／Android 真机单独验收。

### 7. Wrong vs Correct

Wrong：全局开关直接把全部请求送 Bunny，客户端复用关闭前的预取 URL。Correct：鉴权后决定本请求路径、缓存隔离；两组每个新播放意图都确认当前路径。5秒只生成观测，保留真实结果。

Wrong：把旧单样本规则解除白名单后称为全量Bunny。Correct：固定TEST桶动态回源，不同真实对象均通过206/Range与字节核验，旧实验路径继续关闭。

Bunny动态Origin实测：`Path.1-`在保留文件名时也保留原query，不可在其后再拼`?token=`。标准归档键`videos/<video_id>/original`应使用`%{Path.1-2}/%{Url.Filename}?token=%{Query.origin_token}`，避免CDN查询混入源JWT；新路径层级需重新核验。

## 短剧统一测量v3（本地实现，待发布）

1. **Scope / Trigger**：短剧目录、首页/详情启动、阶段和诊断统一；播放控制、签名和后端计时不改。
2. **Signatures**：shared `dramaTimingStages(marks)` 返回有限stages；报告兼容增加 `definition?: drama_v3`、`route?: /|/dramas|/dramas/:id`、`purpose?: diagnostic` 和四个有限阶段字段。兼容报告version仍2。
3. **Contracts**：新tracker/日志/Faro共用阶段helper；缺失/逆序不补0，合法0保留。原elapsedMs和first_frame+playing终态不变。目录route/起点随观察绑定，background在owner内生成，不能在出口按当前路径/可见性猜测。构建SHA统一Grafana/DRAMA release。NEXT_PUBLIC_DRAMA_TIMING_MODE默认legacy；显式unified且Faro配置有效时，全量统计走Faro，100%≥5秒/非成功和5%不足5秒成功有界明细走Pino，符合条件的final/network另经Backend OTLP写Loki，专用start停发，diagnostic永不入分析库。
4. **Validation & Error Matrix**：旧报告兼容；未知definition/route/purpose和敏感嵌套字段400，超body413，限流429，Pino失败仍尝试独立Cloud出口。202仅accepted；接口、repository和历史导入器均防止diagnostic落表。Faro关闭/非法配置保留legacy，遥测故障不得改变播放。
5. **Good/Base/Bad Cases**：Good：首页启动仍归/，元数据→画面数据→首帧新段有有效N；Base：旧客户端和默认legacy继续原上报；Bad：迟到报告借当前页面归属、逆序填0、把5%日志用作总体成功率、把final与network当两次启动。
6. **Tests Required**：扩展既有shared telemetry-contract、frontend drama-timing/observer/media/grafana及backend telemetry回归；所有消费者typecheck，相关lint/build。Cloud查询可执行不等于新信号往返或真实Telegram验收；本地@drama现有场景可复用作后续重复验收，不新增临时mock体系。
7. **Wrong vs Correct**：Wrong为在SQL/前端另写新阶段计算并默认关闭旧链路；Correct为复用唯一helper，v3筛选隔离历史，Backend兼容→Frontend默认双轨→TEST/Cloud/真实流程验证→独立批准unified；接收端已按五秒长尾方案停止分析写入。旧表/视图/历史看板/保留期job本轮不删除。

字段、诊断粒度、分母和切换恢复统一见 `docs/drama-playback-timing.md`。

短剧快进诊断复用observeDramaStartupDiagnostic入口：仅新定义drama_seek_resume_v1、elapsedMs>=3000、final/network写drama.seek_diagnostic受控JSON正文，原playback>=5000不变。出口再strict校验且限制32KiB，沿用有界OTLP队列/超时；媒体URL、签名和请求头不进入正文，ID/数组不成为labels。仍不写分析库、不新增接口或配置；network仅补证，不能当第二次快进。Backend兼容先发，Frontend后发；现有真实本机OTLP接收测试覆盖3000边界、受限字段和重复投影隔离。
