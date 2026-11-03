# 执行计划

1. 修改 `packages/frontend/src/lib/perf/first-token-observation.ts`：观察器、条目选择、`network_status`/`rt_buffer`。
2. `packages/frontend/src/lib/perf/grafana.ts` 白名单加 `rt_buffer`。
3. 扩展既有 `first-token-observation.test.ts`：缓冲区缺失但观察器拿到 → available+miss；条目被清零 → limited；都没有 → no_entry；观察器异常不影响上报。
4. 验证：frontend typecheck、相关单测、`pnpm test:ui --grep @chat`、`git diff --check`。
5. 交付：PR 到 dev（TEST 验收），之后按发布路径拉 main 单独发布，合入后同步回 dev。
