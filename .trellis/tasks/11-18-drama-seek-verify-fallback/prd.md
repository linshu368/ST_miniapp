# 短剧快进恢复判定兜底

## Goal

无缓冲快进 3s 恢复率（含放弃）自 2026-11-18 起是 P0 主指标，目标 95%。iOS 的恢复率读数（79.4%，分母 97）里混有测量漏判：视频已经恢复播放，却被记成 `unverified`，计入「放弃」。本任务修正快进的恢复判定，让读数反映真实体验。必须先于快进体验优化（`11-18-drama-seek-snap-lowlevel`）上线，否则那边的前后对比会混进口径变化。

## 现状证据（7 天 Faro + 后端 `drama.seek_diagnostic`，只算含 6766d0a3 的版本）

- `perf/drama-seek.ts`：浏览器支持 `requestVideoFrameCallback` 时，`frameMs` 只能由帧回调写入。回调还要满足 `|mediaTime − currentTime| < 1`，并且第一帧在目标 +1s 以内；不满足的帧会被永久忽略。timeupdate 路径只在不支持帧回调时才写 `frameMs`。
- iOS 会话 671fdc（hlsjs_mms）的 8 次快进：seeked 发生在 1.4–4.1s，之后 currentTime 持续前进，最后都被记成 `unverified/paused`。同一会话的 3 次起播用的都是 `video_frame_callback`，说明帧回调能触发，只是快进判定里的条件把帧拒掉了。会话 09773c（native_file）另有 2 条同样的情况（200ms 内 seeked 并开始走时间）。
- 起播判定（`perf/drama-media.ts`）没有 mediaTime 条件，不受影响。

## Requirements

- 支持帧回调、但没有合格帧的时候，以 timeupdate 证明的播放推进作为兜底，判为 `playing`，`frameMethod = 'playing_and_timeupdate'`。
- 兜底不能抢在正常帧回调之前触发：只有在第一次「越过目标」的 timeupdate 之后，又出现一次 currentTime 继续前进的 timeupdate，且这时仍没有合格帧，才走兜底。
- 不改变现有的终态语义：暂停仍是 `unverified/paused`，60s 仍是 `deadline`，换源、离开、后台、错误的判定不变。
- 不改 shared 契约，不新增上报字段（`first_frame_method` 已能区分兜底命中）。
- 不让 `observeDramaSeek`（复杂度基线 324 行）继续变长。

## Acceptance Criteria

- [x] 单测：帧回调的 mediaTime 偏移超过 1s 时，两次前进的 timeupdate 后判为 `playing/playing_and_timeupdate`；帧回调正常时仍是 `video_frame_callback`，且结束时刻不晚于现状；暂停、deadline、换源的终态不变。
- [x] `observeDramaSeek` 行数不高于基线（324→315），并运行 `node scripts/complexity-budget.mjs update`。
- [ ] 上线 3–7 天后：iOS 快进里「seeked 之后 currentTime 前进 ≥0.5s 却记为 unverified」的样本接近 0；按平台报告 `first_frame_method=playing_and_timeupdate` 的占比，Android 应该 <2%（Android 的帧回调本来就正常）。
- [ ] iOS 恢复率按新口径重定基线，汇报时注明「口径修正，不是体验改进」。

## Android/iOS 性能 P95 门禁

- 受影响页面：`/watch`、`/dramas/:id` 播放器的快进测量（不改播放行为）
- 受影响接口：无
- Android 快进含放弃 P95：基线 ≥4856ms / 目标 3000ms（hls.js ≥4350ms）
- iOS 快进含放弃 P95：基线 ≥5300ms / 目标 3000ms（hls.js ≥4666ms）
- 数据来源与观测窗口：Faro `st_drama_seek`（`drama_seek_resume_v1` final，未缓冲、向前、resume_expected=true），2026-11-12T08:44Z～11-18T10:02Z，版本为 6766d0a3 的后代
- 发布后验证：本任务只修测量，P95 和恢复率的变化要标成口径修正；iOS 分母约 100/周、噪声 ±8pp，只报方向

## Notes

- 漏判的根因（为什么这些帧的 mediaTime 不合格）暂不排查；需要的话另开任务，给诊断加字段（要改 shared schema，后端先部署）。
