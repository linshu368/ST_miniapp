# Official integration research

核对日期：2026-10-29。只做文档研究，非部署或凭证验证。

## 1. Grafana Cloud OTLP / Alloy

- 官方生产方向为应用遥测 → Alloy/OTel Collector → Cloud OTLP。Collector提供批量、过滤、脱敏及发送可靠性，但不代表没有丢失。
- 本任务已有 Sentry Node tracing，故第一阶段只显式导出 Metrics/Logs，不能为遵循示意图而注册第二个全局tracer provider。
- Cloud endpoint/授权从当前stack Connections取得，不能把Prometheus查询URL拼成OTLP写入URL。
- 来源：<https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/>

## 2. 浏览器官方Faro入口

- Faro支持浏览器/Next客户端，服务端另走OTel；自定义event/measurement可以使用现有业务ready，不需要重建计时状态。
- 本设计仅使用受支持的SDK传输和必要浏览器性能仪器，不开启重复fetch/error/console/tracing/Replay。配置和meta要白名单，不能默认把URL、query、session或个体信息全部传走。
- 优先Cloud托管浏览器接收端，避免自建公开遥测代理或让浏览器访问Railway私网。公开采集配置不等于Cloud私有写入凭证，必须区分。
- Telegram WebView兼容、账号是否已开通/采集成本、接收域名/CSP/允许来源，需要TEST与真机核验，文档不能代替。
- 来源：<https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/frontend-observability/instrument/custom-signals/>
- 来源：<https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/frontend-observability/introduction/supported-environments/>
- 来源：<https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/frontend-observability/instrument/>
- 自管Faro receiver虽可配置CORS、payload/rate limit、API key，但浏览器key是公开材料，CORS不是服务端强鉴权，初期不另自建该入口。来源：<https://grafana.com/docs/alloy/latest/reference/components/faro/faro.receiver/>

## 3. 为何不只接Sentry数据源完成本任务

- 官方Sentry datasource支持events/spans/statistics，可以为现有采样性能数据做Grafana图表。
- 其Metrics查询主要是session health，不可把它当当前Sentry SDK自定义distribution完整导出的已验证替代。
- 当前trace采样和配额不保证全量；仅查询sampled spans不能满足页面超时/覆盖/预算验收分母。此替代方案可作辅助，不作为本任务主链。
- 因此保留Sentry错误/trace drilldown，Grafana遥测复用相同测量owner另加出口，而不双建全套自动采集。
- 来源：<https://grafana.com/docs/plugins/grafana-sentry-datasource/latest/>
- 来源：<https://grafana.com/docs/plugins/grafana-sentry-datasource/latest/query-editor/>

## 4. 可靠性和标签

- exporter队列/重试必须有限并可观测；内存队列重启、队列满、长期断网均可能丢数据。持久化队列也不是exactly-once。本任务初版不先上Kafka或磁盘WAL服务。
- Metrics与Loki索引只选低基数集合。用户/请求/trace/角色卡ID和完整错误不做标签；受控个案ID如确有需要只能进非索引明细。
- 来源：<https://opentelemetry.io/docs/collector/resiliency/>
- 来源：<https://grafana.com/docs/loki/latest/get-started/labels/>
- 来源：<https://prometheus.io/docs/practices/instrumentation/>

## 5. 实施时仍需验证的技术事项

- Faro SDK与当前Next14/React18/Sentry10.69的支持版本、meta过滤及批量队列选项，以实际安装锁定版本为准。
- OTel Metrics/Logs包要锁兼容版本，显式provider避免全局tracer冲突；当前生产Docker Node20与CI Node22差异须在选择版本时验证，不顺带升级。
- Grafana前端measurement在Loki中的实际字段结构决定LogQL模板；必须先合成样本入库，再保存和实跑面板，不靠猜字段。
- Alloy当前实际镜像须固定，validate和shutdown/队列失败验证后才部署。应用OAuth查询权限不能代替写入token。
