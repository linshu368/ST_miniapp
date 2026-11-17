# Design — 低维护工程性能观测

## 2026-10-29 增补设计（用户批准）

- 复用 env-tags、Grafana record 白名单、observeDramaMedia 每 src 生命周期和三张看板；现有业务和计费状态不变。不新增依赖、API、表或通用框架。初始实现包含dev630e与首页owner修复的PR537 head9bb6；发布复核确认main05077174已包含9bb6及另一任务10个文件的生产补修，因此当前分支安全快进到05077174。本轮16个已修改文件与上游10文件无交集，快进前后本轮binary diff摘要相同，保留生产补修原样。
- 所有前端信号在入队前补 tg_platform/net_type，平台惰性读取，不依赖 Sentry 开启；不在真正发送时重读。默认 .\* 保留历史无标签，具体筛选才排除缺标签。4g 是有效速度等级，不是蜂窝类型；unknown 不等于弱网。后端型号兜底面板不适用客户端分层，明确标识。
- 新白名单事件 drama.playback_window 同条成对记录 playing_ms/rebuffer_ms，有限非负整数，source_measurement_version=drama_playback_v1。窗口内 delta，每30秒及暂停/seek/hidden/结束/错误/dispose flush，清零且不重试。仅在有效观察时有一个计时器，dispose 清理；无逐帧/逐timeupdate上报。初始加载不计，真实 playing 和首帧/自然推进确认后开始，独立于已锁存 autoplay_blocked 启动终态。
- 时长用前台单调 walltime，不用媒体进度差；卡顿为真实播放后的 waiting（非stalled）。未恢复即退出也保留已发生的卡顿。每窗口起点冻结维度，起止网络不同标mixed；不宣称网络整窗稳定。超长事件循环空洞不补成有效播放，最长可信间隔与策略以实现测试固定。
- 看板只加实际播放总时长、加权卡顿占比与窗口数；占比=Σrebuffer_ms/Σ(playing_ms+rebuffer_ms)，同条窗口集合、分母为0无数据，不平均单窗百分比。不宣称全量送达、独立用户数或逐请求闭环。
- 失败隔离、队列、超时和CORS沿既有出口；没有业务写入/事务/补偿，重试不适用，遥测丢失接受但不得污染业务。新字段向后兼容，旧时段无新数据。关闭出口或回退前端即停止，原Sentry/业务事实保留。

状态：2026-10-29 用户已批准实施；生产启用独立确认。页面、角色扮演、短剧是三个主看板，基础服务仅下钻。

## 1. 复用与最小架构

业务事实继续 Supabase → 现有轻量经营/首字业务看板。

新增遥测采用两条受控出口：

1. **浏览器**：复用 `lib/perf` 的 page/action/request/首字/短剧 owner → 单例白名单出口 → 官方 Faro SDK 的自定义 measurement/event 传输 → Grafana Cloud 托管浏览器接收端/Loki。SDK 不启用另一套自动 fetch、错误、console、tracing 或 Replay。仅选缺失的浏览器 Web Vitals 仪器作为补充。浏览器使用公开采集配置，绝不接收 Cloud 私有写入 token。
2. **Backend**：复用 `lib/perf-metrics.ts`、Prisma wrapper 与 generation 实际生命周期 → 显式 OTel Metrics/允许字段的 Logs exporter → 同环境私网 Alloy → Cloud Metrics/Loki。使用独立 meter/logger 实例，不注册第二个全局 NodeSDK/tracer provider。Pino 保留为唯一应用日志规范；只把批准的结构化诊断投影导出，不无差别复制业务 stdout。

Sentry 保留现有错误与采样 trace，工程榜排障可跳 Sentry；Tempo 本期不新增重复追踪。Cloud Faro 接收端可避免自建浏览器鉴权/限流/遥测代理，不经过业务 API 或 Supabase 用户鉴权查询。若该账号/Telegram WebView 的受支持接收端不可用，停止浏览器上线阶段并提出独立变更，不偷偷改成无限制自建入口。

浏览器接入首先用选定SDK和本账号真实payload做一条端到端验证：在Loki中可按env/release/route/version筛选，准确得到合成样本的P50/P95、预算超标和起终态计数；该验证在Gate 1完成，不等完整看板开发后才验证数据形状。能力/字段不兼容时停止浏览器阶段并重新审核选型，不用空图或缺失字段降级冒充验收。

每个稳定环境最多一份 Alloy 配置；首轮 TEST 验证不为每个 PR 创建服务，Preview 数据使用 test 环境且可关闭。只接 Cloud 托管存储，不自建 Prom/Loki/Tempo。

### 复用决策

| 现有能力                                                     | 决策                                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `PagePerfTracker/page-tracker/usePageReady/action-tracker`   | 扩展同一状态 owner 的终态和统一出口，不另建页面生命周期。                                            |
| `timedFetch/ApiAttemptTiming/apiClient`                      | 保留原 headers 定义；新增明确命名的 queue/headers/body/logical-total，计时归同一 API helper。        |
| `lib/perf-metrics.ts/lib/db.ts`                              | 同一观察值出口至 OTel，避免双 Fastify/Prisma 自动计时；已有 Sentry 暂保留。                          |
| `first-token-observation`、`generation/first-token-fallback` | 镜像允许字段；业务回执/恢复/赢家身份/计费写入保持。                                                  |
| `drama-timing/observer`、`routes/telemetry.ts`               | 复用测量定义。若旧纯分析持久化已启用，新链路验证后才能停对应分析副本；先查消费者，不删业务事实。     |
| shared DTO/schema                                            | Cloud 官方浏览器协议不新增业务 HTTP DTO；若新增任何跨应用 HTTP 形状，先 shared 定义再生产者/消费者。 |
| 旧 TextBot Prometheus 看板                                   | 非本项目，不复用、不修改。                                                                           |

## 2. 测量语义与版本

### 页面

- 真实首次打开：document navigation 起点 → 该入口业务 ready；同时保留 bootstrap/Telegram ready 的分段。SDK 启动前崩溃或用户未执行 JS 的访问不可观测，不能称全站真实访问分母。
- 站内导航：被支持的 Link/router 用户导航意图 → 目标页面业务 ready。pathname mount → ready 单独保留旧定义，不冒充点击全程。浏览器返回/直接进入明确 `navigation_type`。
- 已有 `content`（缓存可用）与 `fresh`（网络最新）分开；首份终态固定，不因迟到 ready 抹去预算超标事实。
- 每次观察记录开始及就绪/失败/离开/后台终止等结果；声明前台有效时长与墙钟时长，不把后台时间扣掉后仍称真实端到端耗时。覆盖仅指观测到的开始/已知终态，不保证每份遥测必达。
- 明确区分源端已开始/源端已终态、接收端已到达的开始/终态、SDK和Collector丢弃。面板可计算的是同一口径已到达开始对应的终态完备率，不是全访问覆盖；开始与终态一起丢失时内部比率可虚高，故采集丢弃/健康必须并列，不能把95%内部完备率说成95%真实用户被覆盖。
- `/dramas`、`/dramas/:id` 增加统一页面声明；视频 first-frame/playback-ready 继续独立，不以列表加载或 `canplay` 替代。
- 将 route 匹配/ready 定义/预算登记收敛到现有 `lib/perf` 的有限清单；未知模板归 `other`，新增页无声明显示未覆盖。

### API / 服务 / 模型

- 客户端 logical API total 含排队、有限重试、下载及解析；单 attempt headers 与 body 分段明确。不得为了测量改变超时、重试或业务返回。
- Fastify duration 为服务端响应完成，普通 JSON 与 generation/SSE 分开；SSE 200 不代表模型完整成功。
- Prisma operation duration 包含客户端等待，不称纯 SQL 时间或独立 pool wait。PostgREST/外部 HTTP 与 Prisma 分开。
- generation prepare、真实 dispatch→首有效 token、流终态、客户端提交首字、完整回复分别输出；`first_token_observed` 只意味着竞争首字结束。
- 用户取消、race loser、过滤、超时、业务拒绝、供应商传输故障分别计数。只有真实 dispatch 才计上游 attempt；供应商未暴露信息仍 unknown。
- 不相加并发 primary/fallback；不相减两个独立 P95 推导阶段。需要阶段归因时使用同一 request 的配对测量/现有 trace。
- 修改起终点/时钟的指标升级 measurement_version，不重算历史，不把 Date.now 和 monotonic 样本混为同版。

## 3. 工程看板与验收预算

新增一个“工程性能与优化验收”入口，优先三大类：页面体验、角色扮演交互、短剧播放。API、runtime、采集健康为折叠下钻，不为每页复制 dashboard。

工程表每行至少：owner类别、页面/route、请求种类、样本/覆盖、P50/P95、预算及超标量/率、错误/超时/放弃率、release、排障入口。上游等待单独标示；工程负责前置/调用策略/交付，不用供应商时间掩盖自身慢点。

排序：先看关键页面失败/超时与受影响量，再看同预算超标调用数；完成样本的超额等待负担可作辅助。不得把不同口径合成一个不透明总分。分布/样本至少同环境、measurement_version、route/kind、前台、缓存与粗平台/网络分层。

现有 4s page stall / 3s ordinary API slow 只是历史诊断预算参考。上线先采同口径 24–48h 基线，预算在仓库单份配置审核后确定；未校准行显示待基线，不伪造达标。默认稳定比较至少 100 个同类样本，低于门槛仍展示失败与计数、分位数标观察；覆盖不足 95% 或持续丢弃时不输出“优化已验收”。这些门槛是本任务初始保护规则，不是数学上的置信保证。

验收组合：同群体 P95/预算超标率改善，成功/超时/覆盖不退化，业务输出/权益不变，并在相近同窗或灰度中复现。仅前后相关不声称因果；有偏样本和版本/路由/网络流量变化要注明。

## 4. 安全与可靠性

- 有限指标名、attribute key 与值；聚合标签不含 user/character/request/trace ID、完整 URL/query、原始错误消息。ID 仅经审查后进入短保留诊断字段，不序列化 `AttemptObservation` 的正文/思考片段。
- 前端 beforeSend/白名单净化 Faro meta（URL/query/user/session/browser信息），只留必要粗平台/网络和已审核 measurement；禁默认错误/console 全收集。token/完整initData/正文/请求响应体零上传。
- metric/event 出口不抛错，批量队列和 payload 有上限，短网络超时与有限退避；后台/离页发送 best-effort，不持久化无限离线队列，不阻塞业务等待上传。
- 后端仅私网接收；Cloud write token 仅 collector 最小 metrics:write/logs:write。测试/生产分离；service/env/release 从部署构建配置确定，浏览器自报只能作为非权威遥测。
- Cloud浏览器intake分别配置TEST/production app、来源域名allowlist、流量/摄取配额及异常流量止损。公开app配置可被复制，CORS不是强鉴权；浏览器数据不用于账务、安全授权或强真实性判断。验证实际账号的限流/配额能力后才开生产，不能假设托管等于无限免费或天然防伪。
- Collector 队列/发送失败/丢弃、SDK dropped/disabled 可见；空数据不等于健康。资源有明确 CPU/内存/队列上限；初版不引入持久化 volume，不承诺 zero-loss/exactly-once。
- 关闭 exporter、collector 崩溃或 Cloud 故障，不影响计费、回复保存和恢复；有界 shutdown flush。
- 无新增数据库事务、查询、轮询或遥测配置查库；业务退款/补偿/幂等沿既有路径，不引入监控结算权威。

## 5. 发布、维护与恢复

顺序：刷新已审核 dev 基线并隔离分支 → TEST collector/托管前端接收 → 出口默认关闭的应用代码 → 合成失败与性能负载对照 → 工程 dashboard 有真实样本 → 生产另批开启 → 至少 24–48h 基线，建议一周双轨 → 有替代证据后下线纯监控 SQL/旧分析副本。

维护只有：现有计时 owner、有限指标出口、单份 Alloy、源代码版本化看板/预算；新增页面一处清单+ready。Sentry 错误/trace 的升级周期不因本迁移增加第二套 auto tracing；不新建 Sentry 数据源，因为当前自定义 Metrics 并非该插件 session-metrics 的等价接口，采样 span 也不替代完整计时分母。

上线需要真实 ingest endpoint、最小权限 secret、前端公开接收配置、版本映射和新增采集服务预算；不由 query URL 猜测，不在聊天输出秘密，不以本地完成代替上线。

停止条件：PII/secret、高基数爆炸、跨环境污染、稳定队列溢出、可测业务性能或错误退化。回滚关闭新出口，恢复原看板链接/查询的已减负版本；不恢复全历史 cron，不改业务 attempt/回执事实。历史量纲保留，必要 forward-fix；不做删列/回填。

## 6. 当前范围为何不再扩大

本次是建立测量与验收能力，不是实施所有性能优化；独立客服、全套基础设施profiling、Kafka/数仓、第二套分布式trace、自动调参/自动供应商下线均不做。新遥测可丢少量诊断，账务不能丢：两者分别归属，不为了“完美采集”把业务库重新变成日志队列。
