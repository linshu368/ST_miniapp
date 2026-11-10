# 执行计划

1. shared：`DramaPlayback.inline_manifest?: string`；shared 测试（类型层面，确认可选字段不破坏既有 fixture）。
2. 后端：新增 `stream-manifest-cache.ts`（`DramaStreamManifestCache`，接口仿 `DramaSignedUrlCache.getPlayUrl`：`getManifest(uid, play_url, log, observation) => Promise<string | undefined>`，不抛异常；超时用 `fetch(url, { signal: AbortSignal.timeout(300) })`）。
3. `drama-play.ts`：`DramaStage` 加 `'manifest'`；`DramaRequestTiming` 加 `manifest: { cache?: 'hit'|'miss'|'inflight' }`；`DramaPlayDeps` 加 `streamManifests`；Stream 签名成功分支里 `measure(request, 'manifest', () => streamManifests.getManifest(...))`，拿到内容才拼进响应。
4. `drama.ts`：实例化 `streamManifests`，`onRequest` 初值加 `manifest: {}`，`onResponse` 的 `attributes`/日志字段加 `manifest_cache`/`manifest_ms`。
5. `engineering-observability.ts`：`observeDramaRequest` 输入加 `manifestCache`，stage 遍历数组加 `'manifest'`，仿 `sign_cache` 写 `manifest_cache` 维度。
6. 前端：新增 `drama-inline-manifest-loader.ts`（`createInlinePlaylistLoader`，内部持有一个真实 loader 实例做转发，`load()` 里判断 `context.type === LoaderContextType.MANIFEST && context.url === matchUrl` 走内联分支，否则 `this.delegate.load(...)`）。
7. `drama-media-source.ts`：`playback.inline_manifest` 存在时把 `pLoader: createInlinePlaylistLoader(source, playback.inline_manifest)` 传进 `new Hls({...})`。
8. `drama-timing.ts`（shared）：`DiagnosticsSchema.hls` 加 `manifestInline: z.boolean().optional()`；shared 测试补一条新旧报告兼容用例。
9. `drama-hls.ts`：`recordHlsLoads`/`observeDramaHls` 签名各加一个尾部可选参数 `manifestInline?: boolean`，`emit()` 的 snapshot 带上它。
10. `drama-player.tsx`：第 570 行 `observeDramaHls(hls, events, timing)` 改成 `observeDramaHls(hls, events, timing, Boolean(playback.inline_manifest))`。

## 测试计划（已确认：按此范围加）

这批改动涉及外部调用超时降级、进程内并发缓存、跨包契约字段，以及一个要精确匹配 hls.js Loader 接口的新类——任何一处写错都表现为"偶尔多 300ms"或"花屏/卡住"，现网很难一眼看出是不是这个功能导致的：

- `stream-manifest-cache.test.ts`（新，仿 `signed-url.test.ts`）：命中/未命中/inflight 去重/超时降级/容量淘汰/TTL 过期。
- `drama-play.test.ts`（新，当前这个 handler 没有专门测试文件）：Stream 组命中缓存时响应带 `inline_manifest`；未命中/超时/拉取失败时字段缺省且响应其余部分不变、不抛错；非 Stream（Supabase/Bunny/mp4 回退）路径不触发缓存逻辑。
- `drama-inline-manifest-loader.test.ts`（新）：manifest + url 匹配走内联（校验 `onSuccess` 的 `data`/`url`、`stats.loading.start === end`、无 `first`）；manifest 但 url 不匹配、或 level/audioTrack/subtitleTrack 类型，全部转发到真实 loader；`abort()`/`destroy()` 转发。
- `drama-media-source.test.ts` 补一个用例：`playback.inline_manifest` 存在时 `new Hls` 收到的 config 带 `pLoader`。
- `drama-timing.test.ts`（shared）补：`manifestInline` 省略时旧报告仍兼容；`true`/`false`/非法值（非 boolean）的通过/拒绝。
- `drama-hls.ts` 现有测试补：`manifestInline` 透传进 `emit()` 的 snapshot。

不做：改 `signed-url.ts` 本身的现有测试（只改了一个 `export` 关键字，行为不变）。

## 验证命令

```
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend exec vitest run src/features/drama src/routes/drama-play.test.ts src/lib/engineering-observability.test.ts
pnpm --filter @miniapp/frontend exec vitest run src/lib/drama-inline-manifest-loader.test.ts src/lib/drama-media-source.test.ts src/lib/perf/drama-hls.test.ts
pnpm -r typecheck
pnpm --filter @miniapp/frontend lint
pnpm lint:complexity
pnpm --filter @miniapp/frontend build
```

backend 没有独立的 `lint`/`build` script（没有编译步骤，生产用 `tsx` 直接跑），只跑 typecheck + vitest。

## 失败路径与人工核验

- Stream 拉取超时（300ms 到）/网络错误/非 2xx：`getManifest` 返回 `undefined`，`/play` 其余字段不变，不抛错，`manifest_cache` 记 `miss`（已经试过但没拿到内容，和"没查缓存"的 `unused` 区分）。
- 缓存条目过期（超过 TTL）：当次按未命中处理，重新拉取。
- 并发：同一 uid 同时来多个 `/play`，只发一次拉取，`manifest_cache` 记 `inflight`。
- hls.js 侧：`context.url` 跟 `play_url` 不完全相等（比如 iOS WebKit 混进来的极端情况，或将来 `capAppleHlsQuality` 的查询参数差异）时必须老实转发到真实网络请求，不能因为"大概是同一个清单"就误用内联内容。
- 上线后人工核验：Grafana 看 `st_drama_server_stage{stage="manifest"}` 和 `drama.request_timing` 里 `manifest_cache` 命中率；抽一个 Stream 组用户的起播网络面板，确认命中时主清单那一行 TTFB≈0 且不实际发请求；确认接口 p95/p99 没有顶到待拍板里写的上限。
