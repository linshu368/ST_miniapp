# Technical Design

## 1. Boundary and metric semantics

仅修改 backend 内部观测：

| 指标                           | 普通 HTTP          | 聊天 SSE                                      | 用途                                 |
| ------------------------------ | ------------------ | --------------------------------------------- | ------------------------------------ |
| `http.server.duration`         | 响应完成           | 首个成功写出的非空正文/思考字符；无首字则终态 | 日报“接口响应 P95”                   |
| `sse.stream.duration`          | 不记录             | 完整连接从路由受理到流结束                    | 完整生成、容量与中断长尾             |
| Sentry 自动 `http.server` span | 完整 HTTP 生命周期 | 完整 HTTP 生命周期                            | trace waterfall，不冒充首字 SLA      |
| Grafana 首字指标               | 原样               | 原样                                          | 服务端选中、浏览器 commit 分阶段诊断 |

不修改 shared SSE event、前端 consumer、生成引擎、计费或数据库。

## 2. Data flow

1. `streamTurn` 创建每请求的 Sentry SSE 响应计时器，并把该 reply 标记为“首字口径已接管”。
2. `createReplyStreamSink` 成功执行 `raw.write` 后检查事件：仅非空 `delta`/`reasoning` 触发一次 `onFirstVisibleToken`。
3. 计时器将路由进入到该时刻的耗时写入 `http.server.duration`，属性仅含 route、method、2xx、generation、`response_milestone=first_visible_token`。
4. `streamTurn` 的 `finally` 调用终态兜底；若首字已记录则无操作，否则按最终 status 记录 `terminal_without_visible_token`。
5. 全局 `onResponse` 遇到被接管的 reply 时不再重复写 `http.server.duration`，改写 `sse.stream.duration`；未进入 `streamTurn` 的早期 4xx 保持原逻辑。

## 3. Reliability design

- **超时/失败：** 无首字时在终态补记；首字超时、上游拒绝、计费拒绝和 socket 断开不会消失。
- **有限重试：** 观测不重试，避免重复指标；业务既有重试/兜底不变。
- **幂等/并发：** 每请求闭包布尔锁与 `WeakSet<FastifyReply>`，同请求只记录一次，无跨请求共享可变计时状态。
- **事务/补偿：** 不写业务数据，无事务和补偿需求。
- **降级：** 所有 Sentry 调用 `try/catch`；失败只增加 `perf.instrument_error`，不向业务抛错。
- **限流/容量：** 每个聊天 SSE 最多增加一个首字分布点和一个完整流分布点，属性均为固定低基数。
- **可观测性：** 保留完整流指标与自动 span；明确日报查询口径，避免修正一个误差后丢失生成长尾。

## 4. Minimal sufficient solution

复用现有 sink 和 Metrics 文件，只新增可选回调、一个计时器 helper 与两处接线。不新增文件层级、公开 API、依赖、数据库对象或通用框架。拒绝提前结束 Sentry 自动 transaction：它应忠实表示底层连接生命周期，强行结束会破坏 trace 父子关系和错误归属。

## 5. Evolution and recovery

- 兼容：外部 SSE 协议、HTTP 状态、客户端与历史指标均兼容；新 release 后同名 `http.server.duration` 对两条聊天 SSE 的语义变为首字响应。
- 发布：Backend 单独发布即可；日报从新 release 起用 Metrics 查询，跨发布比较必须按 release 分组并标注口径切换。
- 停止条件：若新 release 首字样本数显著低于聊天请求数、`perf.instrument_error` 增长或业务流异常，停止用新指标做 SLA 判断。
- 回滚：移除 route tracker/sink 回调并恢复 onResponse 的统一指标；无迁移和数据回填。历史数据保留，不能混合新旧口径重算。

## 6. Verification

- sink：`start`、空白 token 不触发；首个成功非空 token 触发一次；写失败不触发。
- metrics：首字与终态兜底互斥；被接管的 SSE onResponse 只记完整流；普通路由不变；Sentry 抛错不影响业务。
- 运行现有后端相关测试、backend typecheck、全量 backend test（若时间允许）及 `git diff --check`。

## 7. 后续性能优化设计

### P0：先建立可比较基线

- 新 release 起，聊天 SSE 的接口响应 SLA 只看 `http.server.duration` 首字 Metric；完整生成看 `sse.stream.duration`、Grafana 完整回复和生成终态。
- 按 release、action、model/provider、finish reason、输出长度分桶；新旧 SSE 口径不直接算环比。
- 保持生产 release 稳定至少一个完整业务高峰，再判断代码回归，避免高频部署、冷缓存和样本结构混入。

### P1：完整生成长尾

- 先按 model/provider 与输出长度定位 60–100s 样本；优先治理中断率、上游超时和无效长输出，而不是缩短首字后连接来“优化指标”。
- 只有确认某型号在相近输入/输出长度下持续超预算，才调整该型号最大输出、provider 路由或总时限；这些会影响回复完整性，需单独 PRD 与灰度停止条件。
- 现有首字前并行准备、兜底选择、生成后置诊断异步化继续保留，不再新增重试；首字后重试会重复输出或计费，不安全。

### P1：页面导航长尾

- `/chat`、`/profile`、`/chats` 先按 Telegram Android、release 和页面阶段拆分；普通读取 API 已是亚秒级，不盲目继续改后端查询。
- 对慢 trace 比对 route chunk、图片/媒体、React commit、缓存命中与 WebView 后台恢复；首页 pageload 需先恢复稳定采样覆盖。
- 已有入口壳、非目标预取关闭、重面板动态加载继续观察；未发现新瓶颈前不再叠加新的 loading 状态或缓存层。
