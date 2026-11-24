# G1—G5本地实现及审核结果（v3）

2026-11-24，基线HEAD b0d30bccab6a1f0d2cf8ad0f7b1ebf738e63b7be，fix_request_speed。用户授权按明确故障修复、未知先补观测后做稳定性；Trellis规划审核收敛后已start。本次未提交/部署，实际验证见../verification.md。原数据仍截至11:27部分窗口，未重查Sentry。

## 因果、复用和最小改动

| Issue              | 证据与已实施改动                                                                                                                                                                                             | 不能据此作出的结论                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 / ST-MINIAPP-2  | init.ts由前置成功标记改为not_started/initializing/skipped/initialized/failed；environment_probe和sdk_init失败阶段区分，动态调用既有sendSentryLog。原Errors附SDK状态、receiver及HTML ready                    | 没有新增已证明安全的初始化重试；唯一Providers调用及部分订阅所有权不变。状态测试不能证明33条桥错误根因                                                                  |
| G2 / ST-MINIAPP-6D | 原Errors附页面安全模板、视口/文档/弹层/封面状态，observer_source固定unattributed。封面move同值不setState、ResizeObserver写操作下一帧合并并取消；拆出原手势/resize hook以满足120行限制                        | 未改gallery，也未证明封面导致大厅循环；诊断只记录当时布局。未做UI/真机点击与缩放验收                                                                                   |
| G3 / ST-MINIAPP-7Z | timedFetch仅给其实际拒绝的调用方abort打标；apiClient取消分类不再覆盖独立网络错误。内部deadline仍RequestTimeoutError并记失败；first-token客户端3秒超时明确类型。安全WeakMap上下文保留queue/headers/body       | 不按AbortError名全局过滤，不吞Errors。错误对象可能在多请求共享abort reason时复用，same_error_object只证明对象关联，不唯一定位query；跨对象unknown。未证原草稿/保存结果 |
| G4 / ST-MINIAPP-34 | 回归先证明idle错误留缓存及messageerror不降级，再修当前generation错误销毁；旧generation不影响新实例。ReplyRenderer原文提交后可选onFallback，consumer固定reason warning每reason60秒、文档最多8次，日志失败隔离 | 故障f7已有原文fallback，不是本次新增；idle缺陷不是已证实importScripts根因。仅局部稳定性修复，不称历史CDN恢复                                                           |
| G5 / ST-MINIAPP-CE | 新receiptDiagnostics复用requestLogger.sys；identity_ms/rpc_ms、recorded/not_recorded/unconfirmed及已知/未知终态。异常重抛同一对象，由既有HTTP onError保留{err}，不重复captureException                       | 保留客户端和RPC3秒及既有恢复次数；DB锁仅候选，不改SQL/计费，不假recorded。分段日志不是后端500根因修复                                                                  |

beforeSend先丰富再沿原sanitizeTelemetry/sanitizeStartupDiagnostic安全出口；保留exception、level、fingerprint。诊断不新增用户、TG、会话、消息ID、正文、receipt、initData、token、URL/query或数据库读取；WeakMap不阻止错误回收。请求耗时分段是客户端/服务端各自口径，不相加冒充业务延迟。

Backend route原鉴权、参数校验、repository及@frontend-ready不变，无新的HTTP契约、DB对象、配置、依赖、事务或业务状态源。计时和日志失败隔离，不改变原业务结果；Pino真实JSON测试验证允许字段、单业务终态、unknown、原错误身份及敏感值排除。

## 既有任务与实际commit去重

复用11-19-cold-start-round2、11-19-creator-editor-performance、11-19-conversation-read-reliability及11-02-first-token-delivery-repair的既有结果/边界，不改其状态。refs与实际commit完整调研见review-2026-11-24-v2.md。

- f7故障release的renderer保护及fbde8a78、5c763226已存在，不重复称本次新增；当前启动5秒、执行默认1秒保留。
- #1116 / dfb6cd14拒答中断reset与request/message revision保留；7f8df915总预算保护不重做。
- renderer 7个旧测试按5c0c9da996a71cd9817ffd6172c6611f4104aea7、9560872cccaae6b88c3ca665a568ecdbf8d1c2ba、dc5dbface60806dd66e557bac38545cf530280bc的现行契约迁移。保留正文scope、sanitize、choices/防双击、通用details键盘/指针覆盖，验证旧状态/记忆隐藏，不恢复退役卡片。
- artifact-renderer consumer测试仅mock新增Sentry出口，继续编译实际bubble/renderer；避免浏览器esbuild测试解析Sentry Node依赖的fs/zlib，不能以此宣称实际bundle通过。
- complexity基线只删除已拆小的CharacterCoverViewer函数172行项；其他条目不放宽。22文件/88函数通过，存量其他增长警告保留。

## 审核、性能与回滚

按trellis-check在主会话核对全部frontend/backend/renderer及shared消费者，检查producer→consumer、失败传播和允许字段；不新增通用框架。新测试文件必要性已由v3风险计划确认，其他优先扩既有文件。当前typecheck、相关回归和静态检查通过；Frontend构建两次OOM，尚未取得构建产物验收，不能发布就绪。

Android/iOS及API真实P95 baseline仍null。成功启动路径无新增同步Sentry模块，布局写每帧最多一次且cleanup取消，诊断不逐帧发网络；Worker时间预算、请求槽、重试与容量不加大。按design分指标目标，发布后同origin/route/platform/release、前台定义等长48h，每组有效N至少100，不足延至72h或继续观察；P95回退>10%且>200ms或失败扩大停止扩发，资金/身份/隐私/数据异常立即停止。目标不是已达标，deadline不是P95。

可分别回退SDK状态/诊断、请求取消分类、封面hook、Worker及回调、后端receipt诊断的完整应用补丁单元，先前应用行为仍兼容；避免只回退consumer造成导入缺失。不改SQL/持久字段，不清receipt、SDK storage或用户内容。保留原幂等、owner和未知终态；发现计费异常按证据专项forward-fix，不重放旧函数。

## 可重复场景与真实缺口

用户明确不做本地UI测试，后续不启动preview/test:ui。已在既有chat.spec.ts中增加复用chat-edit fixture的Worker构造不可用→原文可读→输入保留→下一轮仅一次POST场景，尚未执行；这是未来复用建议，不是已通过。复杂流程可复用现有@startup、@character-cover、@chat-edit、creator场景补宿主失败、延迟图片尺寸/连续缩放、离页/body迟到/草稿恢复及receipt未知重载/切账号，不另建临时mock服务。若后续需要执行，遵守用户最新授权。

真实Telegram iOS/Android native回调/旧WebView/系统键盘和后台、历史CDN 404/MIME/缓存、生产DB等待及同receipt最终态、账务/供应商行为、线上新日志实收及性能均未覆盖。本次不读取生产业务行、不触发真实计费/供应商/迁移或配置，不用其他请求成功替代原失败恢复。
