# Implementation plan

状态：用户2026-10-29已批准按三条体验主线实施；可start并改产品代码/本地验证。不得自动发布生产或创建未确认费用的服务。

## Gate 0 — review

- [x] 用户批准创建任务与规划；主/前端/后端/部署研究完成。
- [x] 用户在最新规划摘要和远端版本核验后明确批准实施，重点页面/角色扮演/短剧三条主线。
- [x] dev=`4e1ed2eb`与main=`eec9f3fd`代码树一致；只存在本任务规划目录。生产运行SHA仍为独立上线门禁。
- [ ] 复核 Faro 浏览器接收配置、OTel metrics/logs 与 Sentry 10.69/实际 Node20容器及Node22 CI兼容；不盲升运行时。

## Gate 1 — telemetry foundation, TEST only

1. 在现有 `lib/perf`/backend metric owner 增加有限白名单出口与环境开关，默认关闭；不另建通用事件平台。
2. Backend 显式 meter/logger provider、手工 metric/event exporter；不注册新的全局 tracer/自动HTTP/Prisma探针。允许字段 Pino 日志保留，追加非阻塞OTLP投影；不可读取另一个 Railway service stdout。
3. 浏览器官方 Faro 仅 transport/custom measurements（必要 Web Vitals），不开自动错误/console/fetch/tracing/replay；托管 collector，不自建需查库鉴权的上传路由。单例、安全beforeSend、bounded buffering，防止自身采集递归。TEST/production独立app，限定来源域名、摄取配额/异常流量止损；公开配置不视为强鉴权。
   - 先用选定SDK和本账号接收端跑一条端到端合成查询：P50/P95、超预算、route/release/version、开始/终态计数；验证Loki真实字段与LogQL。不能等T5才验证Faro measurements可查询性，失败即停止浏览器阶段并重新审核。
4. `ops/observability/` 固定版本 Alloy 与唯一配置、配置校验脚本/说明；后端经私网、Cloud credentials仅collector部署secret。`.railway/railway.ts` preserve 必需配置，不能整体apply顺带改生产。
5. 默认每个稳定环境至多一collector，不每PR复制；明确新费用/资源预算后再创建服务。缺少写凭证可完成本地/合成测试，不声称Cloud已接入。

## Gate 2 — measurement correctness

1. 统一页面清单与ready定义，补dramas及同模板不同ID，分开document launch/SPA click/mount，旧口径版本不变。
2. 为现有page/action lifecycle补已知终态与stall latch；错误页可交互不视为业务加载成功；离页/后台/缺报独立。
3. API helper复用ApiAttemptTiming补queue/headers/body/logical total，不改请求重试/截止语义。
4. Backend普通JSON、流式生成、DB operation、runtime、生成prepare/上游首字/流终态分别测量；dispatch/finish/cancel/hedge loss只归一次对应结果。
5. 首字v4/attempt/checkpoint/计费与quota的权威持久化完全保留。drama纯分析副本待消费者核对与双轨验证后才可关闭。

## Gate 3 — dashboard and release validation

1. 新建独立工程dashboard源JSON，模板变量env/release/route/kind/measurement_version；明确Metrics和Loki，排障链接到既有Sentry，source JSON不是在线验收。
2. 页面/API榜、生成分段、runtime和exporter健康用同一模板；样本/失败/覆盖与P50/P95/超预算同时展示，空/未覆盖不填0。
3. 用固定合成样本逐panel验算边界/单位/分母；已有 Grafana datasource须明确UID，不碰其他TextBot。
4. TEST/Preview通过后另批production，先开采集不撤旧；记录SHA、环境、部署/回滚目标和实际采集证据。先24–48h基线、建议一周双轨；业务SLO预算之后审核而非假设达标。
5. 仅替代成功后退役相应纯监控SQL/分析副本，保留业务看板、历史和全部计费/恢复写入；不要重启旧重cron。

## Validation commands and failure matrix

实施前阅读各包测试规范；扩展现有相关测试，而非另建临时harness。已审核本计划后，安全/队列/导出隔离如现有文件无覆盖，可添加最小回归测试以锁定下列风险。

```sh
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend test
pnpm -r typecheck
pnpm lint:imports
pnpm lint
pnpm format:check
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin build
pnpm test:ui --grep '@profile|@roleplay|@chat|@image|@drama'
```

- 按既有 `packages/ui-tests/README.md` 扩展虚构场景：首次/SPA、缓存/网络、前后台/离页、快切ID、错误ready、慢headers/body、排队重试、stream中断；不新造第二套mock。
- telemetry down/timeout/401/429/oversize/queue-full/restart/关闭：业务结果不变、无未处理rejection/无递归、队列回落；报告CPU/RSS/包体和请求延迟的同负载有无出口对照。
- secret/正文/query/ID标签拒绝、未知route/provider归一；指标版本隔离；失败/取消/hedge loser不能变成功。
- 覆盖分母验证：接收端已观测开始对应的终态完备率，与源端计数、SDK/Collector丢弃分开展示；模拟start+final同时丢失，内部完备率不能据此宣称真实全访问覆盖。95%是初始数据质量门槛，不是统计置信保证。
- Collector 使用选定固定版本的 `alloy validate` 验证配置；具体命令在实现固定镜像后写入runbook。OTLP contract用本地接收端合成数据校验，不生成付费模型流量。
- 测量账务边界附近改动时运行既有 `bash scripts/test-first-token-fallback-local.sh`；本地PG/假模型通过不等于真实计费验收。
- 真实Telegram/WebView：后台/返回、首字commit、视频首帧及采集被拦场景；TEST真实业务使用另行授权测试身份，不压生产、不导出业务行。
- 不能运行的检查逐项标原因/风险；缺真实Cloud样本时保留“待接入”，不得用空图当通过。

## Maintenance / recovery gate

- 变更清单、指标定义、预算、部署变量名（无值）与runbook同提交维护。
- 单独审核生产启用/新增服务费用；commit与push分别按仓库门禁审批。
- shutdown有界；关闭新出口即可止损；原计费恢复链路与轻量经营查询均不受影响。
- 收尾更新所列模块facts并审阅 `module-updates.json`，不把设计计划写成已部署事实。

## 2026-10-29 生产真机验收补修：播放器测量归属

- 证据：用户明确完成真实聊天和短剧播放。生产 Faro 已有首字 observed/完整回复 complete/render；短剧 startup 两次均在不到一秒被 route 判为 left，仅有 navigation，且用户实际看到播放。唯一 left 写入在 DramaTimingTracker.route，仅接受详情路径；首页 embedded 播放器可先于根路由 effect 创建，提前终态后媒体 marks 被忽略。
- 复用现有 DramaTimingTracker、DramaPlayer 及已有 drama-timing 测试，不新增计时器/上报入口/依赖。最小补充明确页面归属，首页与详情不能互相继承同一待完成观察；旧组件迟到更新不能抢回新观察。
- 验收：复现子播放器先创建、根 route('/') 后提交；正确首页仍能记首帧+playing；首页/详情同剧与不同剧切换、离开非播放器页、后台、已终态幂等和旧 flow 不抢占。扩展既有测试，不新增测试框架。运行 frontend 相关与全量测试、typecheck/lint/build；复核 React primitive deps、媒体 src/retry 业务 effect 不重建。
- 发布：保持当前生产业务树，只修测量与必要调用参数，用户此前明确授权生产发布及独立分支推送继续有效；仍不绕过 PR 人审门禁、不动 main/dev。先完成独立代码审核和固定 source tree，再构建/发布，回查真实 Cloud 数据。没有新真实播放成功样本前仍标部分核验。
