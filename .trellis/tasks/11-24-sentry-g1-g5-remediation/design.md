# 技术设计与因果边界（v3）

> 用户已批准本地实现，任务已start。当前方案以[实施v3](research/implementation-plan-v3.md)为准；下表保留v2复用调研和不扩范围的条件，实际选择见[实现结果](research/implementation-result-v3.md)。本地UI按用户明确要求不执行。

本版取代旧版既定补丁；源码基线与历史commit见[复核v2](research/review-2026-11-24-v2.md)。本地实现完成不表示原线上根因全部确认。

## 最小充分方案与复用调研

| 组            | 已检索/复用                                                                                                                      | 决策与进入修改条件                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| G5            | first-token-reports、apiClient/timedFetch/queue、getOrCreateDbUser、GenerationObservationRepository、shared DTO、现行RPC后续迁移 | 先沿已有日志分排队/身份/DB和同receipt终态；不直接改10秒、不加重复handler日志；预算/DB/恢复变化须有因果与容量依据 |
| G4            | scheduler/protocol/postprocess.worker/ReplyRenderer/compose及故障release实现                                                     | 先验资源失败时原文和继续聊天，保护已存在；idle真正终止后缓存复用缺陷若复现才局部修，不当历史网络根因             |
| G1            | init/Providers/early-startup/hooks与实际SDK/bridge                                                                               | 单一调用及部分订阅清理先验证；不预设两次被动重试，不新增桥框架                                                   |
| G3            | client/request-timing/request-concurrency/query-client与QueryObserver                                                            | Errors拒绝与Logs分类分开，复现body迟到/独立失败竞态再选择catch或分类，不按异常名/引用一刀切                      |
| G2            | gallery现有RAF、cover-viewer、@roleplay                                                                                          | 具体尺寸反馈证据后才局部改；不新建通用observer工具                                                               |
| 既有任务/测试 | 4项Trellis与shared/renderer当前契约                                                                                              | 引用既有工作不改状态，迁移7项旧面板fixture/断言，保留安全/choices/通用details与旧块隐藏验证                      |

不新增公开API、业务持久状态、投递服务、队列/日志存储、依赖或DB对象。从与dev产品一致的基线实施，保留最新行为及退役边界；诊断使用有界内存及WeakMap，不保存身份或正文。

## 可靠性设计

- 超时：Worker启动5秒/执行默认1秒分开。客户端回执3秒含排队/body、服务端身份可5秒/RPC3秒不是端到端一致预算；改值需依据，不以deadline代替P95。
- 重试/容量：复用G5即时3次、总最多4次、300/1000ms退避、20条/24小时、恢复30秒间隔及owner；离线/切账号停止。SDK/Worker不无界重试，未知receipt不重新生成。延长期限须验并发槽/keepalive/前台优先级。
- 幂等/并发/事务：复用inFlight、首份不可变终态和RPC一次性写入，保留最新reset及request/message revision。行锁为等待候选，不据源码宣称生产根因。无DB变更，不回放旧SQL。
- 降级/补偿：复用G4安全原文；不造SDK ready或receiver。G5未知提交由同receipt/授权账务证据收口，不假成功/重扣。G3取消不吞独立失败，G2不压告警。
- 限流与观测：保留队列/恢复上限，观测失败不改HTTP/渲染结果；没有新增基础设施的必要证据。

## 日志接入

复用Backend http.ts的operation.terminal/http.request与db.supabase、onError{err}及request/trace/span；原事件已有链路证据，撤回重复conversation.first_token_receipt_failed。仅在真实Pino输出有具体缺口时扩固定stage，不开放任意extra。

Frontend复用api.request_failed、startup阶段及现有Worker/Sentry出口，先验覆盖再决定sdk失败新事件。允许固定route/method、结果/状态/原因枚举、有界计数/耗时和现有链路字段；禁止body/receipt/正文、initData/token、用户/TG/会话/消息ID、签名URL/局部变量。取消、deadline、500、SDK部分失败、Worker fallback分别验终态和脱敏。不preventDefault吞Sentry、不改生产开关/告警，默认关闭保持。

## Android/iOS性能

本次可信双端页面/回执基线不可见，baseline=null，不移用抽样transaction或历史任务单值。不同指标分验：shell/Telegram-ready4000ms；/characters及/chats page.launch沿cold-start-round2 4000ms；创建页沿creator-editor-performance 2000ms；聊天detail沿conversation-read-reliability 2000ms。task.json单值页面2000ms为本任务严格观察目标，按上述范围分开，不能全泛化4000ms。回执POST3000ms为本任务观察目标，不是既有全链SLO/实测，也不等价于客户端期限；发布时需核实采集起止和有效分母，不能用deadline宣称P95达标。

发布前后同正式origin、route/platform/release/前台定义等长48h；双端分别页面P95与可关联平台的API P95，有效N不足100延长至72h或继续观测。同步采集健康/error/stall/left、原请求终态及业务分母，不补零/报未知比例。P95回退>10%且>200ms、队列饱和或真实失败扩大停止扩大发布；资金/身份/隐私/持久数据丢失立即停止。固定样本本地性能门禁不强制，真实样本仍未覆盖。

## 演进、回滚与审核

审核后核refs及用户暂存内容，需要隔离时从已含最新dev的基线新建工作区。无契约/DB/环境变化时补丁可分批回退应用，保留用户内容、receipt、服务端幂等，不清SDK storage、不重放SQL。若证据不支持候选则不改，继续待核实。必要DB/计费/宿主/配置变化另补具体规划及已有授权边界；不自动生产操作。

已完成整体复核、用户授权后的规划收敛与本地实现。日志缺口通过安全原Errors上下文、SDK/Worker固定warning及回执业务分段终态补全，原HTTP/DB错误不重复捕获。当前Frontend构建内存不足，未通过发布门槛；详细审核、验证和回滚见implement.md及verification.md。待核实组继续补同故障证据。
