# Backend 运行时日志与告警

状态：2026-11-16 补齐异常边界、数据库 cause、warn 告警、对账轮次、代理关联与门禁，本地实现，尚未部署。以本文和 `11-12-backend-observability` 任务为准；旧 logging/error-code design 中的持久化、补传和窗口告警不属于本次实现。

## 输出与查询

Backend 使用 Pino stdout，Railway 负责捕获、保存和查询。不新增日志库、采集器、磁盘缓冲或补传任务。现有可选 Sentry/工程 OTLP 和支付业务告警保持独立。

基础事件包含 `schema_version=1`、`event_id`、`module`、`operation`、`trace_id`、`span_id`、可选 `parent_span_id/request_id`、`outcome/outcome_known`、耗时和安全状态码。`reqId` 保留兼容。`LOG_LEVEL` 只控制诊断日志；基础事件不受其过滤，测试环境默认静默。

HTTP 在鉴权前建立上下文，响应回传 `X-Request-Id/X-Trace-Id`。Railway 中可按响应的 request_id/trace_id 搜索整个请求，再按 span_id 看一次调用。通知带 event_id，可搜索对应原始日志。同一操作的 started/terminal 共用 span_id，event_id 各不相同。不同请求和定时任务的上下文独立。

`http_status` 是实际发出的状态；未发响应时为空。SSE 200 只代表传输，生成 attempt、最终业务结果和流交付分别记录。用户断开后后台生成成功不能把交付改成成功。支付回调 ACK、商户查单、入账分别记录；未知提交结果不得据日志直接重做扣费/入账。

DB 和显式第三方 fetch 记录一次 transport attempt，到响应头为止；不读取正文、不增加业务重试。响应体解析、SDK 业务错误由现有业务边界负责。强杀进程可能只留下 started，不伪造终态，也不宣称应用能保证 Railway 的保存 SLA。

## 安全字段

### 用户、业务对象与会话定位

以下字段在有可靠来源时进入 Railway 的单行 stdout JSON；缺失不补零、不伪造。`module/operation` 继续描述技术操作，`business_module` 表示来源业务，所以 DB/provider 日志可以同时关联聊天或创作。

| 字段                             | 含义与来源                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `business_module`                | HTTP 模板识别 `chat/character/creator/drama/image/voice/payment/growth/community/support/wallet/vip/free_zone`；DB/供应商的技术 module 保持自身含义。 |
| `user_id`                        | `getOrCreateDbUser` / `getOrCreateDbUserRecord` 成功解析的内部 UUID；缓存命中及共享查询等待者各自绑定。生成作用域也从已有 GenerationRequest 绑定。    |
| `telegram_user_id`               | Telegram 验签成功的用户 ID，十进制字符串。短剧浏览/播放没有内部用户查询，只有此字段；不为日志额外查库。开发 bypass 仅非生产保留虚构身份。             |
| `session_id`                     | 聊天会话 UUID；不是登录 session/token，也不是客户端播放诊断会话。                                                                                     |
| `character_id`                   | 角色卡 UUID；角色/创作路由目标、创建会话参数或 ownership 校验后会话记录中的角色。                                                                     |
| `creation_id`                    | 当前角色创作操作中等于 `character_id`；现有 `character_creations` 使用角色卡主键，没有独立创作项目 ID。                                               |
| `drama_id` / `video_id`          | 短剧及单集 UUID；GET 剧目标来自路由，POST 播放在参数校验后补充，默认选集后补实际视频 ID。                                                             |
| `image_conversation_id`          | 影像创作会话 UUID；对应 image-plaza 的 conversationId，和聊天 session_id 分开。创建/读取/生成响应仅提取明确 DTO 的标识。                              |
| `attempt_id/work_id/artifact_id` | 影像生成任务、作品、素材 UUID；来自明确路由、分享/来源作品参数或服务端成功结果，不读取正文。                                                          |
| `message_id/audio_id/image_id`   | 聊天消息、语音任务、图片任务 UUID；已知消息路由或业务/worker 记录。                                                                                   |

对象 ID 表示操作目标，不代表资源存在或用户有权访问；404/403 等仍按结果判断。身份未验证的 401 日志没有用户标识。HTTP started 发生于鉴权前，通过相同 trace 可找到之后带身份的终态；没有取得内部用户映射的失败路径只保留已知字段。原日志的 `userId/sessionId/characterId/creationId/dramaId/videoId` UUID 输入归一到 snake_case；数字 userId 不会被误当内部 UUID。日志没有统一 `project_id`，避免把角色、创作、短剧混成同一种实体。

请求内调用 `bindBusinessContext(fields)` 补充关联；并行处理不同对象使用 `withBusinessContext(fields, run)` 克隆作用域。HTTP 完成/中断回调读取同一请求已补充的字段，子 span 继承；后台根上下文独立。新增标识只用于 Railway 日志，不进入 Sentry 的 event/breadcrumb/log/span、告警通知或指标标签。允许内部 ID 不等于开放姓名、联系方式、正文和凭证。

### Railway 查询示例

部署此版本后，在对应环境 Backend 服务的应用日志或 Log Explorer 中查询（替换尖括号占位符）：

```text
@user_id:<内部用户UUID>
@telegram_user_id:<Telegram用户ID>
@session_id:<会话UUID>
@character_id:<角色卡UUID>
@creation_id:<角色卡UUID> AND @business_module:creator
@drama_id:<短剧UUID> AND @video_id:<单集UUID>
@image_conversation_id:<影像创作会话UUID>
@attempt_id:<影像生成任务UUID>
@work_id:<作品UUID>
@business_module:chat AND (@level:error OR @level:warn)
@trace_id:<链路ID>
```

先用用户/对象 ID 找到异常事件，再复制 trace_id 查看此前身份尚未解析的 HTTP/DB 日志及后续生成/供应商/业务终态；按 span_id 区分具体操作。这些是应用 JSON 字段，不是 Railway 边缘 HTTP 日志的 requestId。自定义属性与 AND/OR 查询语法依据 [Railway 官方日志文档](https://docs.railway.com/observability/logs)（2026-11-14 核对）。本地 JSON 测试不代表已在生产检索成功，发布后须逐项实测。

### 合并审计补充

普通 `ChatSessionRepository.getSession` 在已有 ownership 查询成功后绑定角色/会话，不再仅覆盖空会话复用。语音/图片路由的 :sessionId/:messageId 也映射；影像/图片/长期记忆 worker 逐实体使用独立业务作用域，批量任务的根终态不带最后一个实体的身份。支付语义事件可记录已有可信内部 user_id，订单原值继续只用摘要；群 webhook 在验证 secret/身份后使用已有查询补用户。

群欢迎语复用 clientFetch 与原 5 秒超时、不重试。transport succeeded 只代表 HTTP 成功，Telegram payload.ok=false 另有 community.welcome.failed；异步欢迎失败不改变原奖励或 webhook ACK。增长资格用 community_prompt/vip_prompt 布尔，事件使用 prompt_kind/action/recorded，保留 biz/sys kind；不把 prompt 数组或问卷正文加入白名单。问卷完成/失败有稳定 drama_survey 事件。

共享和大厅专用 Prisma 复用 `applyPrismaObservation` 的 model/raw/unsafe raw 扩展；专用连接仍为单连接锁持有者。pg advisory lease 的 connect/lock/unlock/close 使用既有 observer，记录有界操作结果、耗时和链路，不输出 SQL、参数或连接地址。不新增数据库调用、池或锁，也不改变任务超时/清理顺序。

新增调用使用 observation 的字段白名单；遗留 Pino 同样丢弃未登记的 DTO/正文/个人信息，字符串插值不作为输出消息。传入原始 `{ err }`，序列化只保留受控错误类型和源码文件/行号，去掉 message、绝对路径和 SDK 原始内容。业务原因必须显式提供稳定 `error_code`，不能从私密错误文本中猜测。

子 logger 的初始绑定、嵌套绑定和后续 `setBindings` 也执行白名单投影。Pino 会重置子 logger 的绑定 formatter 并缓存 JSON，因此在 `onChild` 使用其导出的 symbols 重建一次安全缓存；升级 Pino 必须运行 logger 回归测试，不在每条日志输出时解析 JSON。

错误对象保留经过格式校验的 SQLSTATE、Prisma/PostgREST 和已登记网络错误码，普通 SDK 错误对象也可留下 `code`；foundation 日志再次投影后仍保留最多两层 cause。未知错误码、message/details 和 SQL 参数继续丢弃。畅聊评估使用 `candidateCount/listedCount/missingMarketCount/probeCount/unroutableProbeCount/skippedChangedCount`，不输出候选记录或响应正文。

Sentry 的异常、日志、breadcrumb、span 各自经过出口投影；自动捕获的 request/user/extra 和错误正文不发送。SDK 标记的路由模板保留性能分组。短剧完整诊断继续通过 shared 严格 schema 校验后写入，不能套普通标量投影而丢失原性能字段。

生产服务和定时任务禁止 console；离线导入/回放/报表 CLI 的人读/JSON 输出是明确例外。`payment-callback-report --json` 保留既有报表协议，不混入通知系统。

## 审计补全与跨服务关联

2026-11-16 异常边界补全：设置/头像/生成偏好与 Bot 捕获异常时记录稳定事件和原始 `{ err }`，公开 HTTP/错误码继续兼容。数据库错误包装通过标准 `cause` 保留原对象；安全出口只投影允许的 SQLSTATE/PostgREST/网络代码，原 message/details 不输出。短剧签名、manifest 降级分别记录 `drama.sign.failed` / `drama.manifest.failed`，仍保持不可播/无内联清单的原降级结果。

支付对账每轮在 `runObservedJob('payment_reconciliation', ...)` 内执行 runPass 及 onPass/onError，底层 `payment.reconciliation` 是其子操作。job 终态、汇总与子调用共享 trace；轮次独立，sleep 在轮次之外；取消不新增错误回调、查询或重试。

### 大厅 Next.js 代理的部署边界

`GET /api/lobby-characters` 的摘要输出在 Next.js 服务端 stdout，和 Backend Railway stdout 属于不同运行时。请求 ID 接受 `[a-zA-Z0-9_-]{1,128}`，否则生成 UUID；只把该 ID 转发 Backend，回传通过相同格式校验的 `X-Request-Id` 及 32 位 hex `X-Trace-Id`，不转发客户端凭证或任意链路头。

每次实际执行代理只有一条 `lobby.proxy.terminal` JSON，含 request/upstream request/trace ID、状态、结果、耗时及固定公开错误码；不含 URL、query、正文、凭证或原始异常。成功/参数拒绝/连接失败/超时/取消/读取失败均覆盖，输出失败不影响响应。这个独立服务端摘要不接入 Backend 的日志告警开关，不新增上报接口或通知请求。latest 公共缓存保持原值；缓存命中返回的关联 ID 对应源站执行，不能当作该浏览器新执行了一次代理。

## 日志告警

配置仅在进程启动时读取，修改需重新部署/重启：

| 配置                       | 行为                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| `LOG_ALERTING_ENABLED`     | 未配置、空或 `false` 关闭；仅 `true` 开启；其他值配置失败        |
| `LOG_ALERT_RULES`          | 可选 JSON 数组，最多 32 条、16 KiB；开启时严格校验，关闭时不解析 |
| `FEISHU_ALERT_WEBHOOK_URL` | 复用现有服务端 secret；开启时必须有效，不写入仓库或日志          |

不开启时没有匹配、通知请求或通知队列。开启但未配规则时只匹配 error/fatal。每条日志只使用第一条匹配规则；同一请求的不同日志可以分别告警，不做聚合或去重。

规则字段：`id`（唯一）、`severity`（P0/P1/P2，默认 P1）、`min_level`（info/warn/error/fatal，默认 error）；可选 `events/operations/error_codes/public_error_codes/outcomes` 字符串数组、`min_http_status/min_duration_ms`。同一条规则内所有条件同时满足。`error_codes` 兼容匹配内部或公开错误码；`public_error_codes` 只匹配公开错误码，二者配置时仍按 AND 判断。示例规则内容如下，不包含 webhook：

```json
[
  {
    "id": "failed-http",
    "events": ["operation.terminal"],
    "operations": ["http.request"],
    "min_http_status": 500,
    "min_level": "error",
    "severity": "P1"
  }
]
```

核心日志和带 event 的既有 Pino 日志均可匹配；没有 event 的 warn/error/fatal 自动使用 `logger.warn/logger.error/logger.fatal`，包含直接传入 Error 和仅消息的调用。warn 只有配置允许的级别/规则命中时才通知，默认规则仍只匹配 error/fatal。业务失败优先补明确事件名，例如客服转发 `bot.forward_cs.failed`、启动失败 `server.start_failed`；兜底事件不替代业务分类。诊断日志被 LOG_LEVEL 过滤后不会产生告警。

遗留 `code/errorCode/errorClass` 映射为内部错误码；没有显式码时可取受控 `err.code/error.code`。`public_error_code` 单独保留，HTTP/SSE 公开错误码可用于规则匹配。`statusCode/status` 数值和 `durationMs` 兼容映射到 HTTP 状态/耗时，非法数值不参与匹配。通知只含规则、事件、操作、结果、内部/公开错误码和 event_id，不带正文、用户标识、原始错误或凭证。

401/403/409/429 的 rejected 终态为 warn，正常响应和裸响应共用同一等级计算；5xx 为 error，其他已有等级规则保留，仍只输出一次终态。

通知直接复用 Feishu HTTP adapter，最多 4 个并发，2.5 秒超时，不重试、不落库、不积压、不补发。过载丢弃通知并记录 `observability.alert.capacity_exceeded`，发送失败记录 `observability.alert.delivery_failed`，这些内部事件不再次触发告警。关闭进程时仅有界等待正在发送的通知。这个开关不控制原支付 outbox/余额告警。

## 错误契约迁移矩阵

| 评审差异                         | 本批处理与消费者                                                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 支付建单 400 兜底                | 已知套餐/购买开关业务拒绝保留 PAYMENT_CREATE_FAILED/400；typed CheckoutError 按配置500、上游502/503、限流429、超时504、写入未知500分类。未知异常500，禁止返回 raw message。Frontend 以通用 envelope/message 处理，不自动重发建单 |
| upstream_error 502/504           | 总超时改 upstream_timeout/504；流内同码。前端接受新旧码、保留已收到文本；首字超时专有码不变                                                                                                                                      |
| MODEL_UNAVAILABLE 400/409        | 模型切换改409，与广场一致；保留原 code，前端通用失败分支                                                                                                                                                                         |
| 广场余额不足409/402              | 改402，保留 INSUFFICIENT_BALANCE；消费方不依赖409作为余额判断                                                                                                                                                                    |
| Telegram 鉴权                    | 缺失/非法身份401增加 UNAUTHORIZED；缺服务配置500/CONFIGURATION_ERROR。删除 URL/initData console                                                                                                                                  |
| Admin 身份依赖                   | 无身份401、无权限403；身份服务5xx/网络和角色查询故障503/AUTH_DEPENDENCY_UNAVAILABLE。Admin、文本后处理、Creator 和 CLI 的对应 catch 同步；不再误触发重新登录                                                                     |
| 素材/代理 message-only           | 保留顶层 message，兼容增加 code；代理响应继续原样透传，只有本地失败分类。代理新增30秒明确截止                                                                                                                                    |
| 运营模型测试超时                 | 504/MODEL_TEST_TIMEOUT；网络仍502/MODEL_TEST_NETWORK_ERROR；Admin 显示安全服务消息                                                                                                                                               |
| 图片描述422兜底                  | 本批保留公开协议；底层 transport 和 image.description.failed 的 errorCode 记录技术原因。持久化 ImageErrorCode 涉及任务状态消费者，不能仅凭现有字符串统一改状态                                                                   |
| 支付交易号冲突409/500            | 保留已验签业务拒绝与结算持久化失败的不同边界；不把未知数据库失败自动转成可重试冲突；既有幂等/回调测试验证                                                                                                                        |
| FEATURE_FREE_TRIAL_INVALID_STATE | 保留公开码和现有失败闭合。非法限额/ordinal/status 与 RPC 预留失效证据来源不同，不按同名码猜测重试资格；需在独立业务状态迁移中拆分                                                                                                |
| 通用 INTERNAL/UPSTREAM 等        | 保留未完成消费者迁移的旧公开码；HTTP 实际状态、DB/供应商操作与安全原始异常上下文用于排障，不全局重写业务结果                                                                                                                     |
| 设计目录第2—11节候选码           | 目录是评审词汇，不代表每个码都有真实生产者；仅 shared 与已验证的生产者接入项成为当前公开契约                                                                                                                                     |

兼容发布：Backend 兼容增加字段/码 → 对应消费者验证。旧客户端保留通用错误显示。无数据库迁移和历史状态回填。公共码的三个保留范围（媒体描述、免费试用、其余兜底）仍需后续业务契约迁移，不把本批日志整改当作全部错误目录落地。

## 验证与发布

本地：`pnpm lint:backend-logging`、`pnpm lint:complexity`、backend 相关测试与全量无凭证测试、shared 测试、`pnpm -r typecheck`、Frontend/Admin build。安全测试覆盖私密输入、并发上下文、一次终态、socket 断开、响应身份、通知关闭/超时/失败/容量。静态 guard 检查运行时代码的 console、未登记直接 fetch 和全局 fetch 替换；不声称覆盖所有第三方 SDK 内部实现。

日志 guard 使用 TypeScript AST 检查 fetch 值引用，覆盖别名、默认参数、globalThis 属性和 undici 导入；局部 fetch 注册不能豁免其他块或被遮蔽的参数。还检查 Prisma 包装、Supabase 实际 global.fetch、pg 创建入口，以及 undici.request/stream/pipeline/connect 和 Node HTTP request/get 的观测边界。每个周期回调及带 sleep 的轮询循环分别检查 runObservedJob，不依赖文件名；新 scripts 默认纳入，离线 CLI 需显式登记。包装 Error.message 时必须保留 cause。

CI 运行 `node --test scripts/check-backend-logging.test.mjs`。例外集中登记：日志 fetch 底座、避免通知递归的飞书 adapter、离线种子导入/翻译 helper 及人工 CLI、perf-metrics 采样；pg lease owner 额外核对 connect/lock/unlock/close 四个观测。generateZImage 是已有 deadline 内的供应商状态轮询，由其调用方业务操作及每次 transport 记录，不能套成后台调度。检查仍不是全程序数据流证明，动态 import/反射或其他 SDK 入口需评审确认。畅聊行情/评估、模型/余额/恢复客户端的原截止、缓存、并发与重试不变。

发布后：先保持通知关闭，检查普通成功/401/404/500、SSE 断开、支付 ACK/结算、定时任务的 Railway 链路；再按真实业务需要配置规则和 secret。对照发布前后各24小时的 Android/iOS 页面与 API P95，基线未见样本保持 null，N<100 延长窗口。当前未执行生产部署、真实支付/供应商调用或发送飞书通知。

建议本地长期验收复用 `packages/ui-tests` 的 @chat/@profile/@image，补充超时显示、半截流保留、余额不足及支付未知状态查看原订单；现有模拟不能替代真实计费、系统键盘及生产 P95。

回滚：关闭 LOG_ALERTING_ENABLED 并重启即可停止新通知；按模块回滚应用提交，不改数据。出现敏感字段、异常通知量或性能劣化时停止发布并定位 event/operation。
