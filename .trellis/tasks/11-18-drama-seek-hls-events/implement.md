# 执行计划

1. PR1 shared：`HlsEventSchema` + `hls.events/eventsTruncated/counts`；`packages/shared` 单测覆盖合法、超 24 条、非法 detail、旧报告兼容。运行 shared 测试 + `pnpm -r typecheck`（跨包契约要求）。
2. PR1 合并 → 确认 Railway 部署的版本包含该提交。
3. PR2 frontend：新增 `recordHlsEvents` / `recordSeekHls`，`observeDramaSeek` 改为调用 `recordSeekHls`；扩展 `drama-seek-diagnostics.test.ts`（记录 / 开头+最近各 12 条与计数 / 终态后停止 / 起播不带 events）。运行 frontend typecheck、vitest、lint、complexity、`pnpm test:ui --grep @drama`。
4. 本地用 scratchpad 复现页确认真实 hls.js 1.7.4 下事件字段齐全、能通过 schema。
5. PR2 合并 → Vercel 部署确认 → telemetry 4xx 不上升。
6. 3–7 天后取带卡死特征的样本分析，给出根因与修复方案。
