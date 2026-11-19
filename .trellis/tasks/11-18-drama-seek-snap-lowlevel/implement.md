# 执行计划

1. `lib/drama-hls-seek.ts`：新增 `planHlsSeek`，约 50 行，拆成 `snapTarget` 和 `pickSeekLevel` 两个小函数。
2. `lib/drama-media-source.ts`：`seekPlanners` 登记和清理，导出 `prepareDramaSeek`。
3. `components/drama/use-drama-scrub.ts`、`components/drama/drama-progress.tsx`：提交前调用 `prepareDramaSeek`，后续统一用返回值。
4. `lib/drama-hls-seek.test.ts`（扩展现有文件，待拍板）：prd 验收里列的 8 个用例。
5. 本地 Playwright（scratchpad 脚本，不入库）：生产签名的 Stream 片源、Android UA、CDP 限速 1.5 Mbps；对比改动前后：吸附命中时目标视频分片的请求数、强制档位后下一片的档位回升、恢复耗时。注意本机默认 UA 含 Macintosh，会被判成 Apple，必须设成 Android UA。
6. 检查：`pnpm --filter @miniapp/frontend typecheck`；`pnpm --filter @miniapp/frontend exec vitest run src/lib/drama-hls-seek.test.ts src/lib/drama-media-source.test.ts src/lib/perf/drama-seek-diagnostics.test.ts`；frontend lint；`node scripts/complexity-budget.mjs check`。
7. spec：在 `drama-experience.md` 的 hls.js 快进段补上吸附和降档规则。
8. 发布（需要用户同意，排在 verify-fallback 之后）：PR → Quality Gate → 合并 → 确认 Vercel 部署 → 3–7 天后按版本复算。
