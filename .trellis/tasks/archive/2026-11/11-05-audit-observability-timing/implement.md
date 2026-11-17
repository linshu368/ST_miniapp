# 执行计划

1. 读取相关规范、架构、性能文档、Grafana runbook 和 Sentry 初始化配置。
2. 枚举 workspace 包、运行入口、页面/route、Fastify route、SSE、cron/script、代理和主要外部调用，生成链路清单。
3. 检索 Sentry/Faro/OTLP/Pino/metrics/trace/timing 实现，映射到每条链路；逐项确认而非按关键字推断。
4. 逐页面追踪计时开始、关键内容可见条件、终态提交、hidden/abort/navigation/error 处理。
5. 逐接口追踪客户端、Fastify、feature、外部调用与 response timing；SSE 额外核对 headers/first event/first token/done/EOF/close。
6. 从仓库配置解析 Sentry org/project；仅在不暴露 token/PII 的前提下调用只读 API，核对当前事件/transaction 可见性。若技能 API 不支持性能查询，则明确该限制，不伪造线上结论。
7. 核对 Grafana datasource/exporter/dashboard query 与日志字段；没有只读凭据时仅报告代码/配置事实和待线上查询项。
8. 在任务 `research/` 中记录覆盖矩阵与耗时审计证据，运行链接/路径自检和 `git diff --check`。
9. 向用户交付分级报告：完整覆盖、部分覆盖、未接入、错误计时点、建议口径、修复顺序和验证场景。

## 验证命令

```powershell
rg -n -i "sentry|captureException|startSpan|faro|otel|otlp|tempo|loki|prometheus|metric|duration|timing|first.*token|done|eventsource|text/event-stream" packages docs ops
pnpm -r --depth -1 list --json
git diff --check
```

本任务不改产品代码，因此不运行全量 typecheck/test/build；若审计过程中需要执行现有静态脚本，只运行只读命令并在报告中记录。
