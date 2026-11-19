# Implement

## 顺序

1. shared：`DiagnosticsSchema.hls.prefetch`（可选、strict），导出类型。
2. 前端 `lib/drama-hls-playlist.ts`：主清单解析的纯函数，选出最低档视频子清单和默认音轨子清单的 URL。
3. 前端 `lib/api/drama-playback.ts`：缓存、`prefetchDramaPlayback`、`loadDramaPlayback`、`startDramaPlayIntent`；`lib/drama-playback-resources.ts`：consumption、usage 和 discarded 计数；可见封面的 DOM 选取放在 `useDramaPlaybackWarmup`。`lib/api/drama.ts` 原有的 `fetchDramaPlayback` 和意图逻辑一起迁走，drama.ts 只做再导出，既有调用方不变。
4. 前端 loader 和 `loadDramaSource`：按 URL 命中、回写、usage 注册。
5. 前端 `observeDramaHls` 透传 prefetch。
6. 触发点：`useDramaPlaybackWarmup`、`DramaLink.onPointerDown` 和 `data-drama-id`。
7. 单测（三处）和验证命令。

## 验证命令

```
pnpm --filter @miniapp/shared test
pnpm -r typecheck
pnpm --filter frontend test -- drama
pnpm lint:complexity
pnpm --filter frontend build
```

## 人工验证（preview 环境，真实 Stream 白名单视频）

- 进片库停留约 5 秒，Network 面板应出现最多 4 次 `/play` 和对应的 `video.m3u8` 子清单请求。
- 点其中一张封面：起播时不再出现 `/play` 和两份子清单的网络请求；诊断里 `diagnostics.hls.prefetch.source=visible_cover`。
- 停留超过 5 分钟后再点：重新请求 `/play`，起播正常。
- 弱网（DevTools Slow 4G）下，片库预取不能拖慢首屏封面。
- 往回滑到上一部：子清单命中缓存（source=recent）。
- 用真实主清单核对：解析器选出的 URL，等于 hls.js 实际请求的 level 0 和音轨 URL。
