# 页面、角色扮演与短剧：工程性能验收

## 当前交付状态

2026-10-29：代码、默认关闭的独立遥测出口、固定版本采集器配置和四张看板源已完成本地实施。**没有发布、启用 TEST/生产、创建收费服务或把新看板导入线上。** 本机合成验证与真实 Cloud 摄取是两道不同门禁；不能用无数据空图宣布迁移成功。

经营看板继续读取已有 Supabase 轻量汇总；原首字回执、赢家身份、恢复和计费事实继续原样持久化。本次没有新增监控表、索引、cron、逐事件数据库查询/写入，也没有退役旧短剧分析上传。旧链路只在双轨证明确已替代后另行下线。

四个独立入口：

| 源文件 / UID                   | 工程首先看什么                                            | 数据源        |
| ------------------------------ | --------------------------------------------------------- | ------------- |
| `st-engineering-pages.json`    | 页面可用、打开/导航、缓存/刷新、API 全程与分段            | Cloud Loki    |
| `st-engineering-roleplay.json` | 首字、完整回复、恢复、交互反馈                            | Cloud Loki    |
| `st-engineering-drama.json`    | 目录、启动、首帧、阶段、播放中断与恢复                    | Cloud Loki    |
| `st-engineering-backend.json`  | HTTP/生成/上游尝试/短剧服务端/Prisma/runtime/出口健康下钻 | Cloud Metrics |

前三项是工程体验产出，第四项是定位原因的证据。保留既有经营、首字 v4 和短剧看板，不覆盖其他 TextBot 项目。源 JSON 默认绑定当前 `grafanacloud-logs` / `grafanacloud-prom`，标题和标签均标“待接入”。

## 三类核心测量

| 类别     | 指标                      | 起点 → 终点                                                | 成功筛选 / 不可混用的情况                               |
| -------- | ------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| 页面     | `page.ready`              | 当前 pathname 挂载 → 当前可见核心内容可用                  | `ready`；错误页不算成功，仍显示可用旧缓存的页面可以成功 |
| 页面     | `page.launch`             | document 单调时钟起点 → 可用                               | 与 mount 不混算；JS 完全未启动无法被采集                |
| 页面     | `page.navigation`         | 捕获到的 Link/返回/可用导航 hook → 可用                    | 未捕获程序式跳转标 mount，不冒充点击耗时                |
| 页面     | `page.fresh`              | 页面挂载 → 已观察请求在途后成功结束                        | 与旧缓存秒开分开；刷新错误不算 fresh                    |
| 页面     | `api.total`               | 调用统一客户端 → 返回解析结果或最终失败                    | 含排队、重试退避、headers、body；成功为 `ok`            |
| 页面     | `api.queue/headers/body`  | 同一 attempt 的实际阶段                                    | 与 logical total 区分；排队取消不伪造服务端时间         |
| 角色扮演 | `roleplay.first_token`    | 接受 send/regenerate → 匹配正文或已开启思考的 React commit | `observed`；不是像素显示或实际阅读                      |
| 角色扮演 | `roleplay.full_reply`     | 接受动作 → 匹配完整终态消息的 React commit                 | `complete`；失败/中断/拒绝/超时/停止/后台/离页单列      |
| 角色扮演 | `roleplay.render`         | 已知真实首 delta receipt → 该 commit                       | 恢复快照没有 receipt 不补 0；不是后处理 renderer 全完成 |
| 角色扮演 | `roleplay.recovery`       | 可恢复断流 → 同 request 的终态 commit/已知中断             | 完整恢复筛 `complete`；streaming 快照不算恢复完成       |
| 角色扮演 | `roleplay.action`         | 原关键动作开始 → 既有反馈点                                | `feedback`，后台时间排除；不能冒充完整生成或页面 ready  |
| 短剧     | `drama.catalog`           | 原目录入口 → 目录 ready/失败/离开                          | 成功 `ready`；目录失败与视频失败不同                    |
| 短剧     | `drama.startup`           | cover/switch/episode/retry/direct 入口 → 首帧且 playing    | 成功 `playing`；地址返回、canplay 都不够                |
| 短剧     | `drama.first_frame/stage` | 原首帧/实际阶段计时                                        | 成功启动筛 `playing`；并行或重叠阶段禁止相加            |
| 短剧     | `drama.rebuffer`          | 已成功启动后前台非暂停/seek 的 waiting → playing/中断      | 恢复筛 `playing`；网络 stalled 本身不算画面卡顿         |

`/chat/:id` 的入场体验使用页面指标；select_character 反馈不是角色正文 ready。首页 `/` 的通用 ready 是推荐目录或实际仍可用的播放器状态，视频体验另看 startup。短剧详情 `/dramas/:id` 的 ready 复用首帧且 playing 的同一证据，不另造播放器状态机。

后端各项严格定义、单位、标签和限额见 [采集器说明](../../ops/observability/README.md)。`phase=first_token` 的赢家不是完整生成成功；竞败方不是供应商故障。过滤、长度截断、系统超时、主动停止分别统计。上游平台只确认 OpenRouter/Venice，不猜内部供应商；整轮无明确 finishReason 时不从单路失败推断原因。

## 页面与接口覆盖

已登记20个页面模板：`/`、`/characters`、`/chats`、`/chat/:id`、`/chat/:id/voice/:id`、`/create`、`/create/studio/:id`、`/create/work/:id`、`/dramas`、`/dramas/:id`、`/vip`、`/profile`、`/profile/recharge`、`/profile/recharge/:id`、`/profile/orders`、`/profile/spending`、`/profile/messages`、`/profile/messages/:id`、`/profile/invite`、`/profile/support`。

- 路径白名单在 `lib/perf/route-template.ts`；页面通过现有 `usePageReady` 声明真实就绪/失败。未知短路径归 other，不把动态ID当维度。
- API 客户端自动覆盖24个有限接口组，不输出原路径/query。诊断上传排除，防止采集递归。大厅同源代理等绕过统一客户端的请求不在 `api.total` 承诺内，页面端到端和后端HTTP仍可观测。
- 只有首页/角色/短剧目录可判定部分 cache/fetch；无法证明的标 unknown，不猜测。
- 支付 Worker/Cron、独立客服服务、语音首播放/图片生成完成、丢帧率/音画同步未在本期新增完整覆盖；保留已有监控，不把“记录了请求/按钮”说成全流程已覆盖。

## 如何把数据作为工程产出

1. 每次选页面、角色扮演、短剧各自的痛点，不只按单个最慢 P95 排名。先看服务失败/超时变化与样本构成，再看受影响范围、P50/P95、超参考预算的事件与可定位原因。
2. 对比同环境、release、测量版本、页面/入口、缓存来源、前后台、平台/网络的可比窗口。低样本仅观察；不要用删除慢入口、减少覆盖、缩短内容或排除失败来优化报表。

   当前网络/Telegram平台维度主要来自通用页面测量，角色扮演/短剧镜像没有完整带入所有设备维度；前三张默认看板也尚未提供网络/平台筛选器。TEST阶段若发现不同WebView占比明显变化，不得直接据全量前后P95归因工程优化，需先补齐该主线分层与对应筛选，再验收。

3. 首先积累24–48小时基线，再由产品与工程确认具体预算。现有页面4秒 watchdog 是初始排查线，不是通用最终SLO；角色首字策略截止时间也不是所有场景的统一体验预算。本期不新增自动告警，避免与现有 Sentry 重复。
4. 工程交付附：前后版本/窗口、样本量、成功/失败/退出构成、成功P50/P95、覆盖变化和同负载资源开销。只给平均数或只给成功P95不算完成验证。
5. 下钻先看 API/生成阶段，再到 [Sentry 错误与已有追踪](https://de.sentry.io/organizations/wangqiao/issues/) 按同 release/时间窗核对。新遥测不发送个体ID，因此不承诺逐请求一键关联或端到端精确配对。

已接收 started/terminal 的窗口计数**不是严格 cohort 闭环率**：窗口前开始、窗口内终态，或反过来，都可改变比值；两条一起丢失时更看不到。这里故意不把终态/起点比包装成“全访问覆盖率”。成功率以已知终态为分母，离页、后台、主动停止单列，没数据不填0。

## 数据格式与本地验算

Faro 2.13.0 只发自定义 measurement/event：固定 `st_` 名称、`duration_ms` 毫秒、`measurement_version=engineering_v1`、独立 source_measurement_version。无默认 fetch/error/console/tracing/replay、session/user/URL meta，Sentry 保持原追踪 owner。

Cloud 托管 intake 的协议要求与本机 Alloy 不完全相同：请求必须带 `X-Faro-Session-Id`，body 必须保留公开的 `meta.sdk.name/version`。出口在 SDK 初始化时调用 `genShortID(32)` 生成一个仅本 exporter 内存生命周期复用的随机协议标识，只放请求头；不写 cookie、localStorage/sessionStorage、body、measurement/event 属性或指标/日志索引标签，不与业务身份关联。`meta.sdk` 只包含固定包名与 SDK 公开导出的实际 `VERSION`；beforeSend 仍重建白名单 body，不恢复 SDK session/user/page/browser/trace meta，也不启用自动仪器或 Replay。SDK import 可能做 Web Storage 可用性探测，但不会将该协议标识或 session 持久化。关闭采集或 SDK 加载超时时不生成标识。修正协议不代表真实浏览器 Cloud 摄取已经验收，仍须独立验证。

Faro 2.13 默认 `FetchTransport.send` 强制添加 `Idempotency-Key`，当前托管入口的浏览器 CORS 预检不允许该头；Node 合成 POST 得到 202 不能证明浏览器可发送。工程出口保留该版本构造的 `bufferSize=20/concurrency=1` 有界队列，只覆盖公开 `send(items)`，通过公开 `promiseBuffer.add` 与 `getTransportBody(items)` 发送。每个出队 batch 单次 fetch，仅含 `Content-Type` 和随机协议标识头，omit credentials/no-referrer；每次实际发送独立 AbortController 三秒超时并 finally 清理 timer，不重试。格式、排队拒绝、非 2xx、网络和超时失败各计一次失败批次，不读响应正文、不抛到业务；不访问 SDK private 字段、不 patch 全局 fetch、不引入代理或另一套队列。容量和超时回归使用真实 SDK 的公开接口验证，浏览器验收仍须检查真实 OPTIONS/POST 和 Cloud 回查。

固定 Alloy v1.21.0 本机实测的 logfmt 契约：

- measurement：`kind=measurement type=st_page_ready duration_ms=... context_route=... context_outcome=...`。
- event：`kind=event event_name=st_page_terminal event_data_route=... event_data_outcome=...`。**事件是 event*data*，不是 context* 或 event* 前缀。**
- app：`app_name/app_version/app_environment` 位于日志字段。当前 Alloy 不自动把 kind/app 建成索引标签；本地测试显式配置固定 `app` 标签。
- Cloud 托管接收端必须用一条 TEST 合成样本再核验格式与流标签；看板 browser_selector 是待确认配置，不把本机 Alloy 输出假定为账号已启用的托管格式。`local-test/config.alloy` 只供本机验算，禁止拿它公开部署。

运行 `node ops/observability/local-test/faro-loki.mjs`：使用本机两个临时容器与10条虚构测量，验算总数、8成功/2错误、成功P95=1000ms，并执行前三张看板全部 LogQL。测试结束只清理本次容器及网络，不访问业务API、数据库、真实模型或Cloud。固定采集器的生产配置单独使用 `alloy validate` 验证。

浏览器健康 source\_\* 是JS生命周期累计快照，没有身份，不可相加当全站量或送达率。看板只显示近期单生命周期累计快照最大值；transport_failures 是失败批次数，不等于丢失调用数。应用/Collector 各自队列和丢弃也不可跨单位相加。Cloud故障时自监控也可能送不出去，仍须看Collector本地指标和平台日志。

## 配置、启用与回滚

前端构建时公开配置：

| 名称                                | 约束                                         |
| ----------------------------------- | -------------------------------------------- |
| `NEXT_PUBLIC_GRAFANA_ENABLED`       | 仅明确 `true` 启用；默认关闭                 |
| `NEXT_PUBLIC_GRAFANA_COLLECTOR_URL` | 真实托管浏览器 HTTPS 入口；无凭证/query/hash |
| `NEXT_PUBLIC_GRAFANA_ENVIRONMENT`   | test 或 production                           |
| `NEXT_PUBLIC_GRAFANA_RELEASE`       | 构建SHA或有限安全版本；不包含秘密            |

托管浏览器入口需独立 TEST/production app、来源域限制、摄取配额和异常流量止损。公开入口不是强身份认证，不放 Cloud token。私网 Collector 的真实 OTLP 地址/用户名/token 只通过部署 secret 配置；不要粘贴聊天、提交Git或给浏览器。

启用门禁：本地验证 → 明确服务资源/费用 → 配置 TEST 托管浏览器入口与私网 Collector → 真实SDK合成样本回查 → 核验每个面板、单位、标签和基数 → 真实Telegram/WebView → 同负载有/无遥测CPU/RSS/延迟/包体对照 → 单独批准生产 → 24–48h基线与建议一周双轨。没有完成的项目均保持待验证。

回滚：后端关闭 ENGINEERING_TELEMETRY_ENABLED 并重启；前端关闭 NEXT_PUBLIC_GRAFANA_ENABLED 后重新构建发布。Collector关闭只影响新遥测；原Sentry/业务事实/经营SQL均保留，不需要数据库回滚，不启用旧重cron。

日常维护只维护现有 owner、统一出口白名单和这组版本化看板。新页面/交互按实际价值**非常建议**补 ready/测量，不为每个普通按钮建一套监控。没有当前决策价值的细碎指标本期不加。

## 兜底与业务首字专项接入（2026-10-29，TEST候选）

本节为专项候选源码；新架子已另行部署，本批埋点尚未发布，未切换或停用旧SQL看板。复用同一Faro与OTel/Alloy出口，不增加数据库I/O、配置查询、遥测路由、表、cron或采集服务。现有交付、恢复、赢家和一次计费事实继续保留；纯监控展示迁往Loki/Metrics，不能直接删掉计费资格所依赖的首份结果。

客户端FirstTokenObservation同一终态镜像增加公开目录的requested_model（所选型号，最多64种）与客户端本轮deadline_ms、trigger_ms。SSE start可选requested_model_id使用既有解析出的公开型号ID校正过期客户端选择，不新增读取；旧服务兼容客户端发送时快照，首帧前无法确认的情况不冒充服务端冻结事实。deadline/trigger是日志标量，不创建无限Prometheus标签；SSE修正旧缓存仍按原点击时钟，原6秒补报修复已一起适配。正文/已开启思考的首token进入React提交消息界面才是成功；供应商或服务端已有首字不代替客户端交付。关闭遥测、401、队列溢出或发送失败不得阻塞业务回执。

角色扮演看板增加专项行：按所选型号的总截止无字率（timed_out/已知前台首字结果，目标1%）、成功P50/P95、成功首字分布、结果样本与离页/后台/停止构成。默认6000ms，可独立选择历史10000ms；成功分布严格在对应预算内。仅原日志字段计数/聚合，不查询Supabase；没有数据不填成功或0毫秒。未知型号单列unknown/other，不把用户/会话/请求ID做标签。型号为公开目录稳定ID，动态新增不需改监控代码。

服务端额外四个计数器：st_chat_requests（创建本轮身份后一次受理）、st_chat_fallback_dispatches（真实兜底POST派发）、st_chat_first_token_selections（唯一首字赢家，winner与fallback_started）、st_chat_first_token_timeouts（既有总截止锁存一次）。全部按requested_model聚合，单位与\_total翻译须由实际TEST验证。st_chat_server_first_token仅供服务端排障，从路由时钟到首字选中，绝不画成用户总耗时。chat.first_token日志保留安全阶段、elapsed_ms、deadline_ms和trigger_ms标量，无正文、推理、个人身份或凭证。

触发率=实际兜底派发/受理；兜底首字选中比例=选中fallback/全部选中。后者仅表示服务端选择，不能冒称客户端最终收到的替代率；客户端主图仍独立裁决。原attempt指标/日志继续辅助定位错误、headers、首字和竞败，不把race_lost算供应商故障，不相加并行等待或相减独立P95。计数器increase是窗口估计，低样本需同时看客户端已收到终态样本。

现有SDK/Collector健康继续独立显示。开始/终态的窗口差额不是精确缺报，也不能据缺报证明用户未收到；两份信号同时丢失仍可能不可见。监控数据只用于观测，不用它做钱包扣费或补扣。当前不接自动调参或损失函数，也不把整条回复耗时混入首字专项。

本地复用固定Faro→Alloy→Loki合成验证：型号A两次成功（1000/5999ms）、一次6000ms截断、一次离页、一次明确受理拒绝、一次未受理拒绝；型号B一次2000ms成功。验证A截断率1/3（离页/未受理拒绝不稀释）、B为0、成功P95小于6000、所有Loki面板语法和分布。服务端真实OTLP合成接收端验证字段安全、秒单位和独立请求/派发/赢家计数；真实模型与生产数据不参与。

下一步沿原框架TEST接入门禁：真实Cloud字段/指标名、按型号出图与采集丢弃核对后再生产启用；确认替代有效再退役对应纯监控SQL，旧业务事实与经营看板不删、不重启旧全量cron。候选源码通过不等于线上已经切源。
