# 短剧非封面入口预取：下一集、下一部、按下选集

## Goal

自动下一集、详情页上下滑换集、首页 feed 上下滑换剧和选集面板选集起播时，`/play` 地址和两份子清单已经在播放资源缓存（#932，`lib/api/drama-playback.ts`）里，起播不再串行等这几次网络请求，从而提高非 cover 入口的起播 3s 达标率（含放弃）。

## 背景与数据（#932 / 75c5fd57 上线后，2026-11-18T13:49Z～11-19T10:03Z）

- 口径：起播 3s 达标率（含放弃），见 `docs/drama-playback-timing.md`。75c5fd57 之后只合入了快进改动，起播链路没有变。
- Android 全入口 88.2%（分母 170）；cover 80.0%（40）、switch 94.6%（56）、episode 78.6%（28）、direct 93.5%（46）。非 cover 入口占 76%，即使 cover 全部达标，上限也只有 92.9%。
- iOS 全入口 88.1%（分母 84）；switch 80.0%（10）、episode 93.8%（16）。
- 现在只有 cover 有预取，其余入口要现场取址：switch/episode 的 address_wait P50 约 300–440ms，设置源到首片请求 P50 约 620ms（level + 音轨两份子清单串行）。命中预取时这两段都接近 0。
- Android episode 的 6 条不达标都在 3.0–4.9s，且都是 cache=fetch。
- 诊断缺口：已迁移到 Stream 的视频（`storage_provider='cloudflare_stream'`）返回 /play 时不带 `delivery`，后端只保留 ≥5s 的诊断，Android 约 60% 的起播没有完整诊断，无法验证命中。
- 样本局限：Android 82% 的样本来自 11-18 16:50–18:50Z，约 22 个会话。

## Requirements

- R1 已迁移到 Stream 的视频，/play 返回 `delivery = { experimentId: 'stream-migrated', group: 'stream', provider: 'stream', reason: 'assigned' }`；签名失败时与实验组一样降级为 `provider: 'unknown', reason: 'unavailable'`。这样起播诊断会被后端全量写入，Faro 分组也不再是 unknown。
- R2 shared `DRAMA_PREFETCH_SOURCES` 新增 `next_episode`、`next_drama`、`press_episode`。
- R3 当前集播放超过 1 秒后，在一次空闲回调里、`canPrefetchInBackground()` 放行时预取：
  - 非首页（剧详情/专注模式）：本剧下一个可播集，来源 `next_episode`；
  - 首页 feed（embedded）：队列下一部，集取本设备未看完的进度（`resumeVideoId`），来源 `next_drama`。
  - 每个当前集只触发一次，background 优先级。
- R4 片尾前 3 秒的已有预加载（详情）同时预取同一目标的地址和子清单。缓存已有可用条目时不重复请求；条目超过 5 分钟过期后会重新取。
- R5 上下滑手势意图（`useDramaSwipe.onIntent`）同时预取目标的地址和子清单，critical 优先级。
- R6 选集面板按下集数（pointerdown）时，以 critical 优先级预取该集，来源 `press_episode`。
- R7 预取的缓存键必须与播放器实际取址的键一致：非首页为（剧，集 ID）；首页下一部为（剧，`resumeVideoId(剧)`），与 DramaPlayer 初始 `activeVideoId` 一致。
- R8 预取失败、超时、过期一律静默丢弃，沿用 #932 的缓存与降级规则；不能让当前播放卡顿，也不能让起播报错或变慢。

## 不做

首片预取；边缘预热；客户端签名；批量签发全集地址；往回滑的主动预取（手势意图和已有的回写覆盖）；首页会话首播；iOS 设置源后卡住的定位（另开任务）。

## Acceptance Criteria

- [ ] A1 自动下一集、详情上下滑、首页往下滑、选集命中时，诊断 `diagnostics.hls.prefetch.source` 为对应来源，`addressSource` 为 cache 或 inflight，level/audio_track 条目没有 firstByteMs。
- [ ] A2 预取的键与播放器取址的键一致（单测锁定，覆盖首页带进度/不带进度和非首页三种情况）。
- [ ] A3 已迁移 Stream 视频的 /play 带 delivery；签名失败时为 unavailable（后端测试）。
- [ ] A4 能按入口 × 平台区分命中与未命中样本的 3s 达标率（含放弃）。
- [ ] A5 护栏：起播失败率上升不超过 1 个百分点，快进 3s 恢复率下降不超过 4 个百分点，剔除占比波动不超过 5 个百分点；/play 客户端 P95 不劣化（+5% 以内）；当前集播放中卡顿占比不上升。
- [ ] A6 先部署 PR1（后端 + shared），Railway 全部实例生效后再合并 PR2（前端）。

## Android/iOS 性能 P95 门禁

- 受影响页面：/watch（首页 feed 换剧）、/dramas/:id 与 /watch 专注模式（换集、自动下一集、选集）
- 受影响接口：POST /api/dramas/play（每看一集/一部多 1 次，background 优先级）
- Android 起播含放弃 P95（下界）：基线 ≥3490ms（全入口），episode ≥3390ms，switch ≥2810ms；目标 3000ms（等价达标率 95%）
- iOS 起播含放弃 P95（下界）：基线 ≥5800ms（全入口），switch ≥14900ms（分母 10），episode ≥4310ms（分母 16）；目标 3000ms
- 接口 P95：/play 客户端总耗时 Android P95 747ms（n=47），iOS 852ms（n=40）；目标不劣化（+5% 以内）
- 数据来源与观测窗口：见 task.json meta.mobile_performance.measurement
- 发布后验证：按 app_version 是否为 PR2 合入提交的后代分组，等长窗口（最好 7 天）复查。PR1 上线后已迁移视频的 Faro 分组从 unknown 变成 stream（实验 ID `stream-migrated`），跨 PR1 对比时按 unknown+stream 合并

## Notes

- 预期 Android 到约 91%，到不了 95%：剩下的主要是弱网会话的首片下载。iOS 的主要问题是设置源后卡住，不在本次范围。
