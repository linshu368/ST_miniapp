# 执行计划

1. `perf/drama-seek.ts`：抽出 `buildSeekReport`；新增 `createProgressFallback`，接进 timeupdate 分支；seeking 时重置兜底状态。
2. `perf/drama-seek-diagnostics.test.ts`（扩展现有文件，待拍板）：
   - 帧回调的 mediaTime 偏移 5s，两次前进的 timeupdate → `playing`、`playing_and_timeupdate`；
   - 帧回调正常 → `video_frame_callback`，第一次 timeupdate 之前就结束；
   - 只有一次越过目标的 timeupdate 后就暂停 → `unverified/paused`；
   - 兜底已有一次前进后又 seeking，再一次 timeupdate → 不结束。
3. 检查：`pnpm --filter @miniapp/frontend typecheck`；`pnpm --filter @miniapp/frontend exec vitest run src/lib/perf/drama-seek-diagnostics.test.ts src/lib/perf`；frontend lint；`node scripts/complexity-budget.mjs check`，然后 `update`。
4. spec：在 `.trellis/spec/frontend/app/modules/business/drama-experience.md` 的快进段补一句兜底规则。
5. 发布（需要用户同意）：PR → Quality Gate → 合并 → 确认 Vercel 部署 → 3–7 天后按版本复算 iOS 漏判样本数，以及各平台 `first_frame_method` 的分布。
