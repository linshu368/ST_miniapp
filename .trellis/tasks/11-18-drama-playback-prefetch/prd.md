# 短剧播放资源缓存：片库封面预取地址与清单

## Goal

用户在片库点封面、在放映页往回滑或回到同一部时，`/play` 地址、主清单、最低档视频子清单和默认音轨子清单已经在前端缓存里，起播不再串行等这几次网络请求，从而提高起播 3s 达标率（含放弃）。

## 背景与数据（#888 上线后）

- 主指标是起播 3s 达标率（含放弃），口径见 `docs/drama-playback-timing.md`（分支 `docs/drama-startup-abandon-budget`）。只算成功样本的 P95 只做对照。
- 基线（Faro，按 duration_ms 分类，不能剔除自动点播脚本）：Android 2026-11-17T11:52Z 至 11-18T11:00Z，全入口 83.1%（分母 231），cover 70.8%（分母 89）；iOS 近 7 天，全入口 64.5%（分母 242），cover 48.8%（分母 80）。
- Android cover 占全部 >3s 样本的 72%，iOS 占 89%。会话首播几乎都是 cover。11-13 剧场合并后，已经没有冷启动直接进 /watch 的场景。
- 会话首播点的封面里，前 3 部占 49%，前 5 部占 62%；几乎都从第 1 集开头看。点封面前在片库停留 P10 3.7s，P50 9.8s。
- Android 会话首播的慢样本耗时构成：取址 24%，主清单加子清单 18%，首片首字节 14%，首片下载加追加 40%。
- 子清单每个分片行都带绑定 token 的签名（11-09 已验证），不能跨 token 复用，只能用同一次 `/play` 的 token 预取。

## Requirements

- R1 前端播放资源缓存，以 (dramaId, 请求的 videoId) 为键，保存 `/play` 结果、主清单（沿用内联）、最低档视频子清单和默认音轨子清单。
- R2 签发超过 5 分钟就丢弃（保证 Stream 关闭开关后，最迟 5 分钟内新播放回到原路径）。播放失败后的重试（freshRequest）一律绕过缓存。
- R3 hls.js 装载时，按 URL 命中缓存的 level/audioTrack 请求直接应答；没命中就原样走网络。hls.js 实际拉到的子清单回写进缓存，用于往回滑和回到同一部。`play_url` 不变。
- R4 片库 /dramas 在背景任务放行、静默期和一次空闲之后，并且 `canPrefetchInBackground()` 放行时，预取视口内按 DOM 顺序的前 4 个 `[data-drama-cover]`。每部取第 1 集；本地有未看完进度的用进度里的 videoId。复用 `useDramaPlaybackWarmup` 的等待链。
- R5 按下封面（pointerdown）时立即预取这一部。点击时原有的播放意图共用同一份缓存，命中时不重复请求。
- R6 起播诊断 `diagnostics.hls.prefetch` 记录：来源（visible_cover / press_cover / intent / recent）、签发后多久被用上、子清单命中数和字节数，以及从上一份报告到现在丢弃了几次、丢弃了多少字节。
- R7 预取失败、超时、过期一律静默丢弃，不能让起播报错或变慢。所有外部请求都要有明确的超时。

## 不做

episode 入口；放映页播放中预测下一部（暂缓，缓存和 loader 复用，以后补很便宜）；冷启动预取（已删）；首片预取（暂缓，等本次数据）；Faro 上报 prefetch 字段；后端子清单内联。

## Acceptance Criteria

- [ ] A1 片库点封面命中（可见封面预取或按下封面预取），以及往回滑或回到同一部命中时，hls.js 不再对 `/play` 和两份子清单发真实网络请求：诊断中命中样本的 level/audio_track 条目没有 firstByteMs，addressSource 为 cache 或 inflight。
- [ ] A2 没命中时完全走原路径，起播不报错。缓存过期、重试绕过、URL 不匹配都有单测覆盖。
- [ ] A3 能按入口（重点是 cover）和平台，区分命中与未命中样本的 3s 达标率（含放弃）、P50 和 P95（只做对照）。
- [ ] A4 护栏：起播失败率上升不超过 1 个百分点，快进 3s 恢复率下降不超过 4 个百分点，剔除占比波动不超过 5 个百分点；/play 客户端 P95 不劣化（+5% 以内）。
- [ ] A5 能用诊断里的 discarded 计数和字节数估算浪费的流量。
- [ ] A6 先部署后端（shared schema），再部署前端。

## Android/iOS 性能 P95 门禁

- 受影响页面：/dramas（空闲时预取），/watch 与 /dramas/:id 起播
- 受影响接口：POST /api/dramas/play（调用量每次进片库最多 +4，background 优先级）
- Android 起播含放弃 P95（下界）：基线 ≥3820ms，目标 3000ms（等价达标率 95%）。cover 为 ≥4520ms
- iOS 起播含放弃 P95（下界）：基线 ≥7860ms（近 7 天），目标 3000ms
- 接口 P95：基线 1140ms（Android 客户端总耗时），目标 1200ms
- 数据来源与观测窗口：见 task.json meta.mobile_performance.measurement
- 发布后验证：按 app_version 是否为合入提交的后代，取等长窗口（最好 7 天）复查；iOS 样本少，只报方向

## Notes

- 预期本次 Android 也到不了 95%：首片首字节加下载约占慢样本的 54%，不在本次范围。
