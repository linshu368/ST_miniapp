# 技术设计与规划审核稿

## 1. 最小充分方案

| 批次   | 改动边界                                                                                                                                                                                       | 明确不做                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| A / G5 | first-token-reports复用现有apiClient totalTimeoutMs=10000，覆盖队列/响应体；保留POST最多4次、owner/不可变receipt/恢复上限。Backend既有回执handler补失败stage/耗时与{err}日志，继续真实失败响应 | 不伪造200/recorded=true，不改变RPC3秒上限、数据库函数/计费规则或自动加数据库重试 |
| B / G4 | worker-scheduler仅在当前generation的idle Worker error时销毁失效实例；active错误继续原文fallback和pump，过时事件不杀新Worker                                                                    | 不重建已有fallback、不自动刷新、不用全局错误过滤、不改变原文安全渲染/choice边界  |
| C / G1 | initTelegramSdk成功后标记inited；失败后最多允许下一次既有调用重试，总共2次，无timer/轮询。一次安全失败诊断，非Telegram不调用init                                                               | 不造receiveEvent空函数/缓存消息桥，不提前业务ready、不改变HTML early-ready契约   |
| D / G3 | 严格证明当前signal取消原因匹配才免记api.request_failed，沿用已有计时取消语义；扩展真实query取消/迟到body拒绝验证                                                                               | 不按AbortError名字全局过滤，不吞非同因错误，不将分类补强当Issue根因已修          |
| E / G2 | 复用本地验收和现有observer做复现；仅在复现证明具体写读循环后做局部RAF/相等值保护                                                                                                               | 无证据不改observer，不重构超长gallery或开放额外遥测字段，不保证本轮可关闭        |

G1、G3的局部缺陷与线上根因分别记录；G2当前没有可承诺的产品patch。若需扩大为新的事件契约、生产source map上传、通用observer工具、数据库/计费/宿主桥策略，停止对应分支并提交新的具体审核，其他已批准批次可继续。

## 2. 复用调研

| 已检索资源                                                                                                  | 决策及理由                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| frontend lib/telegram/init、hooks、Providers、early-startup及SDK bridge依赖源码                             | 扩展既有init owner，不引入第二套原生桥；原生receiver与退役ST桥分开                 |
| character-gallery、cover-viewer与现有RAF/布局测试                                                           | 先复现；gallery已有RAF，不重复套一层工具。无证据不复用其他业务observer作根因       |
| api/client、request-timing、request-concurrency、query-client/characters hooks                              | 复用现有totalTimeoutMs、signal、queuePriority和QueryClient，原取消/retry边界不重做 |
| first-token-reports、getOrCreateDbUser、GenerationObservationRepository、ReportFirstTokenRequestSchema/Data | 仅消费现有契约，保留schema/owner/immutable payload/容量约束；不新建投递服务        |
| experience.report_chat_first_token及billing.chat_delivery_billing_gate（现行迁移/registry）                 | 保留既有幂等和计费耦合，不重放历史SQL；没有数据库改动                              |
| reply-renderer worker-scheduler/protocol/ReplyRenderer/compose                                              | 复用原文fallback及generation隔离，不新建公开callback或另一渲染层                   |
| Backend requestLogger、HTTP/db.supabase operation终态、Sentry/Faro安全出口                                  | 复用链路，只增加必要失败stage；不增加日志存储、身份查询、通知规则                  |
| 既有4项Trellis任务与ui-tests @startup/@chat/@roleplay/@creator                                              | 引用而非覆盖其范围/旧门槛；本协调任务记录这次差量，既有fixture扩展失败状态         |

## 3. 可靠性与故障模型

- **超时**：G5每次总等待10秒包含队列/网络/响应解析；服务端身份5秒与RPC3秒保持。10秒是本次预算选择（给排队/协议留2秒），不是观测P95或保证所有请求成功。既有3次即时尝试含退避最坏约31.3秒，第四次恢复另计且仍有界；发送UI不得await这条回执链阻塞交互。
- **有限重试/限流**：不新增POST通用重试、数据库重试、供应商重发、主动轮询。receipt现有最多4次、恢复每次最多4条串行、30秒节流不变。SDK最多2次被动初始化调用；Worker沿原串行泵。
- **幂等/并发**：不改request/revision、不可变终态payload、owner与inFlight去重、RPC幂等；账户切换和晚回调不可删除新owner状态。旧Worker generation事件不可销毁当前实例；取消与真实失败竞态按同因判断。
- **事务**：不增加/改变数据库事务。超时或客户端中断不能证明服务器回滚，需保留未知并走原恢复；不回写费用或补发模型。
- **降级/补偿**：G4保留安全原文与既有message identity；G5不假确认、保留未确认receipt至既有上限，账务补偿不在本地自动执行。G1失败不伪造ready；G2/G3未知业务终态不静默吞错。
- **容量**：不增加连接帽（3）、Worker并发、20 receipt/100 confirmed上限；10秒可能增加等待占用，必须验队列释放/后台恢复，不为稀有异常建立熔断平台。
- **可观测性**：Backend HTTP/db终态、回执失败stage和原始{err}；Frontend安全初始化结果及既有请求取消/失败。日志失败不得改变业务结果，生产敏感ID只沿已有允许的request/trace关联，不新增到指标标签。
- **不适用**：无新持久存储、迁移、外部读者、收费规则、第三方写入，故无需新SQL事务/迁移补偿/供应商限流器；真实收费对账仍是以后独立发布验收，不能把本地测试当对账。

## 4. 日志接入

G5复用requestLogger与platform/observability的http.request、db.supabase，handler catch记录conversation.first_token_receipt_failed及stage/duration_ms；保留原错误及cause、原HTTP失败，不在日志中输出请求body/receipt/身份/业务ID。G1只有固定sdk_init_failed、attempt、outcome；不记录SDK错误原文或launch URL。G3不新增每次取消日志风暴，沿已有timedFetch/recordApiTotal；只有明确当前取消才避免error误分类，deadline与真实HTTP保留。G4沿现有Sentry全局错误和本地fallback标记，不能为了降低事件数preventDefault。

Backend事件与字段必须通过真实Pino白名单输出验收；若新stage等字段不在允许名单，扩展固定枚举并验证，不开放任意extra。无新增告警，默认关闭保持；各层日志用途分别标注。

## 5. Android/iOS性能护栏

受影响入口为/、/characters、/chats、/chat/:characterId、/creation/characters/new。API仅回执POST；其他业务API行为不变。报告中的transaction P95/count存在采样与定义问题，不能作为真实ready/回执基线，因此task.json双端与APIbaseline=null，具体说明无可见可信样本。

规划目标：双端页面真实可用P95≤4000ms（沿既有冷启动目标作为上限目标，聊天/创建分别验，不混总分位）；回执API P95≤3000ms是待验证目标，不把10秒deadline当目标。发布前后同正式origin、route/platform/release/前台定义的等长窗口，至少48小时、每格有效N≥100；不足延长72小时或继续观察。追加错误/无字/丢稿/超时分母，不能只看成功分位。

停止条件：权限/重复扣费/交付丢失/串账号/草稿丢失立即停止对应批次；同口径P95回退>10%且>200ms、或队列饥饿/真实失败上升时停止扩大发布并回退本批。没有真实样本不签性能通过，不要求暂停中的固定样本本地性能门禁。

## 6. 演进、兼容与恢复

1. 实施在基于origin/dev的隔离分支；审核后再次核最新refs和相关文件，若有相同修复则复用并更新证据，不反向改上游。
2. API payload、response shape、HTTP route不变；旧客户端与旧receipt仍兼容。G5不引入新公开错误码，不动SQL。
3. 各批次可独立回退；G5先恢复前端原预算/handler观测，保留持久receipt及服务器幂等；G4回退局部生命周期，不删用户内容；G1回退局部init策略，不清SDK storage；G3回退局部分类，保留原错误。
4. 不修改历史migration、不回滚用户数据、不恢复旧入口；真实发布及source map上传需独立授权。
5. 当前只准备本地变更，commit/PR/部署均为空，线上结果必须另验。G5底层DB等待、G1宿主时序、G2真实布局源及G3具体未处理拒绝若未定位，继续挂待核实并有期限。

## 7. 审核状态

自检：现有保护/退役项/并发/日志/性能/失败验收已覆盖；没有将假设写成线上根因。**等待用户对本稿的后续明确批准**；未运行task.py start，未改产品代码。规划若实质扩大，重新提交审核。
