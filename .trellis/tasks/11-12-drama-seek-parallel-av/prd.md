# 短剧快进音视频并行拉取

## Goal

hls.js 路径（Android `hlsjs_mse`、iOS `hlsjs_mms`）在无缓冲向前快进时，目标位置的视频分片与音频分片并行请求，消除"音频等视频下载并入缓冲后才发请求"的串行等待，使 stream 组无缓冲快进 P95 ≤ 3s。

## 背景（2026-11-12 生产数据，b9923f3c 之后，11-09 08:47Z～11-12 03:46Z）

- stream 组无缓冲快进（`drama_seek_resume_v1`，wasPlaying + forward + buffered=no）：Android hlsjs_mse P50 1.53s / P95 3.31s（n=98，24 会话），真实用户 P95 3.91s（n=38）；iOS hlsjs_mms P95 2.26s（n=47，9 会话）。
- Android 两路覆盖分片串行 27/90（真实用户 14/37），串行样本 P95 4.12s，并行 2.67s；10 条 >3s 中 6 条由串行等待主导。
- 根因（hls.js 1.7.4，最新 canary 未改）：音频分片小、领先视频时，`buffer-controller` 的 "Block audio append until overlapping video append" 把已下载的下一片音频挂起；快进时 `base-stream-controller.onMediaSeeking` 只中止仍在下载（有 loader）的分片，挂起的旧音频片不被中止，音频控制器停在 PARSED 等它入缓冲，直到目标视频片入缓冲解除阻塞，才请求目标音频片。
- 本地复现（Playwright Chromium + hls.js 1.7.4 + 公开 fMP4 分离音轨流，媒体请求 +500ms）：基线串行 8/10、耗时 2.0–3.3s；"挂起旧音频时 stopLoad + startLoad(currentTime, true)" 后串行 0/10、耗时 1.5–2.1s。

## Requirements

1. 仅 hls.js 路径；原生 HLS / MP4 不变。
2. 只在"无缓冲快进 + 存在已下载未入缓冲且不覆盖目标的音频分片"时介入，其余快进不受影响。
3. 只用 hls.js 公开 API 与公开事件，不读写 hls.js 私有字段。
4. 介入失败不能影响播放（异常吞掉）；播放器销毁时解除监听。
5. 快进诊断不变（`drama-seek.ts` 现有口径）；新增"本次快进是否重启加载"不进入本任务（见 Notes）。

## Acceptance Criteria

- [ ] 单测：命中条件时调用 `stopLoad` + `startLoad(currentTime, true)` 各一次；目标已缓冲、无挂起音频、挂起音频覆盖目标、已销毁四种情况不调用；音频入缓冲后不再视为挂起。
- [ ] 本地复现脚本（scratchpad/repro）串行 0/10，快进后能恢复播放且目标位置已缓冲。
- [ ] frontend typecheck、相关单测、lint、complexity 检查通过。
- [ ] 上线后（生产，stream 组）：hls.js 两路串行占比由 30% 降到接近 0；Android hlsjs_mse 无缓冲快进 P95 ≤ 3s（会话 <8 或样本不足时只报方向，不宣称达标）。

## Android/iOS 性能 P95 门禁

- 受影响页面：`/dramas/:id` 与首页短剧播放器的无缓冲向前快进（起播不受影响）
- 受影响接口：无（纯前端播放器加载调度，不新增/改动请求）
- Android 快进 P95：基线 3306 ms（hlsjs_mse，n=98/24 会话；真实用户 3908 ms，n=38）/ 目标 3000 ms
- iOS 快进 P95：基线 2262 ms（hlsjs_mms，n=47/9 会话，手工会话占 38 条）/ 目标 3000 ms（不劣化）
- 接口 P95：不适用
- 数据来源与观测窗口：Loki `drama.seek_diagnostic`（delivery 存在时全量），11-09 08:47Z～11-12 03:46Z；发布后观测 3–7 天
- 发布后验证：同一脚本复算串行占比与 P50/P95，真实/疑似手工（会话终态 ≥15）分层；iOS native_hls 不涉及

## Notes

- 暂缓：快进诊断增加"重启加载"标记；快进 720p 封顶（用户 11-12 拍板暂缓）；向上游 hls.js 报告该行为。
