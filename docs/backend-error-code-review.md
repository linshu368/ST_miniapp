# Backend 全局错误码评审清单

评审稿 v1 · 2026-11-12

**用途**：逐模块检查错误场景是否遗漏，确认返回状态、处理动作和日志等级。

2026-11-12 用户指定本清单作为全局错误码设计依据；[技术设计](backend-error-code-design.md) 和任务迁移矩阵据此维护，不建立平行错误目录。本文“通知/报警/紧急通知”均指候选日志告警动作，受环境变量 LOG_ALERTING_ENABLED 控制，默认 false，ERROR/FATAL 不绕过开关；全量记录、安全退出、独立健康信号与既有业务告警保持原有职责。整体实施仍待规划审批，评审勾选不因文档对齐自动完成。

**标记**：〔现有〕表示源码已有该码或分类；〔新增〕表示拟增加；〔调整〕表示现有码需要拆分、归并或修改状态。以下 HTTP 状态和日志等级为本次方案建议，现状差异集中列在第 13 节。整体审批后实施。

**每项读法**：错误码 · HTTP 状态 · 日志等级 — 什么时候出现；怎么处理。同一条列出多个码时，它们共享该行状态和处理原则。通用码通过 module、operation 和安全 reason 定位具体功能，避免为每个接口重复定义同义码。

## 1. 日志等级与处理状态

- **INFO** — 成功、正常业务拒绝、资源不存在、余额不足、已处理的重复请求、用户主动取消。全量记录。
- **WARN** — 身份校验失败、限流、并发冲突、一次可恢复的依赖失败、降级、结果暂时未知。全量记录。
- **ERROR** — 操作最终技术失败、错误配置、数据库异常、支付金额或归属异常、恢复失败、基础日志丢失。全量记录并进入异常处理。
- **FATAL** — 进程无法启动或已无法安全继续运行。记录、紧急通知并按进程策略退出。
- **DEBUG / TRACE** — 额外诊断详情。允许采样或关闭，基础链路记录继续全量输出。

**Sentry 建议**：ERROR/FATAL 在负责终态的边界捕获一次 Issue；INFO 不建 Issue；WARN 默认保留日志，重复故障或安全异常达到阈值再告警。重试中的同一技术失败可记 WARN，最终耗尽记 ERROR，保留全部 attempt。告警通知允许聚合，原始基础记录全量保留。日志系统自己的输出故障使用独立健康通道，避免递归上报。

**操作结果统一使用以下状态**：

- `succeeded` 成功；`rejected` 预期业务拒绝。
- `failed` 已确认技术失败；`timed_out` 等待超时。
- `cancelled` 主动取消；`interrupted` 连接或进程中断。
- `degraded` 已采用降级；`skipped` 按规则跳过。
- `unknown` 无法确认是否成功或提交，需查询或对账。
- `pending` 尚在处理，为中间状态。

普通 4xx 默认 rejected，普通 5xx 默认 failed。超时另记 timed_out；写入是否已提交用 outcome_known 标明，未知时关联后续恢复。后台操作 HTTP 留空。错误码、HTTP 状态、业务状态和日志级别各自记录，不互相推断。

## 2. 全局请求、鉴权与权限

**涉及模块**：全部 API、Telegram 鉴权、Admin 会话、Bot/客服鉴权、CORS。

- 〔现有〕`BAD_REQUEST` · 400 · INFO — 参数格式错误；提示修改参数。
- 〔现有〕`MISSING_FIELDS` · 400 · INFO — 缺少必填内容；提示补齐。
- 〔新增〕`REQUEST_BODY_TOO_LARGE` · 413 · INFO — 请求体超限；缩小文件或内容。
- 〔新增〕`UNSUPPORTED_MEDIA_TYPE` · 415 · INFO — 请求格式不支持；使用支持的格式。
- 〔新增〕`REQUEST_READ_TIMEOUT` · 408 · WARN — 读取客户端请求超时；结束请求，允许重新发起安全操作。
- 〔现有〕`UNAUTHORIZED` · 401 · WARN — 身份凭据缺失、无效或过期；重新登录/打开小程序。内部 reason 区分原因。
- 〔现有〕`FORBIDDEN` · 403 · WARN — 已识别身份但无角色、环境或操作权限；拒绝操作。
- 〔新增〕`ORIGIN_NOT_ALLOWED` · 403 · WARN — 请求来源不允许；拒绝，核对来源配置。当前使用 FORBIDDEN。
- 〔现有〕`NOT_FOUND` · 404 · INFO — 资源不存在或按权限策略隐藏；提示刷新/返回列表。
- 〔新增〕`ROUTE_NOT_FOUND` · 404 · INFO — 接口路径不存在；核对客户端版本和路径。
- 〔现有〕`CONFLICT` · 409 · WARN — 当前状态或版本冲突；重新读取后操作。
- 〔现有〕`RATE_LIMITED` · 429 · WARN — 本服务限制调用频率；按允许时间重试。
- 〔现有〕`SERVICE_UNAVAILABLE` · 503 · ERROR — 已确认服务暂不可用；保留原因，提示稍后重试。
- 〔现有〕`INTERNAL_ERROR` · 500 · ERROR — 未预期异常；返回安全文案，按链路排查。
- 〔新增〕`CONFIGURATION_ERROR` · 500 · ERROR — 运行中发现服务端配置缺失/非法；修正配置，停止该项操作。阻止进程启动时使用第 11 节的启动错误。

认证依赖网络/数据库失败按第 9 节处理。用户凭据失效和服务端鉴权配置错误分别归类。

## 3. 角色、大厅、社交、心愿墙与创作者

**涉及模块**：角色详情/列表、推荐、收藏、点赞/评论、心愿墙、创作者作品、封面、发布、润色、数据统计与公开空间。

- 〔现有〕`INVALID_CHARACTER`、`INVALID_CHARACTER_ID` · 400 · INFO — 角色标识无效；重新选择角色。
- 〔现有〕`CHARACTER_NOT_FOUND`、`character_not_found` · 404 · INFO — 角色不存在或当前不可见；返回列表。迁移期兼容两种拼写。
- 〔现有〕`CREATOR_REVIEW_REJECTED` · 422 · INFO — 内容审核拒绝；按安全原因修改内容。当前直接发布流程之外的审核入口仍需登记。
- 〔现有〕`CREATOR_REVIEW_UNAVAILABLE` · 503 · ERROR — 审核服务不可用；保留草稿，稍后再试。
- 〔现有〕`CREATOR_TOOL_UNAVAILABLE` · 503 · ERROR — 封面/润色服务暂不可用；保留原稿。已开流时使用第 12 节规则。
- 〔调整〕`FAVORITE_UPDATE_FAILED` — 按真实 DB/内部原因映射第 9 节；旧码仅作兼容字段，用户刷新收藏状态后再操作。
- 〔新增〕`WISH_LINK_FAILED` · 无独立 HTTP · WARN — 角色已发布，但关联心愿失败；保留成功发布，记录 degraded 和 not_linked，支持单独重试关联。

大厅、评论、心愿、公开空间、创作者统计共用第 2 节的参数、权限、404、冲突和限流码，技术故障使用第 9 节。日志 module/operation 区分推荐读取、曝光、点赞、回应、统计等操作。

## 4. 会话、回复编辑与反馈

**涉及模块**：开会话、消息生成、重生成、分支、点赞/点踩、编辑/删除、取消、SSE。

- 〔现有〕`session_not_found` · 404 · INFO — 会话不存在或不可访问；返回列表。
- 〔现有〕`session_busy` · 409 · WARN — 当前会话仍有未完成回复；等待或取消当前回复。
- 〔现有〕`regenerate_not_allowed` · 409 · INFO — 当前轮不满足重生成条件；刷新并操作允许的回复。
- 〔现有〕`branch_not_allowed` · 409 · INFO — 当前内容不能创建分支；刷新状态。
- 〔现有〕`branch_request_conflict` · 409 · WARN — 分支请求状态变化；读取最新状态后重试。
- 〔现有〕`branch_rate_limited` · 429 · WARN — 分支创建过于频繁；稍后操作。
- 〔现有〕`reply_like_not_allowed` · 409 · INFO — 回复状态不允许点赞；刷新。
- 〔现有〕`message_change_not_allowed` · 409 · INFO — 消息超出允许修改范围或状态不符；提示可修改范围。
- 〔现有〕`message_change_conflict` · 409 · WARN — 消息版本已变化；重新读取。
- 〔现有〕`REPLY_CHANGED` · 409 · WARN — 反馈目标回复已变化；重新选择回复。
- 〔现有〕`CANCEL_PENDING` · 409 · INFO — 取消仍在收敛；查询现有回复状态，避免重复生成。

正常停止为 cancelled/INFO，断流为 interrupted/WARN；如果确认为服务端异常，再附具体 ERROR 原因。正常生成完成为 succeeded/INFO。

## 5. 模型与第三方生成

**涉及模块**：generation、模型目录/切换、聊天首字与流、图片生成、语音写稿/合成、创作者润色/审核、长期记忆压缩。供应商包含 OpenRouter、Venice、SurplusIntelligence、DeepSeek、MiniMax 及实际启用的图片供应商。

- 〔现有〕`INVALID_MODEL`、`INVALID_PROVIDER` · 400 · INFO — 客户端选择无效；重新选择。
- 〔调整〕`MODEL_UNAVAILABLE` · 409 · INFO — 模型下架或不支持当前操作；刷新目录、换模型。配置故障另归 CONFIGURATION_ERROR。
- 〔现有分类〕`NO_LIGHT_MODEL` · 503 · ERROR — 当前权益找不到可用的轻量模型；检查目录与权益配置。
- 〔现有分类〕`INVALID_PRICE` · 500 · ERROR — 价格配置非法；停止生成/计费，修正配置。
- 〔新增〕`GENERATION_UPSTREAM_FAILURE` · 502 · ERROR — 供应商网络失败或服务错误；只走业务已允许的有限兜底。
- 〔新增〕`GENERATION_UPSTREAM_INVALID_RESPONSE` · 502 · ERROR — 响应结构错误、空输出或异常结束；记录供应商与阶段，按原规则兜底。
- 〔新增〕`GENERATION_PROVIDER_AUTH_FAILED` · 500 · ERROR — 服务端供应商凭据被拒；检查配置与账号。
- 〔新增〕`GENERATION_PROVIDER_QUOTA_EXHAUSTED` · 503 · ERROR — 供应商余额/共享额度耗尽；按允许规则换供应商并通知运营。
- 〔新增〕`GENERATION_PROVIDER_RATE_LIMITED` · 503 · ERROR — 供应商限制共享调用量；尊重限流信息，有限退避/兜底。
- 〔新增〕`GENERATION_CONTENT_REJECTED` · 422 · INFO — 明确识别为内容策略拒绝；提示修改内容，处理已预留权益。
- 〔新增〕`GENERATION_UPSTREAM_TIMEOUT` · 504 · ERROR — 依赖等待超过预算；取消本次等待，按既有恢复和计费规则收敛。
- 〔现有〕`first_token_timeout`、`primary_first_token_timeout`、`fallback_first_token_timeout` · 504 · ERROR — 首字或指定尝试超时；保留阶段与各 attempt。
- 〔调整〕`upstream_error`、`UPSTREAM_ERROR`、`UPSTREAM` — 现有通用码按上述原因拆分；兼容原公开值，日志写明确规范码。
- 〔新增〕`GENERATION_SETTLEMENT_FAILED` · 500 · ERROR — 生成后结算失败；记录已交付/已扣款事实，走既有补偿。
- 〔新增〕`GENERATION_SETTLEMENT_UNKNOWN` · 无新增响应 · WARN — 结算调用结束但无法确认提交；按原幂等键查询/恢复，达到恢复期限后 ERROR 告警。

以上状态适用于尚可返回错误的 HTTP 入口。首个失败 attempt 已兜底恢复时记 WARN，父操作成功或 degraded。竞争败方记 cancelled/INFO。已开 SSE、已交付内容或后台生成按第 12 节保留实际响应。

## 6. 钱包、VIP、免费额度与签到

**涉及模块**：钱包、权益、模型计费、图片/语音试用、签到、邀请奖励、创作者奖励。

- 〔现有〕`insufficient_balance` · 402 · INFO — 余额不足；提示充值或选择可用权益。
- 〔调整〕`INSUFFICIENT_BALANCE` · 402 · INFO — 图片广场余额不足；与上述语义统一，现状为 409。
- 〔现有〕`MAIN_CREDITS_INSUFFICIENT` · 402 · INFO — 主积分不足；按该模型积分规则提示。
- 〔现有〕`TOTAL_CREDITS_INSUFFICIENT` · 402 · INFO — 可用总积分不足；充值或换模型。
- 〔现有〕`VIP_REQUIRED` · 403 · INFO — 缺少有效 VIP 权益；提示开通或选择允许功能。
- 〔现有〕`VIP_STATUS_UNAVAILABLE` · 503 · ERROR — 权益暂时查不清；暂停本次受权益限制的操作。
- 〔现有〕`CHECKIN_NOT_READY` · 409 · INFO — 未到可签到时间；显示可用时间。
- 〔现有〕`VIP_ENTRY_VIEW_FAILED` · 500 · ERROR — VIP 入口记录失败；保留页面业务结果，按当前接口边界响应。
- 〔现有分类〕`FEATURE_FREE_TRIAL_EXHAUSTED` · 无固定 HTTP · INFO — 免费次数用尽；现有流程可转付费判断，最终由权益/余额结果决定。
- 〔现有〕`FEATURE_FREE_TRIAL_CONFLICT` · 409 · WARN — 同一额度预留冲突；查询已有预留，避免重复占用。
- 〔调整〕`FEATURE_FREE_TRIAL_INVALID_STATE` · 409 · WARN — 已知过期/回收后的状态冲突；刷新。无法解释的缺失/损坏状态映射下面的账务异常。
- 〔新增〕`BILLING_STATE_INVALID` · 500 · ERROR — 钱包、预留或奖励状态违反业务不变量；停止该项写入并排查。
- 〔新增〕`BILLING_WRITE_UNKNOWN` · 无固定 HTTP · WARN — 扣费/奖励写入结果未知；原幂等键查询和补偿，超期升级 ERROR。
- 〔新增〕`REWARD_DELIVERY_FAILED` · 无固定 HTTP · ERROR — 奖励发放或补偿最终失败；保留主交易状态，按原奖励业务键恢复。

“已扣费”“已领取”“已履约”的正常幂等重放为 succeeded/INFO，禁止再次扣费或发奖。

## 7. 支付商户、订单与回调

**涉及模块**：套餐、建单、商户网关、前端查单、回跳、TTZF 易支付通知、结算、过期与对账任务。其他商户后续复用同样分类，日志 provider 区分。

### 建单与查单

- 〔现有〕`PAYMENT_PLANS_UNAVAILABLE` · 503 · ERROR — 套餐暂不可用；停止建单，重新读取。
- 〔新增〕`PAYMENT_ORDER_NOT_FOUND` · 404 · INFO — 用户查询订单不存在/不可访问；当前 NOT_FOUND 兼容。
- 〔新增〕`PAYMENT_CONFIGURATION_ERROR` · 500 · ERROR — 商户配置、凭据或签名配置非法；停止该渠道建单并修复。
- 〔新增〕`PAYMENT_METHOD_UNAVAILABLE` · 503 · WARN — 商户明确维护该支付方式；提示换渠道。
- 〔新增〕`PAYMENT_PROVIDER_RATE_LIMITED` · 503 · WARN — 商户共享限流；稍后查单，建单重试需确认幂等。
- 〔新增〕`PAYMENT_PROVIDER_UNAVAILABLE` · 503 · ERROR — 商户服务不可用；提示稍后处理。
- 〔新增〕`PAYMENT_PROVIDER_REJECTED` · 502 · ERROR — 商户拒单且无法归类；保存受控厂商码。明确由用户输入引起时映射 BAD_REQUEST。
- 〔新增〕`PAYMENT_PROVIDER_INVALID_RESPONSE` · 502 · ERROR — 商户响应缺字段/格式错误；记录结果是否未知。
- 〔新增〕`PAYMENT_PROVIDER_NETWORK_ERROR` · 502 · ERROR — 商户网络异常；可能已建单时先查原订单。
- 〔新增〕`PAYMENT_PROVIDER_TIMEOUT` · 504 · ERROR — 商户超时；用户查看原订单，后台查回，避免再次付款。
- 〔新增〕`PAYMENT_CHANNEL_MISMATCH` · 409 · INFO — 旧渠道订单不适用于当前网关；跳过错误渠道查询。
- 〔新增〕`PAYMENT_REFERENCE_MISSING` · 500 · ERROR — 当前渠道订单缺少内部必需关联；核查持久化并尝试已有商户单号查回。
- 〔调整〕`PAYMENT_CREATE_FAILED` — 将现有兜底 400 拆成以上明确原因；旧码只保留兼容映射。

### 回调与结算

以下新增码用于内部统一日志；对商户继续使用实际纯文本 ACK。括号内为当前源码返回。

- 〔新增〕`PAYMENT_CALLBACK_INVALID_BODY` · 400 / fail · INFO — 回调格式无效；拒绝。
- 〔新增〕`PAYMENT_CALLBACK_VERIFICATION_FAILED` · 401 / fail · WARN — 验签/商户身份等校验失败；拒绝，异常频率报警。
- 〔新增〕`PAYMENT_CALLBACK_ORDER_NOT_FOUND` · 404 / fail · WARN — 回调找不到订单；核对环境、订单来源，交对账处理。
- 〔新增〕`PAYMENT_PROVIDER_REF_MISMATCH` · 409 / fail · ERROR — 通知中的渠道/交易号与订单冲突；停止本次入账，人工核对。内部结算路径同类失败当前可能回 500，需收口。
- 〔新增〕`PAYMENT_AMOUNT_MISMATCH` · 409 / fail · ERROR — 已验签金额与订单不符；停止本次入账，人工核对。
- 〔新增〕`PAYMENT_SETTLEMENT_FAILED` · 500 / fail · ERROR — 结算流程失败；核对实际入账进度，按幂等键恢复。
- 〔新增〕`PAYMENT_SETTLEMENT_UNKNOWN` · 无新增 ACK · WARN — 入账是否提交未确认；沿原订单查询，恢复超期后 ERROR。
- 〔新增〕`PAYMENT_REFUND_REPORTED` · 200 / success · WARN — 商户通知退款；记录退款事实并核对履约，现有 ACK 本身不代表本系统已完成退款。
- 〔新增〕`PAYMENT_PROVIDER_TRADE_FAILED` · 200 / success · INFO — 商户交易失败通知已接收；记录未支付状态。
- 〔新增〕`PAYMENT_NOTIFICATION_FAILED` · 无独立 HTTP · WARN — 入账后用户通知失败；保留入账成功，按已有通知恢复机制处理。

重复成功回调、暂未支付通知、过期订单后来确认已支付，都要记录实际业务过程。正常重复回调为 200/success、succeeded/INFO。对账失败可保留用户订单查询 200，子操作写真实错误。回跳查单失败可保留 302 跳转，子操作记录 degraded。

## 8. 图片、语音、短剧与存储

**涉及模块**：聊天图片、图片广场、语音设置/生成、短剧列表/详情/播放、CDN、封面和运营素材上传。

- 〔现有〕`INVALID_IMAGE` · 400 · INFO — 图片参数或内容格式非法；重新选择。
- 〔现有〕`IMAGE_CHARACTER_UNAVAILABLE` · 422 · INFO — 角色缺少出图设定；提示切换角色或补齐。
- 〔现有〕`IMAGE_DESCRIPTION_FAILED` · 422 · INFO — 未得到符合要求的画面描述；修改描述再试。已识别的网络、超时和响应协议错误使用第 5 节专有码。
- 〔现有〕`IMAGE_UNAVAILABLE`、`IMAGE_PLAZA_UNAVAILABLE`、`VOICE_UNAVAILABLE` · 503 · ERROR — 对应功能暂不可用；保留已存在的任务。
- 〔现有常量〕`IMAGE_PLAZA_INVALID_CURSOR` · 400 · INFO — 广场分页游标失效；从首屏刷新。按 shared 常量值作为公开码。
- 〔现有〕`REQUEST_REJECTED` · 409 · INFO — 图片请求关联状态变化；刷新后重新操作。
- 〔新增〕`MEDIA_JOB_NOT_FOUND` · 404 · INFO — 图片/语音任务不存在或不可访问；结束轮询。
- 〔新增〕`MEDIA_JOB_BUSY` · 409 · WARN — 同一内容已有进行中任务；复用已有任务。
- 〔新增〕`DRAMA_EPISODE_NOT_FOUND` · 404 · INFO — 剧或集不存在；刷新剧集列表。
- 〔新增〕`MEDIA_SOURCE_UNAVAILABLE` · 503 · ERROR — 配置的媒体源暂不可用；沿既有播放策略处理。
- 〔新增〕`MEDIA_SIGNING_FAILED` · 500 · ERROR — 签名或源配置错误；修复配置，避免返回无效播放地址。
- 〔新增〕`STORAGE_UPLOAD_FAILED` · 502 · ERROR — 存储上传失败；确认对象状态后决定重试。
- 〔新增〕`STORAGE_READ_FAILED` · 502 · ERROR — 存储读取失败；重新请求安全的读取操作。
- 〔新增〕`STORAGE_TIMEOUT` · 504 · ERROR — 存储等待超时；写入需核对实际结果。
- 〔新增〕`STORAGE_CONFIGURATION_ERROR` · 500 · ERROR — bucket、权限或服务配置错误；修复服务配置。

任务查询成功但任务本身失败时，HTTP 可为 200，任务的 error_code/status 单独记录。正常排队为 pending/INFO。媒体 206、签名链接和客户端 Range 按原协议处理，日志只记录安全摘要。

## 9. 数据库与共用外部依赖

**涉及模块**：Supabase/PostgREST/RPC/Auth、Prisma/pg、所有 repository、Telegram、客服、CDN 及告警发送。

- 〔新增〕`DATABASE_UNAVAILABLE` · 503 · ERROR — 数据库/连接池暂不可用；只重试允许的操作。
- 〔新增〕`DATABASE_TIMEOUT` · 504 · ERROR — 数据库操作超时；写入结果不明时先核对。
- 〔新增〕`DATABASE_CONTRACT_ERROR` · 500 · ERROR — 表、字段、RPC、返回结构与应用约定不符；核对部署/迁移版本。
- 〔新增〕`DATABASE_PERMISSION_ERROR` · 500 · ERROR — 后端数据库身份/权限配置错误；检查权限。明确的终端用户授权拒绝用 FORBIDDEN。
- 〔新增〕`DATABASE_TRANSACTION_RETRY_EXHAUSTED` · 503 · ERROR — 死锁/序列化冲突重试耗尽；确认事务回滚，仅安全重试。
- 〔新增〕`DATABASE_INTEGRITY_ERROR` · 500 · ERROR — 非预期约束或数据不一致；停止该项写入并排查。
- 〔新增〕`DATABASE_WRITE_UNKNOWN` · 无固定 HTTP · WARN — 客户端中断后提交情况未知；按业务键查询，超期升级 ERROR。
- 〔新增〕`DEPENDENCY_NETWORK_ERROR` · 502 · ERROR — 共用外部服务网络错误；安全操作有限重试。
- 〔新增〕`DEPENDENCY_INVALID_RESPONSE` · 502 · ERROR — 外部服务返回无效数据；保留受控厂商码，排查协议。
- 〔新增〕`DEPENDENCY_TIMEOUT` · 504 · ERROR — 共用依赖超时；取消等待并按业务收敛。
- 〔新增〕`DEPENDENCY_UNAVAILABLE` · 503 · ERROR — 共用依赖明确暂不可用；按已有降级策略处理。
- 〔新增〕`DEPENDENCY_AUTH_FAILED` · 500 · ERROR — 本服务使用的外部凭据被拒；检查配置。

已知唯一键冲突、业务 RPC 拒绝映射对应业务码。PGRST116 要区分空结果和多行；P0002、23505、42501 等必须结合具体 RPC/约束/调用身份判断。技术码保留在安全内部字段，不直接当作用户业务码。

## 10. 运营平台、文本后处理与其他功能

### 文本后处理

**涉及模块**：规则编辑、校验、草稿、发布、回滚、版本批量读取和校验 worker。

- 〔现有〕`invalid_source`、`invalid_draft`、`compile_rejected` · 400 · INFO — 输入或规则校验不通过；按诊断修改。
- 〔现有〕`cas_conflict`、`request_id_conflict`、`draft_revision_mismatch` · 409 · WARN — 草稿/版本/幂等请求内容冲突；重读后确认。
- 〔现有〕`target_version_unavailable` · 404 · INFO — 回滚或读取的版本不可用；选择有效版本。
- 〔现有〕`policy_unsupported` · 422 · INFO — 快照策略不支持；升级或修正规则。
- 〔现有〕`forbidden` · 403 · WARN — 缺少运营权限；拒绝。
- 〔调整〕`TEXT_POSTPROCESS_FAILED` — 按 DB、内部异常或下面的 worker 故障分类；旧码兼容。
- 〔新增〕`TEXT_VALIDATION_TIMEOUT` · 504 · ERROR — 校验 worker 超时；停止本次校验，保留草稿。
- 〔新增〕`TEXT_VALIDATION_WORKER_FAILED` · 500 · ERROR — worker 崩溃或返回非法结构；保留草稿并排查。

### 模型连通性测试与代理

- 〔现有〕`MODEL_TEST_NETWORK_ERROR` · 502 · WARN — 运营主动测试网络失败；检查测试地址与网络。
- 〔新增〕`MODEL_TEST_TIMEOUT` · 504 · WARN — 主动测试超时；从现有 network error 拆出。
- 〔现有〕`MODEL_TEST_UPSTREAM_ERROR` · 502 · WARN — 测试供应商明确拒绝；显示脱敏诊断，检查待配置的模型和凭据。
- 〔现有〕`MODEL_TEST_BAD_RESPONSE` · 502 · WARN — 测试响应不符合协议；核对供应商兼容性。
- 〔现有〕`MODEL_TEST_INTERNAL_ERROR` · 500 · ERROR — 测试功能自身异常；工程排查。
- 〔新增〕`ADMIN_PROXY_PATH_NOT_ALLOWED` · 404 · WARN — 请求不属于允许代理的路径；拒绝。
- 〔新增〕`ADMIN_PROXY_UNAVAILABLE` · 502 · ERROR — 代理连接失败；检查 Supabase。配置缺失另用 CONFIGURATION_ERROR。
- 〔新增〕`ADMIN_PROXY_TIMEOUT` · 504 · ERROR — 代理依赖等待超时；结束代理调用。

Admin Supabase 透传保留其原响应和状态，日志另记规范原因。运营托管配置的数据库 RPC/CLI 原有 draft_exists、conflict 等兼容协议单独核对，不将代理内容强制改成 Backend envelope。

### 通知、邀请、增长、客服、社区和引导

- 〔现有〕`INVALID_NOTIFICATION_ID`、`INVALID_READ_TARGET`、`INVALID_SCOPE` · 400 · INFO — 通知参数或范围错误；重新选择。
- 〔现有〕`NOTIFICATION_NOT_FOUND` · 404 · INFO — 通知不存在；刷新列表。
- 〔现有〕`INVALID_MESSAGE` · 400 · INFO — 客服消息或请求标识无效；修正后发送。
- 〔现有〕`ONBOARDING_UNAVAILABLE` · 503 · ERROR — 引导状态暂不可读；沿已有页面降级策略处理。
- 〔调整〕`INTERNAL` → `INTERNAL_ERROR` · 500 · ERROR — 社区/邀请内部异常；统一名称。
- 〔调整〕`UNAVAILABLE` → `SERVICE_UNAVAILABLE` · 503 · ERROR — 社区暂不可用；统一名称。
- 〔新增〕`INVITE_BINDING_CONFLICT` · 409 · INFO — 邀请关系不满足当前绑定条件；显示实际绑定状态。需按 RPC 结果明确细分。
- 〔新增〕`NOTIFICATION_DELIVERY_FAILED` · 无固定 HTTP · WARN — 主业务完成后通知失败；关联原操作，按既有机制恢复。
- 〔新增〕`SUPPORT_FORWARD_FAILED` · 502 · ERROR — 客服转发最终失败；保留原消息标识，重试需去重。
- 〔新增〕`TELEGRAM_DELIVERY_FAILED` · 502 · ERROR — Telegram 发送最终失败；按平台可重试分类处理。

外部限流、凭据失效、超时等使用第 9 节专有码；邀请/增长/通知的普通读取与写入使用通用码和 module/operation 定位。

## 11. 后台任务、恢复与日志系统自身

**涉及模块**：聊天历史同步、图片任务、长期记忆、推荐刷新、VIP 提醒、支付探测/对账/过期、告警、独立脚本、日志插件和进程。

下列均为〔新增〕内部规范码，HTTP 留空。

- `JOB_EXECUTION_FAILED` · ERROR — 一次任务最终失败；保留任务/批次 ID，按已有安全重试规则恢复。
- `JOB_TIMEOUT` · ERROR — 任务超出截止时间；取消可取消的工作，确认写入结果。
- `JOB_INTERRUPTED` · WARN — 进程或 worker 中断；记录最后进度，重启后核对恢复。
- `RECOVERY_EXHAUSTED` · ERROR — 补偿/对账达到次数或时间上限；交人工处理，禁止无限重试。
- `ALERT_DELIVERY_FAILED` · ERROR — 告警发送最终失败；使用独立健康信号报告，避免告警递归。
- `LOG_EXPORT_FAILED` · WARN — 某输出暂不可用但基础记录仍被可靠保存；有限重试和补传。
- `LOG_BUFFER_NEAR_LIMIT` · WARN — 基础日志缓冲接近容量；降低额外诊断、通知扩容。
- `LOG_RECORD_LOST` · ERROR — 基础记录已确认丢失；独立报警，记录丢失数量及范围，阻断发布。
- `TRACE_TERMINAL_MISSING` · ERROR — 已开始链路超过约定时间仍无终态；先核对慢任务/延迟投递/中断，不能推定业务失败。
- `LOG_SCHEMA_INVALID` · ERROR — 事件字段非法；保留最小安全记录，排查产生位置。
- `LOG_SENSITIVE_FIELD_BLOCKED` · WARN — 字段安全检查拦截违规内容；只记录字段名和调用位置。
- `STARTUP_FAILED` · FATAL — 服务启动失败；记录安全配置摘要并退出。
- `PROCESS_UNRECOVERABLE` · FATAL — 进程无法安全继续；有界收尾后退出。

任务锁已被其他实例持有、没有待处理数据、未到执行时间都为 skipped/INFO。循环内高频过程只增加计数，各独立业务操作仍保留基础终态。

## 12. 容易误判的状态

- **真实资源不存在** — HTTP 404，rejected/INFO。日志 http_status 也写 404。
- **缺少数据库表/RPC** — 内部部署故障，通常 500/ERROR。
- **SSE 发出 200 后生成失败** — HTTP 保持实际 200，流内错误码和 operation outcome 记录失败。
- **已生成但计费/通知失败** — 分别记录交付、结算和通知的真实结果，父操作按原协议返回。
- **用户断开连接** — 未发送响应时 HTTP 留空，interrupted/WARN；记录最后阶段。
- **依赖超时但可能已写入** — 记录超时与提交结果未知，查询原业务键；禁止直接重复建单/扣费。
- **支付回调 ACK 成功** — 表示回调已接收，交易/退款/履约状态另记。
- **代理透传错误** — 保留代理实际返回状态，内部原因单独记录。
- **进程被强制终止** — 通过开始记录发现缺失终态，恢复事件标记中断/未知。
- **正常成功链路** — 同样全量记录基础终态，保持可检索。

## 13. 现状中需要重点评审的差异

- 支付建单现有 PAYMENT_CREATE_FAILED 多数返回 400，需要按商户、网络、超时、配置和业务原因拆分。
- upstream_error 当前用于 502 和 504，需要拆出超时。
- MODEL_UNAVAILABLE 在模型切换接口为 400，在图片广场为 409，拟统一资源状态变化为 409。
- 图片广场 INSUFFICIENT_BALANCE 为 409，会话余额不足为 402，拟统一余额语义为 402。
- 鉴权中间件部分响应没有 code，配置缺失也可能被统一转成 401，需要分开。
- Admin 认证查询故障可能归为 401/403，需要区分无权限与身份依赖故障。
- 运营素材上传/代理部分直接返回 message，需补内部规范码并保持消费者兼容。
- 运营模型测试将超时归到 502/MODEL_TEST_NETWORK_ERROR，拟拆成 504。
- 图片描述目前以 422/IMAGE_DESCRIPTION_FAILED 兜底，需要分清业务内容不适用与技术失败。
- 支付交易号冲突有 409 和 500 两条路径，需依据发生阶段收口。
- FEATURE_FREE_TRIAL_INVALID_STATE 同时可能表示正常预留失效与内部状态损坏，需要区分。
- INTERNAL、UPSTREAM、UNAVAILABLE、FAVORITE_UPDATE_FAILED、TEXT_POSTPROCESS_FAILED 等通用兜底需要明确原因。
- 第 2—11 节的新增码、日志等级和处理策略均待评审，旧公开码按消费者兼容计划迁移。

## 14. 评审勾选

- [ ] 所有业务模块都有对应错误与正常终态。
- [ ] 资源不存在、权限、余额、冲突、限流没有被误报成内部异常。
- [ ] DB/供应商/商户故障没有被误报成用户参数或登录错误。
- [ ] 所有会产生资金或权益写入的操作覆盖结果未知、幂等与恢复超期。
- [ ] SSE、媒体任务、支付 ACK、代理、后台任务的实际状态能准确表达。
- [ ] 日志等级、Sentry Issue 与报警规则合理，基础记录全部可检索。
- [ ] 新操作使用通用目录或登记专有码即可接入，日志输出策略集中配置。
- [ ] 旧客户端、运营 CLI 与现有错误码兼容方式可接受。
- [ ] 同意第 13 节的状态调整方向，或逐项填写修改意见。

## 依据与覆盖边界

本清单依据当前 checkout 的路由、shared 契约、会话/文本后处理错误映射、鉴权、支付网关/回调/结算和免费额度实现。它用于评审目标方案，线上实际配置与运行状态需在目标环境核验。数据库 RPC 动态返回、供应商专有原始码和独立客服服务内部错误仍需在实施矩阵中逐项补齐；第三方原始码作为字段保留，映射到本目录的稳定分类。

- [完整技术设计](backend-logging-design.md)
- [源码错误码索引](backend-error-code-design.md)
- [会话错误映射](../packages/backend/src/features/conversations/errors.ts)
- [文本后处理错误映射](../packages/backend/src/features/text-postprocess/errors.ts)
- [支付网关分类](../packages/backend/src/infrastructure/payment/PaymentGateway.ts)
- [支付回调](../packages/backend/src/features/payment/usecases/EpayNotification.ts)
- [支付结算](../packages/backend/src/features/payment/usecases/PaymentSettlement.ts)
- [鉴权中间件](../packages/backend/src/middleware/auth.ts)
- [运营鉴权](../packages/backend/src/features/admin-access/session.ts)
- [运营代理与模型测试](../packages/backend/src/routes/admin-supabase-proxy.ts)
