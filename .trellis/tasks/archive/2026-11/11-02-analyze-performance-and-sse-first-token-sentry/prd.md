# 分析两日性能回归并调整 SSE 首字 Sentry 口径

## Goal

结合 2026-10-31、2026-11-01 性能日报与相关提交，区分真实性能退化、样本口径变化和 SSE 长连接统计偏差；修正聊天 SSE 在 Sentry 中的接口响应耗时，使首个可见字符成功写出即视为已响应，同时保留完整推流耗时用于生成长尾分析。

## Requirements

- 输出两日报告与 10 月 29 日至 11 月 2 日相关提交的因果分级分析，不把相关性写成已证实因果。
- `POST /api/v1/conversations/:id/messages` 与 `POST /api/v1/conversations/:id/regenerate` 的 Sentry `http.server.duration` 在首个成功写出的非空正文或已启用思考片段处结束。
- `start`、空白 delta、未成功写入 socket 的片段不得算首字；同一请求只记录一次。
- 无首字的 HTTP/流内失败仍在终态记录，不能从 P95 样本中静默消失。
- 完整 SSE 生命周期单独记录，不能丢失供应商、输出长度、流中断和收尾长尾的诊断能力。
- 监控失败不得阻塞、抛错或改变 SSE、计费、持久化、超时、重试、恢复及客户端断开语义。
- 不修改 shared 外部契约、数据库或运行时配置，不新增依赖。

## Acceptance Criteria

- [ ] 首个成功写出的非空 `delta` 或 `reasoning` 只触发一次首字回调。
- [ ] 聊天 SSE 的 Sentry `http.server.duration` 使用首字耗时；无首字时使用终态耗时并带低基数里程碑属性。
- [ ] 聊天 SSE 完整生命周期记录到独立的 `sse.stream.duration`；其他 HTTP 路由继续使用原有口径。
- [ ] 早期 4xx（尚未进入流处理）仍由原有 HTTP 终态指标记录。
- [ ] 现有 SSE 测试与后端性能指标测试覆盖一次性、空白、写失败、终态兜底和非 SSE 不回归。
- [ ] 后端相关测试、typecheck、格式/静态检查通过，并形成验证记录与原因总结。

## Constraints

- Sentry 自动 `http.server` trace span 仍表示底层 HTTP 生命周期；日报中的 SSE 响应 P95 应改用全量 Metrics `http.server.duration`，完整流耗时使用 `sse.stream.duration`。
- 不记录正文、推理内容、用户身份、token、header 或请求体。
