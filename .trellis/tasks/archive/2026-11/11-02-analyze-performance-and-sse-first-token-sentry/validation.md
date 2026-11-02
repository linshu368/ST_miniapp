# Validation

## 实施结果

- `createReplyStreamSink` 在首个成功写入 socket 的非空 `delta`/`reasoning` 后通知一次；`start`、空白片段和写失败不计首字。
- 两条聊天 SSE 的 Sentry `http.server.duration` 从 Fastify 请求起点计到首字；无首字请求在终态按真实 status 补记。
- `onResponse` 对已接管请求只记录 `sse.stream.duration`，保留完整生成长尾；Grafana 既有完整请求和首字指标不变。
- 日报/周报提示词与模板已改为普通接口看 `http.server` span、聊天 SSE 响应看首字 Metric、完整推流单列，并要求按 release 标注口径切换。
- 未修改外部契约、前端、数据库、生成选择、计费、重试、超时或恢复语义。

## 验证结果

- `pnpm --filter @miniapp/backend exec vitest run src/features/conversations/sse.test.ts src/lib/perf-metrics.test.ts`：2 files / 22 tests，通过。
- `pnpm --filter @miniapp/backend test`：114 files / 1153 tests，通过。
- `pnpm --filter @miniapp/backend typecheck`：通过。首次因合并后本地 Prisma Client 未生成而出现 creator relation 类型错误，执行仓库启动同款 `prisma generate` 后通过；未产生 Git 文件改动。
- 受影响文件 Prettier check：通过。
- 针对受影响文件直接运行 ESLint（去掉仓库脚本中无效的 `--rule '{}'` 参数）：通过。
- `pnpm lint:imports`：未执行成功；仓库脚本向当前 ESLint 传入字符串形式 `--rule '{}'`，CLI 在读取源码前即报参数类型错误，属于既有脚本兼容问题。
- `git diff --check`：通过，仅有 Windows `core.autocrlf` 换行提示。

## 线上证据复核

- Sentry 最近 7 天按 release 聚合自动 `http.server` span：`5fffd6ce` 的 messages/regenerate P95 为 45.65s/56.36s，低于 11 月 1 日跨 release 聚合；更早 release 可见 60–110s 极端值。
- 报告中浏览器首字成功 P95 约 5 秒，而完整回复 P95 为 42–61 秒，证明完整连接时长不是 SSE 首字响应时间。

## 剩余风险与发布后检查

- Sentry 自动 `http.server` trace span 仍会等待连接结束，这是正确的底层生命周期语义；若日报继续查询该 span，仍会得到完整生成时间，必须使用已更新模板。
- 新指标只有新 release 数据，首个完整窗口按 route、`response_milestone`、release 核对样本数；若首字样本显著少于请求数或 `perf.instrument_error` 增长，停止用于 SLA 并回滚接管逻辑。
- 本地测试无法证明 Sentry 服务端已摄取新 metric；需部署后在 Sentry Metrics 验证 `http.server.duration` 与 `sse.stream.duration`。

## 模块知识评审

本次是内部观测口径修正，没有改变模块职责、公开契约、状态源或数据库事实；`module_impact=no_module_change` 合理，不更新 `.trellis/spec` 模块现状。
