# Grafana 遥测迁移：运维只读核验

日期：2026-10-29（Asia/Shanghai）。状态：规划研究，未修改产品代码、线上配置、数据源或看板，未读取环境变量值。

## 1. 核验范围与证据边界

- 本地仓库：`linshu368/ST_miniapp`，当前 HEAD `eec9f3f`，提交标题 `Fix request speed (#524)`；浅历史不能据此推断远端所有分支一致。
- 读取了根 `AGENTS.md`、`README.md`、部署/架构相关段落、`ops/railway/README.md`、`.railway/railway.ts`、`docs/grafana/README.md`、短剧看板 runbook、CI 与环境 example，以及现有性能采集入口。
- 远端只读查询：Grafana 数据源/看板查询与 metric/label discovery；Railway production 服务描述。没有查询 Supabase 业务行。
- 仓库配置是 desired state，线上服务描述是运行配置证据；本轮尚未取得运行镜像源码 SHA，不能声称本地 HEAD 已运行于 production。

## 2. 当前部署面

Railway `gallant-insight` 项目（`ce38c0c0-88cd-407a-9c04-06124cd42e97`）包含 API、支付快速对账 Worker、支付过期 Cron、VIP 提醒 Cron、支付告警 Monitor 五项服务；另一个可见项目 `aiero-prompt-platform` 不属于本次范围。

production 环境 `f03d6c61-84e3-434d-a81a-0ae209167ef5` 的 `stminiapp` 服务（`8bd593b7-7c40-4ab6-8808-c0863f27a22a`）只读返回：

- 状态 live、无 staged changes；source 为本仓库 `main`。
- Dockerfile `/ops/docker/Dockerfile.backend`，端口 8080；单副本、`asia-southeast1-eqsg3a`。
- 最新 deployment 为 SUCCESS，创建时间 `2026-10-28T09:50:07.052Z`；本工具返回没有 commit SHA。
- Railway tracing 与 auto-instrumentation 均为关闭。
- 变量名称清单中存在 Sentry 配置及 `DRAMA_TIMING_PERSIST_ENABLED`；未见 `OTEL_*`、Grafana、Alloy 配置名称。变量名称存在不能证明值、开关或采集效果，未读取其值。
- 前端由 Vercel 提供，浏览器跨域直连 Railway API。独立 Collector 的 Railway 私网地址不能直接供浏览器访问。

## 3. 当前 Grafana 接入事实

### 3.1 Cloud 托管后端已有，但未证明 ST 遥测已接入

- `grafanacloud-prom` 是 Cloud Mimir/Prometheus 查询数据源；配置的 exemplar 可指向 `grafanacloud-traces`。
- `grafanacloud-logs`（Loki）、`grafanacloud-traces`（Tempo）也已配置。
- 近 24 小时 Cloud Prom 对 `(st_|miniapp|textbot|http_server|llm|otel)` 的 metric discovery 返回空列表；Cloud Loki 近 24 小时标签 discovery 返回空列表。这是指定接口/范围的观察，不等于全平台永无数据。
- 后续对全部 metric 名称的查询遭遇连接器 transport error，不能把该失败当作“没有数据”的证据。
- 读取数据源的 OAuth 权限不等于应用的写入授权。Cloud 查询 URL 也不能直接充当 OTLP 写入 endpoint。

### 3.2 旧 TextBot 不能当作 ST miniapp 遥测复用

- `textbot-t1-latency-v3` 查询 `bot_first_response_latency_seconds_*`、`bot_full_response_latency_seconds_*`、`ai_first_token_latency_seconds_*`。
- `textbot-provider-monitor-v3` 查询 `ai_provider_calls_total` 与 `ai_provider_calls_failed_total`；面板未显式绑定有效数据源，templating 为空。
- `prometheus` / `prometheus-1` 两个手工 Prom 数据源未返回 URL。
- `prometheus-2` 指向另一个应用 `tgbotpicturev1-production` 的 `/metrics`；该地址看起来是 exposition endpoint，不是 Prometheus 查询后端。metric discovery 返回 404/Application not found。
- 因此不能把 TextBot 指标计入 ST，也不应为本任务修改这些旧数据源或假设它们是一套可用的 Collector。

### 3.3 ST 原有业务看板已减负

当前远端 `st-model-overview` 为“经营核心指标（轻量）”；四个旧 ST 看板为合并说明。`chat-first-token-manual` 和 `st-drama-playback` 独立保留。按 `docs/grafana/README.md`，旧全历史 cron 已退出，经营汇总只重算今天/昨天，读连接预算受限。不能为了迁移恢复旧全历史缓存任务。

## 4. 可以复用的工程基础

- `packages/backend/src/instrumentation.ts` 已在进程预加载 Sentry（Docker CMD 使用 `tsx --import`），trace 默认采样 0.2，排除 health。
- `packages/backend/src/lib/perf-metrics.ts` 已集中定义：路由模板+method+status_class+kind 的 HTTP 耗时、标准/生成接口分类、Prisma 操作耗时、事件循环延迟与 RSS。新出口优先复用这些观测点，不再安装第二套重复 Fastify/Prisma 自动 tracing。
- Pino 是现有服务日志规范；短剧已有共享 schema、鉴权遥测上传与结构化 Pino 报告。日志迁移可以增加出口，不重新定义业务事件。
- 仓库搜索未发现自有 Alloy/Collector 配置、OTLP exporter 或 Prometheus `prom-client` 接入；SDK 的传递依赖不代表可复用的运行时采集管线。
- `ci.yml` 已覆盖 Node 22/pnpm 9.15.9、Prisma generate、typecheck、lint、shared/backend/frontend/admin tests、前端/Admin build、backend Docker build。没有独立 Collector 验证/发布步骤。
- `railway-pr-env.yml` 为 feature PR 复制 development 并配置 preview；新遥测开关必须显式隔离生产，避免复制后把测试样本写入 production 标签。不要默认在每个 PR 再起一个 Collector。
- `.railway/railway.ts` 是显式 apply 的 IaC，不会随正常 push 自动生效。新增变量需纳入 preserve 清单，否则未来 plan 有误删风险；不能整体 apply 顺带改写现有服务。
- Dockerfile 仍为 Node 20，而仓库与 CI 要求 Node 22，文档已明确此差异。迁移必须验证所选 exporter/Collector SDK 的运行时兼容；不应顺带未经验证升级全部运行时。

## 5. 最小维护方案建议（尚未实施）

1. 每个稳定环境一个轻量 Alloy/Collector 收集服务，固定版本镜像与单份配置；只托管采集，不自建 Prometheus/Loki/Tempo 存储，不引入 Kafka/ClickHouse。
2. 应用通过私网 OTLP 推送到 Collector；不要误以为 Railway 上一个新容器能直接读取其他服务 stdout/文件。若选 stdout 方案，必须核验平台日志 drain/转发能力；未核验前不作为默认路径。
3. 浏览器沿用现有 Backend 鉴权遥测入口并扩展白名单契约；不得把 Cloud 写入凭证放在 `NEXT_PUBLIC_*`，不得浏览器直接连接私网 Collector。统一入口需 body/频率/字段/队列上限，拒绝无界 metric 名和标签值。
4. Collector 仅做批量、超时、重试、脱敏与路由；配置 CPU/内存/队列上限，暴露 dropped/queue/send_failed 指标。若要跨重启保留队列，需单独确认 volume 与磁盘预算；初期不能宣称 exactly-once 或零丢失。
5. 单一指标定义/观测点，避免 Sentry Metrics 与 Grafana 各维护一套业务埋点。保留 Sentry 现有错误/诊断能力；新增 OTel 时先确认与 Sentry 所拥有的 provider/instrumentation 不冲突。
6. 服务/页面 SLO 与版本对比由同一模板配置驱动；不为每页复制 collector、上传实现或查询脚本。全量计数/直方图不跟随 trace 采样，诊断 traces 可采样；失败/离页/缺报单列。

## 6. 上线前的确切缺口

- 需要从本 Grafana Cloud stack 的 OpenTelemetry connection 配置确认真实 OTLP 写入 endpoint；不能根据查询 URL 猜测。
- 需要 Cloud 写入 Access Policy token（最小 `metrics:write` / `logs:write`；本期不发 traces 就不授 `traces:write`）。凭证由用户在部署 secret 界面配置或通过合规 secret 机制注入，不在聊天、Git、日志输出明文。
- 需要确定 Collector 的 development/production 服务与容量预算，以及 private networking/健康检查方式；生产没有现成 Collector 的运行证据。
- 需要核验 Vercel Production/Preview 的 frontend release 与 API 目标，浏览器性能数据的 environment/release 标签不能取不可信客户端任意值。
- 需要 production 实际运行 commit SHA 与 baseline 时间窗；现有服务 SUCCESS 时间不等于代码版本对齐。
- 本任务待审核规划批准后才允许改产品代码、配置部署；生产上线及可能新增服务费用仍需按部署 gate 明确授权。

## 7. 迁移顺序与停止条件

1. 保留经营 SQL 与首字交付的业务权威事实；不新增仅为监控的数据库对象。
2. development 接 Collector 与复用的服务/页面观测点，以合成场景验证 PII、标签基数、无 secret 泄露、队列故障不影响请求。
3. 上线新独立 Grafana 工程看板，明确数据源/版本/环境/缺报；不覆盖现有业务入口。
4. production 双轨观察同窗请求量、延迟分母、采集成功率、出口开销与数据库负载；对齐后停止对应 SQL 高频监控路径，保留旧历史只读与恢复说明。
5. 采集抬高 API 错误/CPU/内存、队列持续溢出、维度爆炸、错误跨环境或敏感字段泄露时关闭新出口。关闭 Collector 不应中断聊天、计费、业务落库；不以恢复旧重 cron 作为回滚。

## 8. 规划必须锁定的验收点

- 页面耗时以统一 ready 语义区分导航开始、数据就绪、React 提交；首字、视频首帧沿用既有专用定义，不能把 HTTP200 或首网络字节叫页面可用。
- 工程产出同时看 P50/P95、样本量、失败/超时、覆盖率、环境/发布版本及冷/热缓存；不能用降低采样、减少输出、提前结束或排除慢失败来“优化”指标。
- 排序按慢/失败受影响量与真实用户耗时，不把高频快接口压过关键慢入口；上游模型等待与工程准备/数据库/渲染分段可解释。
- CI 可复用已有质量 gate；Collector 配置校验、遥测断路/队列满/标签拒绝、生产源对齐另列可执行验收，不以看板空白视为通过。
