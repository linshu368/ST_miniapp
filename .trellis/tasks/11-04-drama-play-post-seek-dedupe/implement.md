# 执行计划

顺序：后端 → 前端取址 → Android 快进 → 验证 → 发布。每步完成后跑对应检查，再进入下一步。

## 0. 准备

- [x] `git pull --ff-only`（main 已到 1df9d3ce，含 Stream AB 合入 #676）；分支 `claude/drama-play-post-and-seek-dedupe`。
- [x] 不动 `stash@{0}` 及其余 stash。
- [ ] 登记 `meta.mobile_performance` 基线后 `task.py start`。

## 1. 后端（约 4 个文件）

1. `packages/shared/src/api/drama.ts`：加 `DramaPlayRequestSchema` + 类型；`pnpm --filter @miniapp/shared test` 补 schema 行为确认。
2. 新增 `packages/backend/src/routes/drama-play.ts`：搬出 `/play` 处理与计时类型。
3. `routes/drama.ts`：GET 与 POST 都调用 `createDramaPlayHandler`，保留 `@frontend-ready` 注释与全部 hook。
4. 检查：backend typecheck、`drama-timing.test.ts`、相关单测、`complexity-budget.mjs check`（`dramaRoutes` 应降到 120 行以下）。

## 2. 前端取址（约 3 个文件）

1. `lib/api/drama.ts`：POST + 意图表 + `usePrefetchDramaPlayback` 触发。
2. `dramas/[id]/page.tsx`：`navigate` 里 `beginPlayback` 后发意图（videoId 与播放器一致）。
3. 单测（`lib/api` 内，用户已同意）：意图“被接上”（同键 ≤10s，只用一次）、“过期作废”（>10s 新建）、fallback 不接上、键不同不接上。
4. 检查：frontend typecheck、相关单测。

## 3. Android 快进（约 3 个文件）

1. 拆出 `components/drama/use-drama-scrub.ts`，`drama-progress.tsx` 只留渲染与键盘；行为先保持不变（先跑 `pnpm test:ui --grep @drama` 确认拆分无回归）。
2. 加 500ms `onChange` 忽略窗。
3. 扩展 `packages/ui-tests/tests/drama.spec.ts` 进度条场景：松手后只提交一次（用 `onBeforeCommit` 可观测的 seek 计数或 `video.currentTime` 写入计数）。

## 4. 验证

- 自动：`pnpm --filter @miniapp/shared test`、`pnpm -r typecheck`、前后端相关单测、lint、build、`node scripts/complexity-budget.mjs update`（只收紧）、`pnpm test:ui --grep @drama`。
- 人工（TEST 真机）：Android/iOS 各走点封面、详情页换剧、选集、拖动快进，日志确认每次拖动只有一条 seek。**没有 Android 测试机，需先向用户确认。**
- 文档：同步 `docs/drama-playback-timing.md`、`.trellis/spec/frontend/app/modules/business/drama-experience.md`。

## 5. 发布（需用户同意后再做）

- 先后端，确认 POST 正常再前端；合并和生产部署前先问用户。
- 观察 3–7 天：各入口取地址 P50/P95、起播 P95、Android 50ms 内被替换比例、快进 P95、3 秒达标率。回滚=回退前端。

## 失败路径与待核验项

- POST 非法 `drama_id`/`video_id` → 400；不属于该剧的 `video_id` → 404；未登录 → 沿用鉴权拒绝；旧 GET 行为不变。
- 修饰键点击封面会白发一次意图请求（不进新标签，不会被接上），可接受。
- `address_source`：beginPlayback 之后发的请求按现有规则记为 `fetch` 而非 `inflight`；先确认看板是否依赖 `inflight`，不改计时模块。
- Android 根因（onChange 二次提交）为日志推断，真机确认；若真机仍有重复，停下来重新定位而不是继续加窗口。
