# Implement

## PR1（分支 feat/drama-nonhome-prefetch-contract）

1. shared `api/drama-timing-hls.ts`：`DRAMA_PREFETCH_SOURCES` 增加 `next_episode`、`next_drama`、`press_episode`；shared 测试覆盖新值被接受。
2. backend `routes/drama-play.ts`：已迁移 Stream 视频带 `MIGRATED_STREAM_DELIVERY`；`drama-timing.test.ts` 改断言，覆盖签名失败时为 unavailable。
3. 本任务规划文档随 PR1 提交。

## PR2（分支 feat/drama-nonhome-prefetch，base 为 PR1 分支）

1. `lib/api/drama.ts`：`usePreloadDramaPlayback` 改为 `(id, videoId, source, priority)`，同时预取详情与地址。
2. `components/drama/use-drama-next-prefetch.ts`：目标解析（纯函数，导出给单测）、播放 1 秒后的推测性预取、片尾前 3 秒、`intent(direction)`。
3. `drama-player.tsx`：删掉原片尾 effect 与 onIntent 内联逻辑，改为调用 hook；EpisodeSheet 传 `onPress`。
4. `episode-sheet.tsx`：拆出 `EpisodeGrid`，按钮加 `onPointerDown`。
5. 单测：目标解析（键对齐）与 hook 的触发条件。
6. 规范 `drama-experience.md` 第 28、30、70 行同步。
7. 跑 `node scripts/complexity-budget.mjs update` 收紧基线（如果变短）。

## 验证命令

```
pnpm --filter @miniapp/shared test
pnpm --filter backend exec vitest run src/routes/drama-timing.test.ts src/routes/drama-play.test.ts
pnpm --filter frontend exec vitest run src/components/drama src/lib/api
pnpm -r typecheck
pnpm lint:complexity
pnpm --filter frontend build
```

## 人工验证（本地生产构建 + Playwright，Android UA，DevTools 节流 Fast 4G）

- 剧详情播放第 1 集超过 1 秒：Network 出现一次下一集的 `/play` 和两份子清单；播完自动进入下一集时，不再出现 `/play` 和子清单请求。
- 首页 feed 播放超过 1 秒：出现下一部的 `/play`；往下滑后起播不再请求。
- 选集面板按下某集：立即出现该集 `/play`；松手后起播不再重复请求。
- 失败路径：把 `/play` 拦截成 500，预取失败后起播走原路径并正常播放；停留超过 5 分钟后，下一集重新取址。
- 默认 UA 含 Macintosh 会被判成 Apple、跳过子清单预取，必须设 Android UA。
