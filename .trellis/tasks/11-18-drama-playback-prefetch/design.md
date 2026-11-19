# Design：短剧播放资源缓存

## 复用调研

| 已有                                                                                                                   | 处理                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/api/drama.ts` 的 `playIntents` / `startDramaPlayIntent` / `loadDramaPlayback`（点击时取址，10s 内有效、只用一次） | 迁到新文件 `lib/api/drama-playback.ts`（与 `fetchDramaPlayback` 一起；共享状态放在无依赖的 `lib/drama-playback-resources.ts`，避免与 `drama-media-source` 循环引用），扩展成带来源的缓存。intent 作为其中一种来源，保留“点击后 10s 内”这条语义 |
| `fetchDramaPlayback`（POST /play，经 `dramaTiming.query` 计时）                                                        | 复用。预取请求同样经过 `dramaTiming.query`，所以起播的 `addressSource` 能自动判成 cache 或 inflight，不需要另加计时                                                                                                                            |
| `createInlinePlaylistLoader`（主清单内联命中）                                                                         | 扩展：除主清单外，按 URL 命中子清单，并把真实网络拉到的子清单回写                                                                                                                                                                              |
| `useDramaPlaybackWarmup`（片库空闲时加载 hls.js、预取 /watch 路由）                                                    | 复用同一条等待链，在它之后预取可见封面，不另起时序                                                                                                                                                                                             |
| `DramaLink`（`data-drama-cover`）和片库的分批渲染（不虚拟化）                                                          | 加 `data-drama-id`，空闲时按视口几何取前 4 个                                                                                                                                                                                                  |
| `observeDramaHls` / `recordHlsLoads` 的 `manifestInline` 透传                                                          | 同样的方式透传 `prefetch`，不改 `drama-timing.ts` 和 `drama-player.tsx`（两者都在复杂度基线里）                                                                                                                                                |
| `parseDramaStreamOrigin`                                                                                               | 只对 Stream 主机的 play_url 预取子清单                                                                                                                                                                                                         |
| shared `DiagnosticsSchema.hls`（strict）                                                                               | 新增可选 `prefetch`，旧客户端不受影响；hls 相关 schema 拆到 `drama-timing-hls.ts`（原文件加字段后超 500 行）                                                                                                                                   |

不复用 React Query 缓存：`useDramaPlaybackQuery` 按每次播放意图生成新的 key，且 `gcTime: 0`，这是有意的（每次新播放都要确认当前路径）。这次的缓存放在 query 之外，由 `loadDramaPlayback` 统一判断能不能用。

## 数据流

1. 预取：`prefetchDramaPlayback(id, videoId, source, priority)` 先查缓存，命中或请求进行中就直接返回。否则调 `fetchDramaPlayback` 并写入缓存条目 `{ promise, source, resolvedAt, playlists: Map }`。`/play` 成功、format=hls、是 Stream 主机，并且会走 hls.js 时，再解析主清单（用 inline_manifest；没有就跳过，不额外请求主清单），用 `fetch(url, { mode: 'cors', credentials: 'omit', signal: AbortSignal.timeout(5000) })` 拉最低档视频和默认音轨两份子清单。单份上限 256KB，超过就丢弃。
2. 起播：`loadDramaPlayback(id, videoId, signal, fresh)`。fresh 为 true 时绕过缓存。否则依次看：缓存里有没有签发不超过 5 分钟的条目（含进行中的请求）；有没有点击后 10s 内的播放意图。都没有就发新请求，结果也写进缓存（来源记 recent）。用一个 WeakMap 从 playback 对象反查缓存条目，供 loader 和诊断使用。
3. 装载：`loadDramaSource` 用 playback 对应条目里的 playlists 构造 loader。level 和 audioTrack 请求的 URL 命中就直接应答；没命中就把真实网络结果回写进条目。同时记录本次的 usage（来源、ageMs、命中数、字节数），注册到对应的 hls 实例上。
4. 诊断：`observeDramaHls` 读这个 hls 实例的 usage，连同模块级的丢弃计数（读取后清零）一起放进 `diagnostics.hls.prefetch`。

档位选择：hls.js 1.7.4 的 level-controller 先按 RESOLUTION 高度、再按帧率等条件把档位从低到高排，`startLevel: 0` 就是高度最低的那一档。所以选高度最低、同高度码率最低的 EXT-X-STREAM-INF，再取它 AUDIO 分组里 DEFAULT=YES 的 EXT-X-MEDIA（没有就取组内第一条）。URL 用 `new URL(uri, play_url)` 解析，和 hls.js 相对主清单地址解析的结果一致。主清单格式没对上时只会没命中，不会出错。

## 触发点

- 可见封面：`useDramaPlaybackWarmup('/watch')` 在 `preloadDramaHls()` 和 `router.prefetch` 之后，调 `prefetchVisibleDramaCovers(4, resolveVideoId)`，用 background 优先级。DOM 顺序里“随便看看”在网格前面，所以它的起始剧会被包含；从放映页返回、滚动位置恢复后，取的是当时视口里的封面。
- 按下封面：`DramaLink.onPointerDown` 用 critical 优先级。点击时 `startDramaPlayIntent` 先查缓存，命中就不再请求。
- 刚播过的剧：第 2 步的写入加第 3 步的回写，不需要单独触发。

## 可靠性

- 超时：/play 沿用 apiClient 的 5000ms；子清单 5000ms。失败不重试。
- 并发：每个键只有一个进行中的请求；可见封面一次最多 4 个，/play 走 apiClient 的 background 队列。
- 容量：最多 8 条（每条约 90KB），超过就淘汰最旧的；淘汰或过期时，没用过的条目计入 discarded。
- 降级：任何一步失败，就删掉这一步的结果，起播走原路径；loader 没命中就走真实网络。
- 回滚：签发超过 5 分钟丢弃，保证关闭 Stream 开关后，最迟 5 分钟内新播放回到原路径。
- 快进监测：`play_url` 不变，`ownsDramaSource` 不受影响。

## 成本

- 每次进片库最多多 4 次 `/play`（后端只读：读库、本地签名、读主清单缓存），外加约 4×86KB 的子清单流量。
- 按下封面后通常紧接着点击，不算额外成本。

## 预期

Android 大概率仍到不了 95%：剩下的首片首字节加下载约占慢样本的 54%，不在本次范围。首片预取暂缓，等本次上线后看数据再定。如果以后只给前 N 部封面做首片预取，每部约 280KB，N=4 时约 1.1MB。

## 发布顺序

1. 后端：shared schema 新增可选字段，后端带着新版 shared 部署。
2. 前端：后端所有实例都生效之后再部署。
3. 停止条件：护栏任一项不通过，或命中样本出现起播错误，就回滚前端（后端字段是可选的，不用回滚）。
