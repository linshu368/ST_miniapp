# iOS 短剧 hls.js 低档起播 + 引擎诊断

## Goal

iOS 短剧播放在支持 `ManagedMediaSource`（MMS）且开关打开时，从原生 HLS 切换到 hls.js，从最低画质档起播并由 ABR 升档；拿到分片级诊断；开关关闭时随时回退原生当前行为；诊断能按播放引擎（hlsjs_mse / hlsjs_mms / native_hls / native_file）区分。

本批（第 2 批）是「iOS 起播优化」三批改动中的一批，合入顺序 1→2→3：

- 第 1 批（并行）：续播对齐 + startPosition + 提前预加载 chunk。
- 第 3 批（并行）：主清单随 `/play` 下发。
- 第 2 批合入前需 rebase 第 1 批。

## Background

- iOS 现在走原生 HLS（`isAppleWebKit()` 分支直接设置 `video.src`）。取地址时 `capAppleHlsQuality` 在播放地址上追加 `clientBandwidthHint=2.5`，把 Stream 返回的主清单裁到只剩一个档位（实测 ≤720p），目的是让播放、快进监测、拖动进度条用同一个 `play_url`（见已完成任务 `archive/.../ios-stream-720p-cap`）。
- iOS direct 组现网 N=7，P95 5.09s；最大一段是元数据→loadeddata，P50 1.76s，在等首个视频/音频分片；原生 HLS 只暴露主清单一条资源计时，这段时间没法再拆分。
- Android 用 hls.js，`startLevel: 0`，从 240p 起播再由 ABR 升档，有完整分片级诊断。
- 项目里的 hls.js 是 1.7.4，默认 `preferManagedMediaSource=true`；用 MMS 时会自动设置 `video.disableRemotePlayback`，否则 Safari 不允许打开 MMS，代价是 AirPlay 不可用（小程序场景可接受）。
- 未知项：Telegram iOS 的 WKWebView 里有没有 `ManagedMediaSource`；Safari 在 iOS 17.1+ 有，WKWebView 没有验证过——这是真机验证清单的第一项，也是开关打开后功能是否生效的前提。

## Requirements

### 1. 引擎选择（同步判断，唯一判断源）

- 只在「Apple 设备 + `window.ManagedMediaSource` 存在 + 开关打开」时走 hls.js；否则走原生（含 iOS 17.1 以下、WKWebView 不支持 MMS 的情况）。
- 判断必须同步完成（检测 `'ManagedMediaSource' in window`，不等 hls.js 异步 `import()` 完成）。
- 判断封装成唯一一个函数；`capAppleHlsQuality`（取地址时）和 `loadDramaSource`（装载时）都调用它，保证两处对同一次播放做出的 Apple/hls.js 判断一致，`play_url` 不会因为两处判断不一致而错配。
- Android 和非 Apple 设备的现有逻辑不变。

### 2. 开关

- 新增前端公开环境变量（命名在 design.md 中定，例如 `NEXT_PUBLIC_DRAMA_IOS_HLSJS`），未设置时默认关闭（走原生，现状不变）。
- 先在 Vercel preview 环境打开验证，再打开 production；具体环境怎么配在 design.md 写清楚，配置动作需用户在对话中确认后才执行。
- 同步更新 README 环境变量说明。

### 3. 去掉 720p 封顶（仅 hls.js 路径）

- `capAppleHlsQuality` 判定为走 hls.js 路径时，不再追加 `clientBandwidthHint`；原生降级路径（开关关闭、无 MMS、iOS 17.1 以下等）继续保留 2.5 封顶，行为不变。
- 目的：先看 hls.js 路径下的实际画质表现——iOS 应和 Android 一样从最低档起播，再由 ABR 升档。

### 4. 预加载

- `preloadDramaHls` 函数体里 `isAppleWebKit()` 直接 return 的逻辑改为：iOS 走 hls.js 时也预加载 `import('hls.js')`。
- 只改函数体，不改调用位置（调用位置由第 1 批改动）。

### 5. 诊断增加播放引擎维度

- 新增枚举 `hlsjs_mse` / `hlsjs_mms` / `native_hls` / `native_file`，取值必须来自 hls.js 实际使用的 `MediaSource` 类型（`MEDIA_ATTACHED` 事件的 `data.mediaSource` 是否为 `ManagedMediaSource` 实例），不能用「开关打开就等于 MMS」这种推测值。
- 先在 `packages/shared/src/api/drama-timing.ts` 的 `DramaTimingReportSchema` 定义成可选字段。
- 接入前端 Faro 上报（`st_drama_startup` / `stage` / `first_frame` / `diagnostic` / `seek` / `seek_stage`，参考 `env-tags.ts`、`grafana.ts` 现有枚举维度字段的做法）和后端 `drama.startup_diagnostic` / 快进诊断写入（`packages/backend/src/lib/engineering-observability.ts`）。
- 看板改动不在本批，只要保证 Loki 日志体里能按这个字段查询（JSON 字段或附加 label 均可，不要求新建看板卡）。

## 口径变化（务必让工程师看到）

- iOS 的快进会改由 hls.js 处理，`buffered` 的判断方式也会变（MSE 的 `video.buffered` 和原生 HLS 不同），iOS 快进 P95 前后不能直接比，必须按引擎维度分开看。
- 所有比对 `video.currentSrc` 的地方，在 hls.js 下 `currentSrc` 是 `blob:` 地址：`drama-seek.ts` 已经改用 `ownsDramaSource`（登记的所有权），不受影响；`use-drama-scrub.ts` 约 50 行比对的是自己记录的 `currentSrc`（上一次观察到的值，不是 `play_url`），也不受影响——这两处已核实，设计阶段不需要改动。

## Non-Goals（本次不做）

- 续播对齐、`loadDramaSource` 的起播位置参数（第 1 批负责，不改第 1 批改动的调用位置）。
- hls.js 配置里的 loader、`DramaPlayback` 契约改动（`packages/shared/src/api/drama.ts`，第 3 批负责）。
- Grafana 看板改动（只需保证 Loki 能查询新字段）。
- 生产环境变量的实际配置动作（写清楚配置方案，由用户确认后手动执行或明确授权后执行）。

## Acceptance Criteria

- [ ] 开关关闭（未设置环境变量）时，iOS 行为与现状完全一致：原生 HLS + `clientBandwidthHint=2.5` 封顶 + 不预加载 hls.js。
- [ ] 开关打开 + 真机验证到 `ManagedMediaSource` 存在时：iOS 走 hls.js，从最低档起播，无 720p 封顶，能在诊断里看到分片级 hls 加载记录和引擎字段 `hlsjs_mse`/`hlsjs_mms`。
- [ ] 开关打开但当前设备/WebView 没有 `ManagedMediaSource`（或 iOS 17.1 以下）时：自动回退原生，行为等同开关关闭。
- [ ] `capAppleHlsQuality` 和 `loadDramaSource` 对同一次播放的 Apple/hls.js 判断结果一致（同一判断函数）。
- [ ] 起播诊断（`drama.startup_diagnostic`）和快进诊断（`drama.seek_diagnostic`）的 Loki 日志体里都能看到引擎字段。
- [ ] Android、非 Apple 设备、MP4 行为不变。
- [ ] 前端/共享包 typecheck、相关测试（含更新后的 `drama-media-source.test.ts`）、lint 通过；跨包契约改动后运行 shared 测试及消费者 typecheck。
- [ ] README 环境变量说明同步更新。

## Android/iOS 性能 P95 门禁

- 受影响页面：短剧播放页（起播耗时与快进耗时，非页面加载）
- 受影响接口：无（不改接口，只改前端播放路径、诊断字段和共享 schema）
- Android 页面加载 P95：不受影响，不改动；门禁基线=目标 6.64s（近 72h direct 入口口径，N=28/18 会话，仅用于满足“不劣化”声明，不是本任务优化目标）
- iOS 页面加载 P95：页面加载不适用；起播/快进口径见下
- 接口 P95：无
- 数据来源与观测窗口：Grafana st-engineering-drama（Loki）。近 72h（截至 2026-11-09 15:48，stream 组成功样本）：iOS 起播整体 P95 4.83s（N=14），direct P95 5.09s（N=7），元数据→loadeddata P50 1.76s；iOS 无缓冲快进 P95 4.06s（N=9，原生口径）。发布后取等长窗口，按 app_version + 新增引擎字段分前后。
- 发布后验证、无可见样本/低样本及不适用说明：样本少（iOS 起播 N=14、快进 N=9），目标不写死数字，写方向性目标——「iOS hls.js 路径的起播 P95 不高于原生基线，并拿到分片级拆分」；iOS 快进在 hls.js 下的 `buffered` 口径与原生不同，前后不能直接比，只按引擎维度分别观察，不与原生基线比较差值。发布后 N<30 只作方向参考，不补零。

## Notes

真机验证清单、发布后验证方法见 `design.md`。
