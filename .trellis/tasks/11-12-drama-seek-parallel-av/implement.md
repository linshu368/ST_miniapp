# 执行计划

1. 新增 `packages/frontend/src/lib/drama-hls-seek.ts`（约 50 行）。
2. `drama-media-source.ts`：hls.js 分支创建后调用，cleanup 并入 `destroy`。
3. 新增 `packages/frontend/src/lib/drama-hls-seek.test.ts`：命中重启；目标已缓冲 / 无挂起 / 挂起片覆盖目标 / 入缓冲后移除 / cleanup 后不触发；回调抛错不外泄。
4. 检查：`pnpm --filter @miniapp/frontend typecheck`、`pnpm --filter @miniapp/frontend exec vitest run src/lib/drama-hls-seek.test.ts src/lib/drama-media-source.test.ts src/lib/perf/drama-seek-diagnostics.test.ts`、`pnpm lint`（frontend）、`node scripts/complexity-budget.mjs check`。
5. 本地复现：scratchpad `repro/run.mjs` 注入构建后的同等逻辑，串行 0/10、恢复播放。
6. 文档：`.trellis/spec/frontend/app/modules/business/drama-experience.md` 补一句行为说明。
7. 发布（需用户同意）：PR → Quality Gate → 合并 → Vercel 部署确认 → 3–7 天后复算。
