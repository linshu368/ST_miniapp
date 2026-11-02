# Implementation Plan

1. 扩展 `createReplyStreamSink`，在首个成功写出的非空 `delta`/`reasoning` 后调用一次可选回调，并补充现有测试。
2. 在 `perf-metrics.ts` 增加 SSE 首字响应 tracker：接管两条聊天路由的 Sentry `http.server.duration`，终态兜底且完全故障隔离。
3. 调整 `registerRequestPerf`：被接管的聊天 SSE 在 `onResponse` 记录 `sse.stream.duration`，其他路由维持原行为。
4. 在 `streamTurn` 入口接线 tracker，在 `finally` 终态兜底；不触碰生成、计费和协议。
5. 扩展现有性能指标测试，执行相关测试、backend typecheck、全量测试与 diff 检查。
6. 记录验证结果和性能原因总结，检查模块知识是否需更新；本次仅改变内部观测口径，不更新模块职责规范。

## Rollback points

- 若 sink 回调影响业务测试，先回退回调接线，保留分析文档。
- 若 Metrics 接管导致样本缺口，恢复 onResponse 统一 `http.server.duration`，保留 `sse.stream.duration` 供诊断。
