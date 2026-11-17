# 设计

## 改动点

| 文件                                                        | 改动                                                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shared/src/api/drama.ts`                                   | `DramaPlayback.inline_manifest?: string`                                                                                                                                                         |
| `backend/src/features/drama/stream-manifest-cache.ts`（新） | `DramaStreamManifestCache`：按 `uid` 缓存主清单内容，LRU + TTL，300ms 超时取不到就降级为 `undefined`，不抛异常                                                                                   |
| `backend/src/routes/drama-play.ts`                          | `DramaStage` 增加 `'manifest'`；`DramaRequestTiming` 增加 `manifest: DramaManifestObservation`；Stream 成功签名后查缓存                                                                          |
| `backend/src/routes/drama.ts`                               | 实例化 `DramaStreamManifestCache`（进程内单例）并传入 handler；`onRequest`/`onResponse` 补 `manifest` 初值与日志字段                                                                             |
| `backend/src/lib/engineering-observability.ts`              | `observeDramaRequest` 的 `stages`/`signCache` 旁加 `manifestCache`，stage 遍历数组加 `'manifest'`                                                                                                |
| `frontend/src/lib/drama-inline-manifest-loader.ts`（新）    | `createInlinePlaylistLoader(matchUrl, content)`：返回满足 hls.js `PlaylistLoaderConstructor` 的类                                                                                                |
| `frontend/src/lib/drama-media-source.ts`                    | hls.js 分支里，`playback.inline_manifest` 存在时把 `pLoader` 传进 `new Hls({...})`                                                                                                               |
| `shared/src/api/drama-timing.ts`                            | `DiagnosticsSchema.hls` 增加 `manifestInline?: boolean`（与 `entries`/`truncated` 同级）                                                                                                         |
| `frontend/src/lib/perf/drama-hls.ts`                        | `recordHlsLoads`/`observeDramaHls` 新增一个可选末位参数 `manifestInline?: boolean`，原样放进 `emit()` 的 snapshot                                                                                |
| `frontend/src/components/drama/drama-player.tsx`            | 调用 `observeDramaHls(hls, events, timing)` 处改成 `observeDramaHls(hls, events, timing, Boolean(playback.inline_manifest))`（已确认该调用点在第 556-571 行，`playback` 已在作用域内，一行改动） |

## 复用调研

- 后端缓存沿用 `DramaSignedUrlCache`（`signed-url.ts`）同一套模式：`entries: Map` + `inFlight: Map` 去重并发签名/拉取 + `evictIfNeeded()` 插入顺序淘汰。不新建通用 LRU 工具类——两处缓存的 key/value 形状不同（一个存 URL+到期时间，一个存清单文本+写入时间），强行抽公共基类对两处都要拆字段，复杂度不降反升，按"最小充分方案"直接复制同一套三段式结构（取缓存 → 查 inflight → 签/拉+写缓存），不新增抽象层。
- 超时双重保险：默认实现用 `fetch(url, { signal: AbortSignal.timeout(300) })` 真正中止网络请求；`fetchAndCache` 外层再包一次本地 `withTimeout`（结构上和 `signed-url.ts` 的同名函数一样，但不导入复用——这里包的是注入的 `fetchManifestFn`，不只是默认实现，测试替身不实现 `AbortSignal` 时也一样受这个超时约束）。
- `/play` 的计时/日志骨架（`measure`、`timings` WeakMap、`onResponse` 里的 `drama.request_timing` 事件）完全复用现有结构，只追加一个 stage 和一个观测维度，不新建计时系统。
- 前端 hls.js 集成复用现有 `loadDramaSource` 的分支结构和 `onHls` 回调时机（`hls.on` 订阅必须在 `loadSource` 之前，已有代码保证），不改函数签名、不加 `options` 参数——内联内容直接从已经作为参数传入的 `playback` 读取。
- 搜索过 `packages/backend/src/lib` 和 `packages/frontend/src/lib` 没有现成的通用 playlist loader 或 HLS 自定义 loader 封装，`createInlinePlaylistLoader` 是本任务唯一的新抽象，职责单一（只做"manifest 且 url 匹配就直返，否则转发真实 loader"）。

## 可靠性设计

- **超时**：拉取用 `fetch(signed.play_url, { signal: AbortSignal.timeout(300) })`，300ms 是用户给的建议值，也和阶段一实测的 180-210ms 本地 TTFB 对得上（留出到生产 P50 628ms 之间的余量不够覆盖慢尾部，但本任务要求的是"取不到就跳过"而不是"一定取到"，300ms 超时本身就是故意收紧、宁可降级）。
- **重试**：不重试。失败路径就是"这次 /play 不带 inline_manifest，前端照常发真实请求"，重试只会让 /play 本身更慢，且下一次缓存未命中时还会再试一次，等价于有限重试。
- **并发**：同一 `uid` 并发拉取用 `inFlight` Map 去重，和 `DramaSignedUrlCache` 一致。
- **缓存容量/过期**：`MAX_ENTRIES = 64`（当前白名单固定 30 个 uid，留出增长空间），`TTL_MS = 10 分钟`。内容本身极少变化（重新转码才会变），10 分钟只是为了避免一个坏缓存条目永久卡住，不是因为预期会频繁失效。
- **降级面**：缓存/拉取任何异常只影响 `inline_manifest` 是否出现，不影响 `signed.play_url` 本身，也不改变 `/play` 的状态码；这条路径本来就没有 `inline_manifest` 字段，行为等同于今天。
- **可观测性**：`manifest_cache`（hit/miss/inflight/unused）和 `manifest_ms` 进 `drama.request_timing`（Prometheus 维度 + Loki 事件），和现有 `sign_cache` 并列，上线后能直接看命中率和拉取耗时分布，不需要新看板。

## 最小充分方案

- 不做配置化：300ms 超时、64 条上限、10 分钟 TTL 都是硬编码常量（和 `signed-url.ts` 里 `SIGN_TIMEOUT_MS`/`MAX_ENTRIES` 一样），不读环境变量——当前没有"按环境调超时"的需求，加了也没人会去调。
- 不做插件化/多 CDN 抽象：这一期只服务 `delivery.group === 'stream'` 这一条路径，Supabase/Bunny 路径不动，不提前为"以后可能还有别的 CDN 也想内联"设计通用接口。
- `inline_manifest` 用纯字符串而不是结构化对象：主清单本身就是 m3u8 文本，前端拿到后原样当 `LoaderResponse.data` 用，没有需要结构化的字段。

## 演进与恢复

- **兼容方向**：`inline_manifest` 是可选字段，老前端（没有 pLoader 逻辑）收到也会忽略（`/play` 响应走 `JSON.parse` + 泛型断言，非 strict schema，已在阶段一核实）；老后端（没加这个字段）不影响新前端——`playback.inline_manifest` 是 `undefined`，`loadDramaSource` 直接走原来的真实网络加载器分支，和今天完全一样。
- **发布顺序**：不互相阻塞，技术上前后端谁先上都不会坏。建议顺序仍是后端先上线——先观察几十分钟 `manifest_cache` 命中率和 `manifest_ms` 是否符合预期（阶段一本机实测 180-210ms），确认后端这一半稳定后再上前端消费，降低"两个新东西一起上线、出问题分不清是哪一半"的排查成本。
- **回滚**：前端回滚只是不再传 `pLoader`，字段继续被忽略，无风险。后端回滚会让 `inline_manifest` 消失，新前端的 hls.js 分支里 `playback.inline_manifest` 为 `undefined`，自动退回真实网络请求，不需要额外开关。
- **停止条件**：如果上线后 `manifest_cache` 命中率明显低于预期（比如白名单视频被频繁换成新 uid，缓存一直 miss），现象是 `/play` 偶尔多 300ms，不影响正确性，可以先观察而不必立即回滚；如果 `manifest_ms` 经常顶到 300ms 上限导致接口 p99 明显超过 1100ms 目标，再考虑调低超时或直接关掉这条缓存逻辑（改一行判断永远 miss 即可降级，不需要 feature flag）。

## 诊断标记：为什么选显式字段，不选隐性留白

两个候选方案比较过复杂度和维护成本：

- **隐性留白**（`pLoader` 回传 `stats.loading.start === end` 且不填 `first`，靠 `recordHlsLoads` 里 `positive()` 判断非正数自动省略 `firstByteMs`）：零新增字段、零跨批协调，但信号不可靠——真实网络如果恰好极快（同 tick 返回，或某些 loader 实现对 `first` 的记录本身就是 0），也会呈现同样的"duration 0 + 无 firstByteMs"特征，无法严格区分；而且这个约定只存在于代码注释里，不在类型/schema 里，以后改 `timing()` 的实现很容易无声破坏这个信号，没有编译期或校验期报错。
- **显式字段**（采用）：`diagnostics.hls.manifestInline?: boolean`，自解释，不依赖隐含约定，不会和任何真实网络场景混淆。成本是改 3 个文件（`drama-timing.ts` 契约、`drama-hls.ts` 的两个函数签名各加一个尾部可选参数、`drama-player.tsx` 一行调用点），且都是纯增量/可选参数，不重构既有逻辑，和第 2 批并发改动同一批文件时冲突面很小。

权衡下来显式字段的实现成本可控（3 处都是加字段/加可选参数，不是改结构），比隐性留白更不容易在未来被悄悄破坏，采用显式字段。取值只读 `playback.inline_manifest` 是否存在（"后端是否提供了内联内容"），不追踪 hls.js 是否真的走了内联分支——这个更精确的信号没必要做：后端 `manifest_cache` 命中率已经是权威数据源，前端诊断只是交叉验证，两者对不上本身就是一个值得排查的信号，不需要为了消除这个理论上的落差再加一层"内联是否真正被使用"的回调。

## 其他拒绝的方案

- **把 `DramaStreamManifestCache` 和 `DramaSignedUrlCache` 合并成一个通用缓存类**：两者 key 空间（`uid` vs `${scope}:${provider}:${objectPath}`）、淘汰策略触发点、以及要不要跟着 CDN 配置哈希隔离缓存键都不一样，提前抽象只会让两边都要通过一层不贴合自己场景的接口，违反"复用不是提前泛化"。
- **给 `loadDramaSource` 加 `options` 参数传内联内容**：违背用户明确的偏好——内联内容已经在 `playback` 参数里，不需要再加一个参数搬运同一份数据。
