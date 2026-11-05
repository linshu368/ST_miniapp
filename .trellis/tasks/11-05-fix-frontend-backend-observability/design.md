# 技术设计

## 1. 范围与链路

```text
Frontend page/action
  -> page tracker / apiClient / stream client
  -> Next proxy（仅 lobby）或 Fastify route
  -> Backend feature / in-process job / standalone script
  -> Sentry metrics/errors + Faro/OTLP metrics/logs
```

仅修改 Frontend、Backend 和配套 docs。Fastify HTTP 全局 hook、Sentry SDK 初始化、Faro exporter、OTLP provider 均复用，不引入新监控 SDK、消息队列、数据库对象或外部契约。

## 2. 复用调研

- 页面：复用 `ENGINEERING_PAGE_ROUTES`、`usePageReady`、`markPageFailed`；不另建页面 tracker。
- HTTP：复用 `timedFetch`、`ApiAttemptTiming`、`recordApiAttempt/Total` 和 inflight tracker；扩展一个“fetch + consumer”生命周期，避免第二套请求状态源。
- 聊天：复用 `RoleplayReplyTiming` 的匹配终态 commit；通过有界 callback 同步投影 Sentry，删除 refetch 后的旧终点。
- 流式润色：复用 Sentry Metrics、`recordEngineeringMeasurement/Event` 与既有 parser；不建立通用流框架，避免把 SSE/NDJSON 不同协议错误抽象到一起。
- Lobby proxy：复用 `@sentry/nextjs` 和浏览器 API timing；服务端只增加手工安全指标及 `Server-Timing`，不启用全量 Next server auto-instrumentation。
- Backend：复用 `startEngineeringTelemetry`、Sentry metrics/capture 和 `config.engineeringTelemetry`；增加一个 background/job helper，供现有 job/script 调用。
- 检索过但不扩展：shared DTO、数据库函数、repositories、LLM generation telemetry。此次无外部契约或数据库 shape 变化。

## 3. 计时定义

### 3.1 普通 HTTP

- `api.headers.duration`：dispatch/fetch 开始到 `fetch()` resolve。
- `api.request.duration`：fetch 开始到 response body 消费、JSON 解析和 envelope 判定结束。
- Grafana attempt：queue、headers、body；logical total 包含安全 retry/退避。
- timeout AbortController 覆盖 fetch 与 body consumer；caller abort 保持 abort，不转成 timeout/network error。

`timedFetch<T>` 接收 consumer callback。只有 consumer settle 后才清 timer 和 inflight；headers 到达时只投影 headers metric。内部 timeout 统一转为 `RequestTimeoutError`，外部 abort 原样传播。

### 3.2 页面

ready 只等待页面主要承诺：编辑器基础数据/本地草稿、创作数据 overview、作者第一页、心愿列表/详情。分页、图片、详情 sheet、后台 fresh 不进入 content-ready。

### 3.3 聊天与润色流

- 聊天 full reply：点击 send/regenerate 到匹配 request/revision 的终态消息 React commit。
- durable recovery：仍用 `roleplay.recovery`，不与可见完成相加。
- Creator polish：start → headers → first non-empty delta callback → protocol done/terminal。收到 done 后立即结束，不等待 EOF；reader cancel/cleanup 不进入 full。

### 3.4 Backend background jobs

固定 labels：`job`（白名单/有界）、`outcome=success|partial|error|skipped|cancelled`。上报：

- Sentry `background_job.duration` / `background_job.runs`，error 时 captureException；
- Grafana `st_background_job_duration` / `st_background_job_runs` 与低基数 event；
- standalone 启动 OTLP，结束时先 shutdown provider，再 `Sentry.flush(2500)`；失败一律吞掉，不改业务退出码。

## 4. 可靠性设计

- 超时：HTTP timeout 延伸到 body；Creator polish 保留 190 秒；telemetry shutdown 最长 2.5 秒。
- 重试：不新增；GET 仍最多一次安全重试，POST/流不重试。
- 幂等/并发：不改变业务写入、job lease、worker running guard、支付状态机或 SSE 协议。
- 事务/补偿：不适用；无数据库改动。Telemetry 失败仅丢观测。
- 降级：Sentry/Faro/OTLP 未配置或失败时所有 helper no-op/contain error。
- 限流/容量：只使用有限 enum/route template/job name；不输出 request/user/order/attempt ID 作为指标 label。
- 可观测性：每个 terminal 只提交一次；success/error/abort/background 互斥。

## 5. 最小充分方案

新增最多一个 Backend job helper 和一份最终清单文档；Frontend 在现有 perf 文件中扩展。拒绝引入统一 tracing framework、Tempo、数据库 job 表、全局 Pino transport 或跨协议 stream abstraction，因为当前缺口可由既有 Sentry/Faro/OTLP 入口补齐。

离线 drama export/parser 不连接生产服务、不构成用户运行链路，继续不初始化 exporter；在清单中明确排除。手工 seed/translate 属于可能操作 TEST/production 的 Backend runtime script，纳入 job terminal/error。

## 6. 演进、发布与恢复

- 指标兼容：保留 `api.request.duration` 名称但修正为 total，同时新增 `api.headers.duration`；发布 dashboard 前按 release 分窗，禁止跨版本混算。
- 聊天旧指标名保留、终点改为 commit；Grafana 原本已经是 commit 口径，发布后两个消费者统一。文档明确版本边界。
- 新 page/API/job labels 仅新增有限序列；旧 dashboard 不会失效。
- 发布顺序：Backend helper/scripts → Frontend timing/pages/streams → dashboard/清单核对。两端均向后兼容，无协议依赖。
- 停止条件：遥测导致请求异常、body timeout 误杀、事件量异常、PII/高基数、job 退出延长超 2.5 秒。
- 回滚：按文件回退 timing/helper；环境侧可关闭 `ENGINEERING_TELEMETRY_ENABLED`/Frontend Grafana，不需 DB 回滚。

## 7. 可验证性

- 扩展既有 `request-timing.test.ts`：headers 快、body 慢/超时、caller abort、metric failure。
- 扩展 `api-timing.test.ts`/`route-template.test.ts`：静态角色路径、creator/wishes、六页面 registry。
- 扩展聊天 hook/roleplay tests：Sentry terminal callback 在 commit，只一次，不在 invalidate 后上报。
- 扩展 creator stream tests：first text/done、EOF without done、abort、timeout、telemetry failure。
- 扩展 Backend engineering observability tests：job labels/outcomes/duration；必要时现有 job tests断言调用。
- 执行 Frontend/Backend typecheck、相关 tests、lint、build、complexity 与 `git diff --check`。
- 人工场景：慢 chunked JSON；聊天 done 后 detail 慢；creator polish done 后连接延迟；job error 与 graceful shutdown。
