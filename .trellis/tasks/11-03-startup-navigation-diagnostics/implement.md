# 执行计划

1. 扩展 startup-phases.ts 的固定白名单、导航数值和仅 details 的分段；保持旧 stages 及 observer 不动。
2. 在 page-tracker.test.ts、sanitize.test.ts 补正常/长空档/复用/缺失/异常/脱敏/调用数量覆盖。
3. 同步 docs/miniapp-startup-performance.md 与 frontend 性能 spec，包含 Android NetLog/HAR 操作和取证限制。
4. 按用户明确要求，不执行以下本地验证；仅完成编码和提交范围核对，跳过 Git hooks，提交推送功能分支，不部署。

后续可执行验证（本轮未执行）：
```bash
pnpm --filter @miniapp/frontend test -- src/lib/perf/page-tracker.test.ts src/lib/sentry/sanitize.test.ts
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm test:ui --grep '@startup|@navigation'
```

失败路径：没有 navigation、字段缺失/NaN/Infinity/负数/晚于观测时间、时间逆序、TLS=0/不在连接内、Timing getter异常；旧指标应原样保留。consumer：sanitize保留新数值并剥离身份/URL/自定义字段；不增加 metrics/captureEvent 调用。人工：Android/iOS 冷热启动；主线程开销与首批业务接口/JS时序；TEST实际 Sentry 事件字段及原口径 P95。以上执行结果均待验证。
