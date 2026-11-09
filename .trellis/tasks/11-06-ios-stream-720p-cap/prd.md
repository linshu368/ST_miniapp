# iOS Stream 起播封顶 720p

## Goal

缩短 iOS 上 Cloudflare Stream 组的起播时间。iOS 用系统原生 HLS，从主清单第一个档位（多数片 1080p，首片约 580KB）起播，要等整片下完（缓冲到 4s）才能播；封顶到 720p 以缩小首片。

## Requirements

- 仅 Apple 平台（`isAppleWebKit()`）且 `format=hls` 的播放地址，在 `fetchDramaPlayback` 返回处追加 `clientBandwidthHint=2.5`，让 Stream 返回只含单一档位的主清单。
- 改在取址返回处，使 `play_url` 在前端各消费方（播放、快进监测、拖动进度条）里保持同一个值；不得只在 `video.src` 上改写。
- Android（hls.js，已设 `startLevel: 0`）、MP4、其他平台地址不变。
- 不改后端、共享契约和签名逻辑。

## 已知取舍（用户已确认，2026-11-06）

- iOS 的该流失去自动切换画质：网络差时不能降档，网络好也上不了 1080p。
- 参数按带宽而非分辨率裁剪。2026-11-06 对生产片单 30 部剧实测：hint=2.5 时全部落在 ≤720p（23 部 720p、3 部 480p、4 部 360p），没有 1080p。片单新增或重新转码后需复测。
- 若卡顿占比明显上升，改做后端重排主清单（不在本任务内）。

## Acceptance Criteria

- [ ] Apple + hls 的 `play_url` 带 `clientBandwidthHint=2.5`；已有查询参数时用 `&` 连接。
- [ ] Android UA、MP4、无 `play_url` 的返回值不变。
- [ ] 前端 typecheck、相关测试、lint 通过。
- [ ] 发布后按 `app_version` 对比 iOS Stream 的"元数据→开始播放"、起播总耗时和前台卡顿占比。

## Android/iOS 性能 P95 门禁

- 受影响页面：短剧播放页（起播）
- 受影响接口：无（不改接口，只改前端使用的播放地址）
- Android 页面加载 P95：不受影响，不改动
- iOS 页面加载 P95：页面加载不适用；起播口径见下
- 接口 P95：无
- 数据来源与观测窗口：Grafana st-engineering-drama（Loki）。基线窗口：Stream 实验开流 2026-11-04 11:00Z 至 11-06 约 47h，iOS Stream 设置源→开始播放 P50 4.66s / P95 7.59s（Faro 全量，N=25）；元数据→数据 P50 2.69s。发布后取等长窗口，按 app_version 区分前后。
- 发布后验证、无可见样本/低样本及不适用说明：iOS Stream 样本很少（47h 仅 25 次），发布后若 N<30 只当方向参考，不补零。目标：iOS Stream 设置源→开始播放 P50 不高于 Supabase 组 + 1s；前台卡顿占比不明显上升（以看板卡 21 为准）。
