# 执行计划

1. 更新 Frontend page registry，并在六个缺失页面的实际数据 owner 中接入 `usePageReady`。
2. 重构 `timedFetch` 为覆盖 consumer 的完整生命周期；保留 headers 独立指标，扩展既有测试。
3. 修正 `apiRouteGroup`，接入 lobby proxy upstream timing。
4. 将聊天 Sentry full reply 移到 `RoleplayReplyTiming` 的匹配终态 commit callback，删除 invalidate 后旧上报。
5. 为 Creator polish NDJSON 增加 headers/first_text/full terminal 的 Sentry 与 Grafana 指标，验证 done 不等待 EOF。
6. 增加 Backend background observability helper，扩展 engineering OTLP 指标。
7. 接入四个 Fastify in-process jobs 和生产 standalone scripts；保留原业务控制流、退出码、锁与 cleanup。
8. 更新 Grafana/Sentry 口径文档并生成 `docs/grafana/frontend-backend-observability-coverage.md`。
9. 运行定向测试后执行 Frontend/Backend typecheck、lint、build、complexity、全量相关测试与 diff 检查。
10. 复核模块知识是否需要更新，准备最终文件清单和验证结果；不自动提交或 push。

## 验证命令

```powershell
pnpm --filter @miniapp/frontend exec vitest run src/lib/perf/request-timing.test.ts src/lib/perf/api-timing.test.ts src/lib/perf/route-template.test.ts src/lib/perf/roleplay-timing.test.ts src/lib/api/creator-characters.test.ts src/hooks/use-conversation-turn.test.ts
pnpm --filter @miniapp/backend exec vitest run src/lib/engineering-observability.test.ts src/lib/perf-metrics.test.ts
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/backend test
pnpm lint:complexity
git diff --check
```

## 回滚点

- HTTP consumer timeout 如出现兼容问题，可单独回退 `request-timing.ts`/`client.ts`，其它覆盖不依赖它。
- Page/route group、chat、creator stream 可独立回退。
- Backend helper 是 no-op 降级且不改业务写入；可先移除各调用点，再删除 helper/OTLP函数。
