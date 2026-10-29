# 工程遥测私网采集器

本目录只提供配置，**没有创建 Railway 服务、启用生产出口或写入 Cloud**。应用默认关闭；Cloud 写入凭证和预算需另行确认。

## 数据与职责

- 页面、角色扮演交互、短剧播放：浏览器复用现有测量 owner，通过 Faro 自定义信号直送 Cloud 托管浏览器入口。此容器不接浏览器流量。
- 服务端：显式 OTel Metrics/Logs → 同环境私网 Alloy → Cloud OTLP；不创建全局 tracer，不重复 Sentry HTTP/Prisma 探针，不启用 Tempo。
- 原有 Pino 继续写应用日志。只有代码显式投影的无正文事件进入 OTLP；本容器不抓取其他 Railway 容器 stdout。
- Supabase 保留经营指标、业务状态和所有 generation/attempt/首字回执/检查点/计费恢复；本次未新增表、查询或监控 cron。短剧旧分析副本的关闭必须另审消费者与双轨结果。

## 部署变量（无秘密值）

API 只设置 `ENGINEERING_TELEMETRY_ENABLED=true` 和 `ENGINEERING_OTLP_ENDPOINT`。根地址例子为 `http://alloy.railway.internal:4318`；不含 `/v1/metrics`、凭证、query。代码自动追加 signal 路径。未开启不构造 provider/连接；启用却填非法地址会在启动校验失败。环境采用现有数据库 target（test/production），release 取 `SENTRY_RELEASE` → `RAILWAY_GIT_COMMIT_SHA` → unknown。无需每事件查运营配置表。

Collector 单独配置：

| 变量                          | 来源/约束                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `GRAFANA_CLOUD_OTLP_ENDPOINT` | 当前 stack Connections/OpenTelemetry 的实际 HTTPS 写入根地址；不能用 Prometheus/Loki 查询 URL 拼凑 |
| `GRAFANA_CLOUD_OTLP_USERNAME` | 同一页给出的 OTLP 用户名；不能假设一定是 Prometheus 用户名                                         |
| `GRAFANA_CLOUD_OTLP_TOKEN`    | 仅该 stack 所需 metrics:write、logs:write 权限的写入 token；只放部署 secret                        |
| `DEPLOYMENT_ENVIRONMENT`      | test 或 production，用于 Collector 自监控                                                          |

TEST、production 应用与凭证分开；每个稳定环境先至多一个 Collector。不要给每个 PR 复制常驻服务。API 和 Collector 必须在相同可达私网环境。**不创建任何公网 domain/TCP proxy**；4318 是私网接收端，12345 是私网诊断端，不具备互联网认证防护。

镜像固定 `grafana/alloy:v1.21.0`。从仓库根构建：

```sh
docker build -f ops/observability/Dockerfile -t stminiapp-alloy:1.21.0 .
```

初始容器预算建议 256MiB/单副本；128MiB 内存限制器是拒绝数据阈值，不是容器 RSS 硬上限，需 TEST 观察真实资源后确认费用。无磁盘持久化队列、无新数据库、无额外远程写入服务。Railway IaC 仅 preserve API 的两个变量，本目录不自动 apply/创建 Collector。

## 本地配置校验

以下只是语法/组件连接验证，假值不得作为真实 Cloud 配置，也不应启动向该地址发送数据：

```sh
docker run --rm \
  -e GRAFANA_CLOUD_OTLP_ENDPOINT=https://example.invalid/otlp \
  -e GRAFANA_CLOUD_OTLP_USERNAME=validation-only \
  -e GRAFANA_CLOUD_OTLP_TOKEN=not-a-real-token \
  -e DEPLOYMENT_ENVIRONMENT=test \
  -v "$PWD/ops/observability/config.alloy:/etc/alloy/config.alloy:ro" \
  grafana/alloy:v1.21.0 validate /etc/alloy/config.alloy
```

`validate` 通过只证明固定版本能解析配置，不证明私网可达、Cloud 认证、摄取成功或 Grafana 查询正确。启用前还需真实 TEST 路径的合成样本往返验证，不调用付费模型、不使用真实聊天正文。

后端回归 `engineering-observability.test.ts` 使用真实 SDK 向仅回环监听的本地 JSON OTLP 接收端发送合成信号，覆盖安全投影、秒单位、单 provider、队列溢出和 401 失败隔离；受限运行环境必须允许本地回环端口。与现有 generation/fallback/perf/drama 测试一同运行。

## 指标定义

以下是 OTel 原始名字；Grafana Cloud 默认 Prometheus 翻译会给秒直方图追加 `_seconds`，并生成 `_bucket/_sum/_count`；计数器追加 `_total`。必须用目标 stack 的实际摄取样本再核验后缀，不能把源定义当已入库证据。所有应用指标都有 `environment`、`release`。

| 原始名字                                                            | 其他标签                                     | 定义/限制                                                                                                                                      |
| ------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `st_http_server_duration`、`st_http_server_requests`                | route/method/status_class/kind               | Fastify onResponse；不含 health；standard 与 generation 分开；生成连接关闭时间不是用户看见完整回复时间                                         |
| `st_prisma_operation_duration`                                      | model/operation/outcome                      | 应用等待 Prisma 操作的总时间，含等连接池，不是纯 SQL/纯 pool wait；outcome=ok/error/pool_timeout                                               |
| `st_runtime_event_loop_delay_seconds`、`st_runtime_rss_bytes`       | 无                                           | 复用原 10 秒采样器；loop 为这一采样窗口的 P99，不是跨时间可合并的原始分布                                                                      |
| `st_generation_prepare`                                             | platform/model/outcome                       | GenerationService 进入至首次真实 POST 的准备等待；ready/rejected/error；不是完整路由鉴权/上下文耗时                                            |
| `st_generation_attempt_dispatches`、`st_generation_dispatch_offset` | platform/model/role/phase                    | 只在真实 POST 派发回调计数；首字竞争 offset 从现有路由 requestStartedAt 起，直接路径从 GenerationService 起；不可混合两 phase 比较             |
| `st_generation_attempt_terminals`、`st_generation_attempt_observed` | platform/model/role/phase/outcome/dispatched | 首字竞争阶段观测结束或直接生成结束；未派发不虚构等待；对照派发数时过滤 dispatched=true、同 phase                                               |
| `st_generation_headers`、`st_generation_first_token`                | 同 attempt                                   | headers/首个有效公开思考或正文从实际 POST 派发起算；不是浏览器展示首字；失败不填 0                                                             |
| `st_generation_results`、`st_generation_duration`                   | platform/model/kind/outcome                  | 一次 GenerationService 调用的真实终态和总等待；kind=sse/json；成功、过滤、length、timeout、user_cancelled、cancelled、上游失败等分开           |
| `st_drama_server_stage`                                             | route/outcome/sign_cache/stage               | 复用现有 auth/db_read/assemble/sign；db_read 含 repository/网络等待，未执行的阶段不填 0；不是视频首帧                                          |
| `st_telemetry_failures`                                             | reason                                       | 本进程 logDropped（入口溢出条数）、logFailed（失败批次记录数）、metricFailed（失败导出次数）、instrumentFailed；不同单位不能相加当“丢失调用量” |
| `st_telemetry_log_queue`                                            | 无                                           | 尚未进入出口的日志数，不包括在途批次                                                                                                           |

`platform` 只是应用可确认的 OpenRouter/Venice 接入平台；不是 OpenRouter 内部物理供应商。未知为 unknown，不按模型或报错推断供应商。模型最多64个值、路由最多256个值、Prisma model/operation分别64/32；溢出归 other；每指标组合最多2000，SDK 溢出聚合有 `otel.metric.overflow`。模型/标签拒绝 URL query、UUID，禁止正文/思考/原始异常/用户和角色卡 ID。此界限也意味着异常映射或目录过多时必须显示 unknown/other，不能把它当精确模型榜。

首字竞争 `phase=first_token` 的 `first_token_observed` **不等于完整成功**；赢家还会在 generation.terminal 出现最终结果。败方 `race_lost` 是主动止损，不算供应商错误。`phase=generation` 是不走竞争的直接调用，终态 `completed` 才表示完整成功；内容过滤 `filtered` 和长度截断 `length` 独立，不混作传输中断。一次业务调用可能派发两路，但只有一条生成终态；不混用这两个分母。

首字前明确的 `delta.refusal` / `finish_reason=content_filter` 在 attempt 工程镜像中为 `filtered`，`finish_reason=length` 为 `length`；不改数据库业务 end_reason 或原有兜底/抛错/计费返回。若两路都失败，而整轮 GenerationResult 没携带明确 finishReason，整轮仍保持其实际通用错误/中断分类，不能从单路 attempt 猜成整轮过滤或长度截断。此类供应商原因须查看 attempt 分布，不能把逻辑生成结果分类当完整的过滤统计。

等待上游 headers 时，原业务可能把系统 TimeoutError 收口为 upstream_error；工程镜像保留实际已中止 signal 的安全分类 timeout，不改变业务结果或账务。若持久化裁决明确 user_cancelled，则优先采用用户主动停止分类，而不是根据计时器猜系统超时。

## OTLP 日志契约

body/eventName 为固定事件名，时间使用 SDK 时间，severity=INFO。Pino 不改；OTLP 不接收整个 AttemptObservation，不输出 discarded_response。允许事件：

- `generation.attempt_terminal`：environment/release/platform/model/role/phase/outcome/dispatched，可选 duration_ms。
- `generation.terminal`：environment/release/platform/model/kind/outcome/duration_ms。
- `drama.request_timing`：environment/release/route/outcome/sign_cache/total_ms，以及实际发生的 auth_ms/db_read_ms/assemble_ms/sign_ms。

resource 只含 service.name、service.namespace、service.version、deployment.environment.name；应用使用 ROOT_CONTEXT，避免复制 Sentry 当前 trace/session/request 关联信息。Loki 原生 OTLP 通常将资源映射为低基数标签，将这些事件 attributes 存为结构化元数据，**body 不是 JSON 字符串**。不要直接假设 `| json` 会解析出 duration_ms；以真实 stack 摄取样本确定 LogQL，未实测的在线面板应标待接入。

## 容量、故障与维护

- API：每15秒导出聚合 metrics；日志每1秒/64条批量，最多256条待发加一个在途批次；出口2秒超时、并发1；关闭最多等2.5秒。API 不自行无限重试，故障不会回滚/延迟业务结算。Metrics 聚合有基数界限，不按每次调用排队。
- Collector：128MiB limiter、5秒/256条批量、单批最多512项；内存队列最多128批、2消费者、5秒HTTP、最长60秒重试。重启/内存拒绝/队列满/断网都会丢；不承诺 exactly-once。
- Collector 每30秒只保留自身 otelcol exporter/receiver/processor、RSS、up；经同一 OTLP 出口发送。至少看 exporter queue_size/capacity、send_failed、enqueue_failed、processor refused 和 RSS；真实名字/后缀需 TEST 样本确认。Cloud 断连时这条自监控也不能送达，仍须从私网12345 `/metrics` 和 Railway Collector 日志看本地故障，不能声称 Cloud 实现全故障覆盖。
- API 的进程失败计数也可能因进程重启或同一故障链路丢失；logFailed 是失败批次内条数，不是可对账的全链路永久丢失量。开始/终态完备率只说明已被观测的记录，不代表全部真实访问覆盖率。
- 普通维护只需每次新增测量维护单一 producer 白名单及本配置对应键；不增加 Supabase 表/RPC/定时任务。不复制 Sentry 告警；先保留 Sentry 错误/trace，下钻指标用来定位待优化模块。

启用顺序：本地校验 → 独立 TEST Cloud 凭证/采集与查询验证 → 24–48小时基线 → 一周双轨 → 另批生产。只有接入成功后才审核撤下纯分析副本；业务表与首字计费恢复不在撤退范围。

回滚：API 设 `ENGINEERING_TELEMETRY_ENABLED=false` 后重启；前端使用自己的遥测开关。未完成启用时不需要任何 DB 回滚。Collector 停用只停止遥测，不影响业务；不要重启旧的重型全历史监控 cron。

官方依据：[Cloud OTLP](https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/)、[Alloy OTLP HTTP](https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.exporter.otlphttp/)、[内存限制器](https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.processor.memory_limiter/)、[Prometheus→OTLP](https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.receiver.prometheus/)。

## 兜底与业务首字专项接入（2026-10-29，TEST候选）

本节为专项候选源码；新架子已另行部署，本批埋点尚未发布，未切换或停用旧SQL看板。复用同一Faro与OTel/Alloy出口，不增加数据库I/O、配置查询、遥测路由、表、cron或采集服务。现有交付、恢复、赢家和一次计费事实继续保留；纯监控展示迁往Loki/Metrics，不能直接删掉计费资格所依赖的首份结果。

客户端FirstTokenObservation同一终态镜像增加公开目录的requested_model（所选型号，最多64种）与客户端本轮deadline_ms、trigger_ms。SSE start可选requested_model_id使用既有解析出的公开型号ID校正过期客户端选择，不新增读取；旧服务兼容客户端发送时快照，首帧前无法确认的情况不冒充服务端冻结事实。deadline/trigger是日志标量，不创建无限Prometheus标签；SSE修正旧缓存仍按原点击时钟，原6秒补报修复已一起适配。正文/已开启思考的首token进入React提交消息界面才是成功；供应商或服务端已有首字不代替客户端交付。关闭遥测、401、队列溢出或发送失败不得阻塞业务回执。

角色扮演看板增加专项行：按所选型号的总截止无字率（timed_out/已知前台首字结果，目标1%）、成功P50/P95、成功首字分布、结果样本与离页/后台/停止构成。默认6000ms，可独立选择历史10000ms；成功分布严格在对应预算内。仅原日志字段计数/聚合，不查询Supabase；没有数据不填成功或0毫秒。未知型号单列unknown/other，不把用户/会话/请求ID做标签。型号为公开目录稳定ID，动态新增不需改监控代码。

服务端额外四个计数器：st_chat_requests（创建本轮身份后一次受理）、st_chat_fallback_dispatches（真实兜底POST派发）、st_chat_first_token_selections（唯一首字赢家，winner与fallback_started）、st_chat_first_token_timeouts（既有总截止锁存一次）。全部按requested_model聚合，单位与\_total翻译须由实际TEST验证。st_chat_server_first_token仅供服务端排障，从路由时钟到首字选中，绝不画成用户总耗时。chat.first_token日志保留安全阶段、elapsed_ms、deadline_ms和trigger_ms标量，无正文、推理、个人身份或凭证。

触发率=实际兜底派发/受理；兜底首字选中比例=选中fallback/全部选中。后者仅表示服务端选择，不能冒称客户端最终收到的替代率；客户端主图仍独立裁决。原attempt指标/日志继续辅助定位错误、headers、首字和竞败，不把race_lost算供应商故障，不相加并行等待或相减独立P95。计数器increase是窗口估计，低样本需同时看客户端已收到终态样本。

现有SDK/Collector健康继续独立显示。开始/终态的窗口差额不是精确缺报，也不能据缺报证明用户未收到；两份信号同时丢失仍可能不可见。监控数据只用于观测，不用它做钱包扣费或补扣。当前不接自动调参或损失函数，也不把整条回复耗时混入首字专项。

本地复用固定Faro→Alloy→Loki合成验证：型号A两次成功（1000/5999ms）、一次6000ms截断、一次离页、一次明确受理拒绝；型号B一次2000ms成功。验证A截断率1/3（离页/受理拒绝不稀释）、B为0、成功P95小于6000、所有Loki面板语法和分布。服务端真实OTLP合成接收端验证字段安全、秒单位和独立请求/派发/赢家计数；真实模型与生产数据不参与。

下一步沿原框架TEST接入门禁：真实Cloud字段/指标名、按型号出图与采集丢弃核对后再生产启用；确认替代有效再退役对应纯监控SQL，旧业务事实与经营看板不删、不重启旧全量cron。候选源码通过不等于线上已经切源。
