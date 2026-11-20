# Design：非封面入口预取

## 复用调研

| 已有                                                                                                                                                                                                           | 处理                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/api/drama-playback.ts` 的 `prefetchDramaPlayback` / `loadDramaPlayback`（#932 播放资源缓存：按 (剧, 请求的集) 缓存 /play 和两份子清单；5 分钟过期、地址剩余有效期 ≥5 分钟、进行中请求只接 10s、重试绕过） | 原样复用，只新增来源枚举。不改缓存规则                                                                                                                                                           |
| `usePreloadDramaPlayback`（`lib/api/drama.ts`，片尾前 3 秒和手势意图时预取详情）                                                                                                                               | 扩展：同时调 `prefetchDramaPlayback`。注释原说"视频地址在实际播放时确认当前路径"，11-12 已放宽为 5 分钟内可复用，规范第 28 行也写的是"最后 3 秒只预取下一条地址"，代码与规范此前不一致，本次对齐 |
| DramaPlayer 里片尾前 3 秒的 effect 与 `onIntent` 里的预加载                                                                                                                                                    | 搬进新 hook `components/drama/use-drama-next-prefetch.ts`，播放器只调用 hook。drama-player.tsx 与 DramaPlayer 在复杂度基线里，搬出后行数减少，不追加                                             |
| `canPrefetchInBackground()`、空闲回调                                                                                                                                                                          | 复用于"播放 1 秒后"的推测性预取；片尾前 3 秒与手势意图是高确定性，不走门控（与原预加载一致）                                                                                                     |
| `resumeVideoId`（drama-library-store）                                                                                                                                                                         | 复用：首页下一部的集与 DramaPlayer 初始 `activeVideoId` 同一规则（未看完的进度，否则不传集）                                                                                                     |
| `EpisodeSheet` 的集数按钮                                                                                                                                                                                      | EpisodeSheet 在函数长度基线里（255）。把集数网格拆成同文件内的 `EpisodeGrid` 组件，再加 `onPress`，EpisodeSheet 函数变短                                                                         |
| `use-drama-stream-playback.ts` 的 `recoverStream`（delivery.group==='stream' 时签名/媒体失败自动重新取址一次）                                                                                                 | 不改。R1 之后已迁移视频也会获得这一次有限重试，与规范"Stream 签名或媒体失败时每次播放意图可自动重新取址一次"一致                                                                                 |
| 后端 `observeDramaStartupDiagnostic`（有 delivery 才全量写入）                                                                                                                                                 | 不改条件，靠 R1 让已迁移视频带 delivery                                                                                                                                                          |

## 数据流

1. 当前集 `time ≥ 1s` 且页面可见 → 每个当前集一次 → 空闲回调 → `canPrefetchInBackground()` → `preload(target, 'background')`，预取详情（React Query）和地址+子清单（播放资源缓存）。
2. 片尾前 3 秒 → 每个当前集一次 → `preload(target, 'background')`。缓存里已有可用条目时 `prefetchDramaPlayback` 直接返回；过期的条目已被清掉，会重新取。
3. 手势意图 → `preload(adjacent, 'critical')`。非首页两个方向都预取；首页只预取下一部（与原逻辑一致）。
4. 选集按下 → `prefetchDramaPlayback(id, videoId, 'press_episode', 'critical')`。点击时 `selectEpisode` → `useDramaPlaybackQuery` → `loadDramaPlayback` 接上。
5. 起播时 `loadDramaPlayback` 记录条目来源，hls.js pLoader 命中子清单，诊断 `diagnostics.hls.prefetch.source` 为对应来源。

目标解析：

| 模式          | 方向 1                                    | 方向 -1                  | 来源         |
| ------------- | ----------------------------------------- | ------------------------ | ------------ |
| 非首页        | (id, nextPlayableId)                      | (id, previousPlayableId) | next_episode |
| 首页 embedded | (nextDramaId, resumeVideoId(nextDramaId)) | 不预取                   | next_drama   |

往回滑的手势意图也记 `next_episode`（"相邻集"），不再细分。

## 可靠性

- 超时、并发、容量、降级：沿用 #932（/play 5000ms、子清单 4000ms、每键一个进行中请求、最多 8 条、失败即删）。
- 当前播放不受影响：推测性预取等播放超过 1 秒、再等一次空闲；弱网、省流量、页面隐藏时跳过。子清单约 2×43KB。
- 选集网格滚动时按下也会触发预取：同一集只会请求一次，浪费有上限（每次误触 1 次 /play + 约 86KB）。按下到点击约 100ms，收益有限，主要靠子清单提前开始。
- 回滚：前端 revert 即可；后端 delivery 字段是可选的，旧客户端不受影响。

## 成本

- /play 调用：每看一集或一部最多多 1 次（推测性预取没用上时浪费）。后端只读：读库、本地签名、读主清单缓存。#932 之后 /play 量已是之前的 5.1 倍，后端耗时没有变化。
- 流量：每次推测性预取约 86KB 子清单。

## 发布顺序

1. PR1：shared 枚举 + 后端 delivery，随 Railway 部署。
2. PR2：前端。必须等 PR1 在 Railway 所有实例生效后才能合并，否则新来源会让整份诊断被 strict schema 拒掉。PR2 的 base 先指向 PR1 分支，合并前改回 main。
3. 停止条件：护栏任一项不通过，或命中样本出现起播错误 → 回滚 PR2。
