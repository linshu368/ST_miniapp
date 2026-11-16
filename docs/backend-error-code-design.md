# Backend 错误码与协议映射

2026-11-13 用户批准按模块兼容迁移。日志输出由 Railway 捕获，无额外存储；告警关闭不处理，开启按事件配置触发，不新增窗口聚合或重放。历史稿中相关复杂投递要求以当前任务 PRD 为准，错误语义与消费者验收仍适用。

评审稿 · 2026-11-12

根据用户 2026-11-12 指示，全局错误码设计以 [全局错误码评审清单](backend-error-code-review.md) 为依据：第 1 节定义日志等级与操作状态，第 2—11 节定义模块错误目录，第 12 节定义协议例外，第 13 节列出迁移差异，第 14 节用于验收核对。本文负责契约落地、映射与兼容迁移，不另建平行候选目录；发生冲突时按评审清单修订本文。该指示确认设计依据，不代表整体实施已审批，清单中的“现有/新增/调整”仍须与源码及消费者逐项核对。

生产基础链路记录全量保留。每个业务拒绝、依赖失败、重试 attempt 和最终响应均关联到操作与请求 ID；成功和恢复后的链路也保留终态。Sentry Issue 的选路与采样不影响基础记录覆盖。

## 契约与单一来源

公开错误码在 shared/src/api 定义。每个规范码登记领域、适用场景、默认 HTTP/日志等级、安全文案、恢复方式与协议例外；HTTP 与等级不是不分场景的固定一对一映射。仅供后台/观测的内部分类留在 backend，确有跨应用消费者时才进入 shared。复用 ApiErrorResponse 的 `success: false, error: { code, message }`。先兼容既有大小写和前端特判。已有同码跨状态的端点登记兼容映射，日志同时写规范码和实际公开码。

业务错误、依赖适配器携带类型与 cause。全局错误处理和显式业务拒绝使用同一映射，覆盖框架解析/校验/大小限制、未知路由和异常。只识别已注册业务错误或已知框架错误，未知异常回 500 和安全文案。终态取实际发送的 HTTP 状态，依赖状态用独立字段。流开出 200 后的业务失败记录 SSE 终态和错误码，保留 HTTP 200；没有发送响应的断连用独立 outcome。

## 当前证据

- [支付建单](../packages/backend/src/routes/payment.ts) 在 137 行将多数失败映射到 400/PAYMENT_CREATE_FAILED。[PaymentGateway](../packages/backend/src/infrastructure/payment/PaymentGateway.ts) 已定义维护、限流、配置、协议、缺少关联、超时和网络等分类。需核查 RechargeUseCase 是否保留分类和 outcomeUnknown，并逐分支映射。
- [会话生成](../packages/backend/src/routes/conversation-generation.ts) 有 502/upstream_error 与 504/upstream_error 两条路径。[会话错误映射](../packages/backend/src/features/conversations/errors.ts) 已定义明确的 404、402、409、429、502、504。复用现有 SQLSTATE 与对外语义，拆清超时、供应商异常和空输出。
- [会话 SSE](../packages/backend/src/features/conversations/sse.ts) 接管 raw response，开流后错误走原事件协议。支付回调、Telegram webhook、Admin Supabase proxy、CS 代理分别有各自响应与重试契约。
- Railway 404/500 尚无具体请求样本。TEST 对同一次调用对照客户端响应、应用终态、Railway HTTP Logs 的 httpStatus 和 Sentry。生产使用授权的只读查询按环境和部署版本复核。应用收到请求前的代理故障依赖平台记录。

## 评审清单的落地规则

### 操作状态与结果确定性

采用清单第 1 节的 `succeeded`、`rejected`、`failed`、`timed_out`、`cancelled`、`interrupted`、`degraded`、`skipped`、`unknown` 和 `pending`。pending 为中间状态，不可结束为成功；长期任务须由真实终态所有者收敛。HTTP 状态、业务 outcome、日志等级和提交结果分别记录，默认映射只用于已明确的普通响应，不能反推实际业务事实。

`outcome_known` 表示当前操作的业务提交结果是否已确认：写入超时可记录 timed_out 且 outcome_known=false；连超时事实也无法确认、仅知提交结果不明时使用 unknown。后续查询/对账用原业务键关联独立恢复事件，不覆盖原失败或伪造终态。后台 HTTP 留空；SSE 已开流、支付 ACK、媒体任务查询、代理及跳转按清单第 12 节保留真实响应，具体错误记录在对应子操作。

### 日志等级、异常捕获与告警

- INFO 用于正常成功/业务拒绝、资源不存在、余额不足、幂等重放、用户取消和竞态败方；鉴权失败、限流、并发冲突、恢复中的失败/降级/未知通常 WARN，具体例外按清单条目，例如 VIP_REQUIRED 和部分 409 为 INFO。
- 最终技术失败、错误配置、DB 异常、账务不变量和恢复耗尽为 ERROR；无法启动或安全继续为 FATAL。运营主动模型测试等已列明场景的 502/504 可以 WARN，不按状态码机械升为 ERROR。DEBUG/TRACE 只作额外诊断，基础记录全量保留。
- ERROR/FATAL 由终态责任边界捕获一次 Sentry Issue，保留清洗后的 cause；WARN 默认只记日志，重试中的 attempt 为 WARN，最终耗尽为 ERROR。Sentry 仍遵循独立配置与异常去重，不把已兜底恢复的 attempt 重复捕获成父操作最终故障。
- 清单中的“通知/报警/紧急通知”表示策略候选动作，日志告警统一受 LOG_ALERTING_ENABLED 控制，默认 false，ERROR/FATAL 不绕过总开关；关闭不影响安全退出、全量记录、独立健康信号及既有业务告警。恢复超期可升级日志等级，是否通知另由已启用规则决定。故障自诊断不得递归进入同一策略。

### 普通 HTTP 默认映射

- 400 处理格式或参数错误，保留 BAD*REQUEST、INVALID*\*、MISSING_FIELDS 等已有含义。框架 body 超限 413，格式不支持 415。结构合法但业务明确拒绝的情况按消费者兼容性评审专有码和 422。
- 401 用于缺失或无效凭据，403 用于身份已确认但无权限/权益。资源不存在、隐私策略明确隐藏的 ownership 失败、路由缺失用相应 404 码。数据库权限、schema/RPC 缺失归服务器故障。
- 402 用于既有余额不足协议。409 用于已占用、状态或版本冲突。调用方或本服务限流用 429，保留合适的 Retry-After。正常重复幂等请求维持成功语义。
- 500 用于未知异常、程序、部署配置或数据一致性故障。502 用于无效上游响应与依赖网络错误。503 用于暂不可用、上游共享限流/连接池饱和。504 用于等待依赖超时。业务结果未知、取消和竞态败方有独立 outcome。未实际送出响应时状态字段留空。

完整错误目录直接引用清单第 2—11 节，不在本文复制维护。第 13 节的差异全部进入迁移矩阵，重点包括 PAYMENT_CREATE_FAILED 按真实原因拆分、upstream_error 区分超时、MODEL_UNAVAILABLE 统一目标 409、INSUFFICIENT_BALANCE 统一目标 402、认证配置/依赖故障与用户身份失败分开、模型测试超时目标 504、图片描述内容拒绝与技术故障分开、支付交易号冲突和免费额度状态异常按阶段区分。上述为目标设计，当前实际公开值及响应在消费者兼容完成前保留。

生成供应商网络/服务失败与非法响应分别使用 GENERATION_UPSTREAM_FAILURE 和 GENERATION_UPSTREAM_INVALID_RESPONSE；供应商凭据失败不向用户伪装成 401。DB 权限错配使用 DATABASE_PERMISSION_ERROR，结构/RPC 缺失使用 DATABASE_CONTRACT_ERROR，具体 SQLSTATE 结合调用身份和约束判断。通用兜底码、动态 RPC 码与第三方码不得跳过清单直接凭字符串归类。

## 模块登记范围

- 鉴权、运营、Bot、支持、社区与代理。覆盖无效身份、会话失效、权限、运营草稿/版本冲突、转发失败、限流与协议透传。Supabase 代理保留专用响应，代理自身超时、授权和依赖拒绝分别记录。
- 角色、大厅、收藏、角色社交、心愿墙、创作者、公开创作者。覆盖无效角色、未发布、隐藏、非本人、目录/推荐不可用、评论/点赞冲突、草稿审核、发布失败与配置故障。
- 会话、反馈、引擎、长期记忆、文本后处理。沿用现有会话资源/余额/状态/分支/限流错误码。明确 cancel pending、字数限制、回复版本冲突、编译超时、worker 失败和记忆任务跳过/失败。
- 钱包、VIP、增长、邀请、通知、设置、入门。分别登记余额、权益、签到、邀请失效/重复、发放冲突、读取目标、配置故障和账务不变量异常。
- 短剧、图片、图片广场、语音。覆盖剧/集/任务/资源缺失、访问受限、审核、媒体格式、队列、配额、CDN/签名和生成故障。正常 pending 与 Range 206 维持协议语义。
- 告警、遥测、健康与后台任务/脚本。区分告警发布失败、遥测丢弃、业务失败、可恢复降级及探活异常。后台记录内部码与 outcome。

## 依赖与协议

- **模型与媒体**。OpenRouter、Venice、SurplusIntelligence、DeepSeek、MiniMax、图片供应商按 adapter 登记 provider、operation、attempt、stage、允许的 provider code/status 和重试结果。区分配置、厂商凭据、模型不可用、共享限额、网络、协议、首字/总超时、空流/拒答/内容限制、用户取消及竞态败方。保留 first_token_timeout、primary_first_token_timeout、fallback_first_token_timeout 及原 SSE 帧。上游账号凭据 401/403 归服务依赖，生成、回退和结算保持一次交付/计费。
- **支付商户**。源码确认 [EpayPaymentGateway](../packages/backend/src/infrastructure/payment/EpayPaymentGateway.ts) 与 TTZF 易支付协议。逐商户、渠道和环境核对实际接线。套餐/方式错误按业务 4xx，维护和共享限流 503，非法响应与网络故障 502，超时 504，内部配置/账务不变量 500。provider_rejected 根据明确的商户拒绝类型映射，默认依赖错误。missing_provider_ref 按操作区分渠道归属与内部持久化不一致。商户建单结果未知须保留订单和查回/对账，能否安全重试由既有业务流程决定。回调验签失败、订单/金额不符、重复通知和临时失败保留原 ACK 与商户重试语义，内部记录规范码和实际 ACK。
- **Supabase、Prisma、pg**。分开 HTTP transport 和 SDK/RPC 结果。PGRST116 可能空结果或多条，按 repository 查询预期判断。P0002 和 P04xx 仅按各 RPC 明确约定转换，23505 依据已知约束判定业务冲突或内部异常。连接池、超时、权限和结构错配各有归类。记录受控 SQLSTATE/约束标识，省略 SQL、绑定参数、数据、detail/hint、连接串。按锁定的 SDK 和目标环境验证。
- **其他外部边界**。客服、Telegram API、短剧 CDN、存储和告警发送均登记连接、上游拒绝、响应无效、超时与降级。代理透传只在明确的协议边界内使用，后台任务用内部码，无 HTTP 状态。

## 迁移与验收

每条分支登记 `清单章节/条目 → 入口/操作 → 失败条件 → 来源类型/码 → 规范码 → 旧公开码 → 目标与实际 HTTP/SSE/ACK → outcome/outcome_known → 安全文案 → 恢复/幂等 → 日志级别与 Sentry → 消费者与测试 → 发布/回退批次`。第 13 节每个差异独立登记，未知/待核对不能算完成；下面索引需补充 Fastify 直接响应、SSE、非 envelope 协议、SQLSTATE、错误对象和第三方枚举。每批实施先在日志标注规范码并兼容旧公开码，再改已复核的状态和响应；消费者依赖旧行为时先兼容读取。现有回归覆盖不足时将具体高风险分支的专项测试纳入实施审批。

测试断言实际响应状态、公开码与应用终态一致，并在 Railway TEST 核对平台 HTTP Logs。核验 Sentry 对同一次异常只建一次 Issue，预期拒绝可检索。独立回滚错误映射和采集策略，保留兼容窗口。

完整性验证需包含已恢复失败的每次 attempt、支付结果未知与后续对账、SSE 200 后错误、正常取消和进程中断。基础记录进入投递失败或缺失时单独报警并阻断发布，不能用错误日志采样掩盖缺口。

以清单第 14 节作为错误码专项验收入口。逐项对照目标/兼容公开码、实际响应、操作状态、结果确定性、日志等级与 Issue 次数，并验证 LOG_ALERTING_ENABLED=false 时通知不发生。特别覆盖模型 409、余额 402、模型测试超时 504、DB 权限/结构故障、预留正常失效与状态损坏、金额/归属异常、未知提交及恢复耗尽。shared 契约变更运行 shared 相关测试和全部消费者 typecheck；前端 API/SSE、admin-client/CLI、Bot/代理及商户 ACK 消费均需登记，无消费者证据不得切换公开行为。只完成设计对齐不勾选运行时验收项。

## 源码静态索引

当前 checkout 的 `fail(` 逐行扫描共 322 处、39 个文件、45 种行内字面码和 16 处动态/跨行或内部同名调用。括号为首次出现行与该文件其余次数。索引用来定位分支，状态、可达性和外部契约以逐分支核对为准。

- [features/conversations/errors.ts](../packages/backend/src/features/conversations/errors.ts) · 动态或跨行表达式 65
- [features/generation/first-token-fallback.ts](../packages/backend/src/features/generation/first-token-fallback.ts) · 动态或跨行表达式 188、191、495、528
- [lib/cors.ts](../packages/backend/src/lib/cors.ts) · `FORBIDDEN` (84)
- [routes/admin-cli-session.ts](../packages/backend/src/routes/admin-cli-session.ts) · `BAD_REQUEST` (49)、`FORBIDDEN` (56, +2)、`INTERNAL_ERROR` (131)、`NOT_FOUND` (46)、`RATE_LIMITED` (65)、`UPSTREAM_ERROR` (107)
- [routes/admin-supabase-proxy.ts](../packages/backend/src/routes/admin-supabase-proxy.ts) · `BAD_REQUEST` (215) · 动态或跨行表达式 245
- [routes/bot.ts](../packages/backend/src/routes/bot.ts) · `BAD_REQUEST` (39)、`INTERNAL_ERROR` (54, +1)、`UNAUTHORIZED` (33, +1)
- [routes/character-social.ts](../packages/backend/src/routes/character-social.ts) · `BAD_REQUEST` (63, +6)、`CONFLICT` (39)、`NOT_FOUND` (37, +1)、`RATE_LIMITED` (36)、`SERVICE_UNAVAILABLE` (45)、`UNAUTHORIZED` (55)
- [routes/character-wishes.ts](../packages/backend/src/routes/character-wishes.ts) · `BAD_REQUEST` (32)、`CONFLICT` (36)、`FORBIDDEN` (37)、`NOT_FOUND` (34)、`SERVICE_UNAVAILABLE` (43)、`UNAUTHORIZED` (24)
- [routes/characters.ts](../packages/backend/src/routes/characters.ts) · `BAD_REQUEST` (172, +1)、`NOT_FOUND` (292, +2)、`UNAUTHORIZED` (252, +2)
- [routes/chat-feedback.ts](../packages/backend/src/routes/chat-feedback.ts) · `BAD_REQUEST` (26)、`NOT_FOUND` (38)、`RATE_LIMITED` (47)、`REPLY_CHANGED` (42)、`SERVICE_UNAVAILABLE` (56)、`UNAUTHORIZED` (13)
- [routes/community.ts](../packages/backend/src/routes/community.ts) · `INTERNAL` (63, +2)、`UNAUTHORIZED` (37, +2)、`UNAVAILABLE` (95)、`UPSTREAM` (139)
- [routes/conversation-detail.ts](../packages/backend/src/routes/conversation-detail.ts) · `BAD_REQUEST` (45)、`UNAUTHORIZED` (41)
- [routes/conversation-generation.ts](../packages/backend/src/routes/conversation-generation.ts) · `BAD_REQUEST` (67, +12)、`INTERNAL_ERROR` (370)、`UNAUTHORIZED` (63, +3)、`upstream_error` (323, +1)、`VIP_REQUIRED` (306) · 动态或跨行表达式 347
- [routes/conversation-interactions.ts](../packages/backend/src/routes/conversation-interactions.ts) · `BAD_REQUEST` (63, +4)、`CANCEL_PENDING` (73)、`INTERNAL_ERROR` (98, +3)、`NOT_FOUND` (71)、`UNAUTHORIZED` (51, +4)
- [routes/conversation-sessions.ts](../packages/backend/src/routes/conversation-sessions.ts) · `BAD_REQUEST` (53, +6)、`INTERNAL_ERROR` (89)、`UNAUTHORIZED` (48, +3)
- [routes/creator-analytics.ts](../packages/backend/src/routes/creator-analytics.ts) · `BAD_REQUEST` (17)、`NOT_FOUND` (24)、`SERVICE_UNAVAILABLE` (28)、`UNAUTHORIZED` (14)
- [routes/creator-characters.ts](../packages/backend/src/routes/creator-characters.ts) · `BAD_REQUEST` (48, +1)、`CONFLICT` (76)、`FORBIDDEN` (81)、`MISSING_FIELDS` (73)、`NOT_FOUND` (74)、`RATE_LIMITED` (78)、`SERVICE_UNAVAILABLE` (89) · 动态或跨行表达式 52、55、69
- [routes/creator-tools.ts](../packages/backend/src/routes/creator-tools.ts) · `BAD_REQUEST` (63, +4)、`CREATOR_TOOL_UNAVAILABLE` (198)、`NOT_FOUND` (27, +1)、`RATE_LIMITED` (123)、`SERVICE_UNAVAILABLE` (48)、`UNAUTHORIZED` (65, +2)
- [routes/drama-interactions.ts](../packages/backend/src/routes/drama-interactions.ts) · `BAD_REQUEST` (15, +3)、`CONFLICT` (41)、`NOT_FOUND` (23)、`RATE_LIMITED` (39)、`SERVICE_UNAVAILABLE` (43)、`UNAUTHORIZED` (19)
- [routes/drama-play.ts](../packages/backend/src/routes/drama-play.ts) · `BAD_REQUEST` (113, +1)、`NOT_FOUND` (120, +1)
- [routes/drama.ts](../packages/backend/src/routes/drama.ts) · `BAD_REQUEST` (124, +2)、`NOT_FOUND` (128)
- [routes/favorites.ts](../packages/backend/src/routes/favorites.ts) · `FAVORITE_UPDATE_FAILED` (144)、`INTERNAL_ERROR` (47, +1)、`INVALID_CHARACTER_ID` (125)、`UNAUTHORIZED` (34, +2)
- [routes/growth.ts](../packages/backend/src/routes/growth.ts) · `UNAUTHORIZED` (24)
- [routes/image-plaza.ts](../packages/backend/src/routes/image-plaza.ts) · `BAD_REQUEST` (90, +11)、`IMAGE_PLAZA_UNAVAILABLE` (520)、`INSUFFICIENT_BALANCE` (513)、`INTERNAL_ERROR` (523)、`MODEL_UNAVAILABLE` (204, +2)、`NOT_FOUND` (150, +3)、`REQUEST_REJECTED` (522)、`UNAUTHORIZED` (479) · 动态或跨行表达式 502
- [routes/images.ts](../packages/backend/src/routes/images.ts) · `BAD_REQUEST` (121, +5)、`CONFLICT` (436)、`IMAGE_CHARACTER_UNAVAILABLE` (325)、`IMAGE_DESCRIPTION_FAILED` (273)、`IMAGE_UNAVAILABLE` (151, +3)、`NOT_FOUND` (129, +2)、`UNAUTHORIZED` (83, +3)、`VIP_STATUS_UNAVAILABLE` (92, +2) · 动态或跨行表达式 341
- [routes/invite.ts](../packages/backend/src/routes/invite.ts) · `INTERNAL` (79, +4)、`UNAUTHORIZED` (64, +3)
- [routes/lobby-recommendation.ts](../packages/backend/src/routes/lobby-recommendation.ts) · `BAD_REQUEST` (24, +1)、`SERVICE_UNAVAILABLE` (66, +1)、`UNAUTHORIZED` (22, +1)
- [routes/models.ts](../packages/backend/src/routes/models.ts) · `CHARACTER_NOT_FOUND` (84, +1)、`INVALID_CHARACTER` (79)、`INVALID_MODEL` (163)、`INVALID_PROVIDER` (57)、`MODEL_UNAVAILABLE` (270)、`UNAUTHORIZED` (75, +1)、`VIP_REQUIRED` (197) · 动态或跨行表达式 242
- [routes/notifications.ts](../packages/backend/src/routes/notifications.ts) · `INVALID_NOTIFICATION_ID` (152)、`INVALID_READ_TARGET` (121)、`INVALID_SCOPE` (50, +1)、`NOTIFICATION_NOT_FOUND` (169)、`UNAUTHORIZED` (47, +3)
- [routes/payment.ts](../packages/backend/src/routes/payment.ts) · `BAD_REQUEST` (92)、`NOT_FOUND` (160)、`PAYMENT_CREATE_FAILED` (137)、`PAYMENT_PLANS_UNAVAILABLE` (80, +1)、`UNAUTHORIZED` (88, +2)
- [routes/public-creators.ts](../packages/backend/src/routes/public-creators.ts) · `BAD_REQUEST` (26)、`NOT_FOUND` (36)、`SERVICE_UNAVAILABLE` (62)
- [routes/settings.ts](../packages/backend/src/routes/settings.ts) · `BAD_REQUEST` (49, +2)、`UNAUTHORIZED` (30, +2)
- [routes/support.ts](../packages/backend/src/routes/support.ts) · `INVALID_IMAGE` (96)、`INVALID_MESSAGE` (104)、`UNAUTHORIZED` (24, +4)
- [routes/telemetry.ts](../packages/backend/src/routes/telemetry.ts) · `BAD_REQUEST` (65)、`RATE_LIMITED` (57)、`UNAUTHORIZED` (37)
- [routes/text-postprocess.ts](../packages/backend/src/routes/text-postprocess.ts) · `BAD_REQUEST` (51, +5)、`TEXT_POSTPROCESS_FAILED` (79, +1)、`UNAUTHORIZED` (48) · 动态或跨行表达式 225、296
- [routes/user-onboarding.ts](../packages/backend/src/routes/user-onboarding.ts) · `ONBOARDING_UNAVAILABLE` (41)、`UNAUTHORIZED` (26)
- [routes/vip.ts](../packages/backend/src/routes/vip.ts) · `UNAUTHORIZED` (15, +1)、`VIP_ENTRY_VIEW_FAILED` (44)
- [routes/voice.ts](../packages/backend/src/routes/voice.ts) · `BAD_REQUEST` (152, +8)、`CONFLICT` (415)、`NOT_FOUND` (254, +2)、`UNAUTHORIZED` (84, +3)、`VIP_STATUS_UNAVAILABLE` (98, +2)、`VOICE_UNAVAILABLE` (291) · 动态或跨行表达式 350
- [routes/wallet.ts](../packages/backend/src/routes/wallet.ts) · `CHECKIN_NOT_READY` (132)、`INVALID_CHARACTER` (55)、`UNAUTHORIZED` (32, +4)

## 参考

- [PostgREST Errors](https://docs.postgrest.org/en/stable/references/errors.html)
- [Railway HTTP Logs](https://docs.railway.com/observability/logs)
