# 短剧 Stream 主清单随 /play 内联下发（第一期）

## 背景

起播要依次经过主清单 → 子清单 → 首分片三次请求，地址层层来自上一步响应，无法并行。2026-11-09 用生产签名配置对白名单片单做的只读验证确认：

- 主清单内容与签名 token 无关（两个不同 token 取到的内容逐字节相同），换新 token 的路径重新拼相对路径后，子清单/分片请求都能正常鉴权（200）。
- Cloudflare 边缘不缓存主清单/子清单这两层（连续 3 次请求 `cf-cache-status` 响应头始终缺失，TTFB 稳定在 180-210ms 不随重复请求下降）；分片层有正常边缘缓存（命中后 TTFB 明显下降）。
- 子清单约 43KB 是因为每个分片行都带约 522 字符的分片级签名查询参数，这个签名绑定当次 token，换 token 内容就不同（即使同一 token 重复请求，内容逐字节不变）。

这证明"主清单可以安全跨 token 复用缓存"，但"子清单不能"（已在前序只读验证中确认，子清单内联维持暂缓，不在本任务范围）。

## 目标

Stream 组 HLS 起播时，省掉浏览器单独发出的主清单请求：后端按视频 uid 在进程内存缓存主清单内容，随 `/play` 响应一起下发；前端 hls.js 用自定义 pLoader 直接返回这段内容，不再发真实网络请求。

## 需求

- `packages/shared/src/api/drama.ts` 的 `DramaPlayback` 增加可选字段 `inline_manifest?: string`，装主清单原始文本。旧前端忽略新字段（`/play` 响应解析是普通 `JSON.parse` + 泛型断言，非 strict schema，已核实不会因多出字段报错）。
- 后端：仅对 `stream.delivery.group === 'stream' && fallback !== 'mp4'`（当次签名走 Cloudflare Stream）这条路径生效。签名成功后，按 `video.uid` 查内存 LRU 缓存：
  - 命中：直接用缓存内容，不发起网络请求。
  - 未命中：用刚签出的 `signed.play_url` 去 Stream 拉取，超时 300ms；成功写入缓存，失败/超时不重试、不报错，`inline_manifest` 字段直接省略，`/play` 正常返回剩下的字段。
  - 不影响 Supabase/Bunny（MP4 回退）路径。
- 缓存命中/未命中/拉取耗时，按 `drama.request_timing` 现有 `sign_cache` 的记法加一个 `manifest_cache` 维度（`hit`/`miss`/`inflight`/`unused`）和 `manifest_ms` 耗时字段。
- 前端：`loadDramaSource` 的 hls.js 分支里，`playback.inline_manifest` 存在时，给 `new Hls({...})` 传自定义 `pLoader`：请求类型是 manifest 且地址等于 `play_url` 时直接返回内联内容（响应 `url` 设为 `play_url`，保证相对路径解析正确）；其他所有请求（子清单、分片、以及不匹配的 manifest 请求）照常走真实网络加载器。
- 只影响 hls.js 路径（Android 及非 Apple-native 场景）；iOS 原生 `<video>` 路径不读 `inline_manifest`，不受影响，要等第 2 批把 iOS 切到 hls.js 才有收益。
- 起播诊断里显式标记"这次主清单来自内联"：`shared/src/api/drama-timing.ts` 的 `diagnostics.hls` 增加可选 `manifestInline?: boolean`（与 `entries`/`truncated` 同级，不进每条 `HlsLoadSchema`）；取值直接来自 `playback.inline_manifest` 是否存在，不单独验证 hls.js 是否真的走了内联分支——和后端的 `manifest_cache` 命中率交叉验证即可，不需要在前端再做一次精确确认。

## 不做

- 子清单内联（第二期，已拍板暂缓：子清单每行是分片级签名、跟 token 绑定，内联需要再解决"按分片重新签名"，复杂度跳档，不在本任务重新评估）。
- 续播对齐、startPosition（第 1 批范围）。
- iOS 改用 hls.js、播放引擎诊断字段、`capAppleHlsQuality`、`packages/shared/src/api/drama-timing.ts`（第 2 批范围，本任务不碰）。
- 不新增/不改动 `HlsLoadSchema`（单条 hls 加载记录的结构）、不往 hls.js 的 `LoaderStats` 里塞自定义字段——只在 `diagnostics.hls` 这个外层对象加一个独立的 `manifestInline?: boolean`，不触碰逐条记录的既有字段和 hls.js 类型本身。

## 验收

- shared/backend/frontend 相关包 typecheck 与现有测试通过；新增测试见 implement.md。
- `inline_manifest` 只出现在 Stream 组 HLS 命中缓存的响应里；缓存未命中/超时/非 Stream 路径下 `/play` 响应不受影响、不变慢超过 300ms 上限、不报错。
- 本地/预览环境验证：同一视频连续两次 `/play`（不同用户态签名），第二次 `manifest_cache=hit`，hls.js 不再对 `play_url` 发真实网络请求（Network 面板或 hls.js `MANIFEST_LOADED` 事件的 `stats.loading` 起止时间相同、无 `first`）。
- 发布顺序：前后端互不阻塞（字段可选、前端非 strict 解析），建议后端先上线观察 `manifest_cache` 命中率，确认稳定后再上前端消费内联内容。
