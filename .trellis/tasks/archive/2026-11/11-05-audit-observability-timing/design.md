# 审计设计

## 1. 范围与事实来源

审计按 `入口 -> 客户端 API/状态层 -> HTTP/SSE -> Fastify/Next handler -> feature/service -> repository/数据库/外部供应商 -> 响应/流事件 -> UI 可见状态` 建图。事实优先级为当前源码与部署配置，其次是架构/运行手册，再次是可获得的只读 Sentry 数据。文档与代码冲突时同时记录二者，不用文档补齐实现缺口。

覆盖 Frontend、Admin、Backend、shared telemetry contracts、admin-client/admin-cli、Next route handler、客服 Bot/代理、cron/worker/script、Railway/Vercel 配置和 Grafana Alloy/Faro/OTLP/Loki/Tempo/Prometheus 相关文件。

## 2. 复用调研

先检索并复用现有能力，不设计新框架：

- Sentry：`instrumentation-client.ts`、各包 instrumentation、`lib/sentry/*`、Sentry SDK 初始化、transaction/span、错误捕获与 scrubber。
- Grafana：Faro 初始化、OTLP exporter、Pino/Loki 日志、Tempo trace 关联、Prometheus/metrics、现有 dashboard/runbook 与 telemetry route。
- 页面性能：startup/page timing tracker、Performance API、route observer、React Query 状态、关键内容/首帧/可交互信号。
- HTTP/SSE：通用 API client、Fastify hooks、请求耗时日志、生成链路的 stream parser、`start/delta/done/error`、abort 与 EOF。
- 外部调用：generation、支付、Telegram、Supabase、语音、图片、CDN、客服代理中的 timeout/span/log helper。

每项按“直接复用审计口径 / 现有能力需扩展 / 不适用”记录；本任务不新增 helper、contract、feature、repository、数据库函数或依赖。

## 3. 覆盖判定模型

每条链路分别记录：

1. Sentry error：未捕获错误、手工 capture、上下文与脱敏。
2. Sentry tracing：根 transaction、客户端导航/请求 span、服务端 route/上游/DB span、trace 传播。
3. Grafana logs：结构化 Pino/Faro/Loki 日志、request/trace ID、结果摘要和耗时。
4. Grafana metrics：可计算的 count/error/latency 分布、稳定低基数字段与完整分母。
5. Grafana traces：OTLP/Tempo 根与子 span、跨服务关联。

“有日志”不等于“已接 Grafana 性能监控”；只有慢请求采样不能代表总体分布；只有客户端总耗时不能定位后端或供应商阶段。

## 4. 耗时语义

### 页面

开始点按用户意图来源区分冷启动、路由导航和返回恢复。终点必须对应该页面的主要承诺已经可见且稳定：例如首屏骨架不算内容可见，次要角标/预取/后台刷新不应延长主页面加载。审计 hydration、React Query settle、图片 decode、首帧、动画结束、全部请求完成、组件卸载等是否被误用为统一终点，并检查 hidden/background、route change、abort、cache hit 和 error/empty 状态。

### 普通 HTTP

客户端 duration 为发起到响应体解析/校验完成；服务端 duration 为接收至响应提交；外部调用和 DB 单独计时。若业务只关心 accepted/queued，不把异步作业完成计入同步接口。

### SSE

至少拆分：请求开始、响应头/连接建立、首业务事件、首 token、业务 `done`、连接 EOF/close。生成体验用 TTFT 与 business completion；transport lifetime 仅作连接诊断。若服务端已发送 `done` 或客户端已得到终态，后续 keepalive、flush、reader cleanup、cache reconciliation 不得继续计入“生成耗时”。error/abort/EOF 必须有互斥终态，避免重复 final。

## 5. 可靠性设计

- 超时/重试：审计外部调用是否有明确超时；只读 Sentry API 使用技能自带的有限重试，不重试写操作。
- 幂等/并发/事务/补偿：本任务无写入，不适用；但会检查被审计关键写链路的观测是否能区分重复调用、并发冲突、事务失败和补偿结果。
- 降级：观测失败不得阻塞产品链路；检查 fire-and-forget 是否吞掉必要错误以及队列满/发送失败是否有自身可观测性。
- 限流/容量：检查高频 delta、每请求 breadcrumb、动态 label、正文上报造成的基数/费用/PII 风险；线上 API 查询限制在必要范围。
- 可观测性：审计结论必须能够从路径、符号、配置或只读事件复现。

## 6. 最小充分方案

只生成任务内研究记录和最终报告，不创建新 runtime 文件、状态源、公开 API、依赖、测试或数据库对象。拒绝在信息不足时提出统一“全埋点框架”、新增分析库或把所有日志转指标；建议仅针对确认的缺口给出最小改动位置。

## 7. 演进与恢复

本任务不发布，无兼容、迁移、灰度或回滚动作。后续若实施修复，应按接收端兼容先行、客户端/服务端分批发布、保留旧字段观察一个窗口、以 feature flag/采样率回退；SSE 新指标不得改变协议事件与计费状态机。停止条件包括 PII 泄露、事件量异常、性能回归或新旧口径无法对账。

## 8. 可验证性

- 用静态检索建立入口和埋点清单，再逐文件核对调用上下文，避免只按关键字计数。
- 对页面终点追踪到真实渲染条件；对 SSE 追踪 server emit、wire event、parser callback、UI final 和 telemetry final。
- 检查消费者：Sentry 项目/环境/release，Grafana datasource/dashboard query、日志字段和 trace 传播。
- 只读线上数据可用时，核对 transaction 名称、duration 分布、重复/悬挂 span 和环境；不可用项明确保留。
- 报告包含人工复现建议：缓存命中/冷启动、成功/空/错误、前后台切换、路由中断、SSE success/error/abort/EOF、done 后延迟 close。

## 9. Android/iOS 与 P95

本任务不会改变移动端页面和接口，因此 `mobile_performance` 为 `not_applicable`。审计会指出现有 Android/iOS 口径能否正确产生 P95，但不会把缺失样本填零，也不会为未发布变更设置目标。
