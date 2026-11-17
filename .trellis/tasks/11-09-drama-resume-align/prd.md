# 短剧续播对齐分片边界 + hls.js 起播位置预设 + 预加载提前

## Goal

短剧续播（历史进度恢复）场景下，hls.js 先从 0 秒下载 sn0 分片、ABR 据此估出带宽升到高档，随后又因 `onLoadedMetadata` 里设置 `currentTime` 而清空重拉目标分片，导致续播样本"元数据→数据"均值 1849ms（对比从头播放仅 185ms）。同时会话内首次起播时 `preloadDramaHls()` 与播放器挂载抢带宽，首次主清单请求 P95 达 984ms。本任务让续播直接命中目标分片、首次起播不再等待 hls.js chunk。

## 背景（2026-11-09 生产数据核实，Stream 组、direct 入口、近 72h 成功起播）

- Android direct：N=28，P50 3.40s，P95 6.64s；其中 12 条历史续播样本（`loadeddata` 时 `currentTime` 落在 8–257s），拖累整体均值。
- 会话内首次起播：`source_set`→主清单请求 P95 984ms（最长 1030ms）；后续起播同一会话内均 <53ms。
- iOS direct：N=7，P95 5.09s；续播落在分片末尾时要多等下一分片 + 解码到续播点，多耗 0.5–1.3s。
- Stream 视频分片严格 4.000s（157 分片 mediaMs 全为 4000）；音频分片约 4016ms，边界会逐渐错开。

## Requirements

1. **续播位置对齐分片边界**
   - 只在 `playback.format === 'hls'` 时，把"历史续播"（首页/详情页自动恢复上次进度，即 `resumeExactPosition=false` 的路径）的目标秒数向下对齐到 4s 边界：`floor(seconds / 4) * 4`。
   - Supabase MP4、以及以下两种 `resumeExactPosition=true` 的路径保持精确秒数，不对齐：
     - 网络恢复换签名后同一集续播（checkpoint 分支）
     - `retryPlayback` 续播
   - 保留"接近片尾从头播"规则。
2. **hls.js 起播位置预设**
   - `loadDramaSource` 增加可选 `options.startPosition`，写入 `new Hls({ startPosition })`，让 hls.js 第一片直接请求目标分片而非 sn0。
   - 该位置已由 hls.js 处理时，`onLoadedMetadata` 不重复设置相同的 `currentTime`（避免多一次 seeking）；原生 iOS HLS、MP4 仍在 `onLoadedMetadata` 里设置（HLS 用对齐值，MP4 用精确值）。
3. **预加载时机提前**
   - `preloadDramaHls()` 的调用延后到首帧绘制 + 一次空闲之后触发，复用 `navigation-quiet-window.ts` 里 `afterNavigationQuietWindow()` 既有机制，不新建调度框架。
   - 不改动 `preloadDramaHls` 函数体内的 Apple 分支（归第 2 批）。

## 范围边界（避免与并行批次冲突）

- 负责：`drama-player.tsx` 续播逻辑、`drama-media-source.ts` 的 `loadDramaSource` 起播位置参数、`preloadDramaHls` 的调用位置（`drama-home.tsx`、`dramas/[id]/page.tsx`）。
- 不碰：Apple 原生/hls.js 分支判断、`capAppleHlsQuality`、`preloadDramaHls` 函数体（第 2 批）；Hls 配置里的 loader 相关项（第 3 批）；`packages/shared` 契约（第 2、3 批）。

## Acceptance Criteria

- [ ] 历史续播且 `format=hls` 时，`new Hls({ startPosition })` 收到的值是向下对齐到 4s 的边界值；MP4 与两种精确续播路径不受影响。
- [ ] hls.js 已处理起播位置时，`onLoadedMetadata` 不再触发多余的 `currentTime` 赋值；原生 HLS/MP4 行为不变。
- [ ] `preloadDramaHls()` 调用改为等待首帧绘制 + 一次空闲后触发；Apple 分支逻辑不变。
- [ ] 前端 typecheck、相关测试、lint 通过。
- [ ] 发布后用诊断数据确认：续播样本 hls 分片 sn 等于目标分片、`metadata_to_data` 显著下降；会话首播 `source_set`→主清单请求 P95 下降。

## Android/iOS 性能 P95 门禁

见 `task.json.meta.mobile_performance`；口径为"短剧起播/续播耗时"，非页面加载 P95。
