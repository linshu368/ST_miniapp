# 设计

## 方案

1. `lib/drama-hls-seek.ts` 新增 `createHlsSeekPlanner(hls, events, video)`，返回 `{ plan(target): number, stop() }`，和现有的 `restartStalledAudioOnSeek` 放在一起（都是 hls.js 快进的介入，升级 hls.js 时一起复查）：
   - `video.buffered` 已覆盖目标 → 原值返回，不介入。
   - 取当前档位（`hls.currentLevel`，无效时用 `hls.loadLevel`）的 `details.fragments`，找到覆盖目标的分片 `f`；若 `target − f.start ≥ 0.8 × f.duration` 且存在下一片 `n`，并且 `n.start + 0.05 < video.duration` → 目标改为 `n.start + 0.05`。
   - 降档：`hls.autoLevelEnabled` 为真时，`bw = hls.bandwidthEstimate`。从 `maxAutoLevel` 往下找第一个已有 `details`、且 `bitrate × duration / bw ≤ 1.0s` 的档位；`bw` 无效或都不满足时用 `minAutoLevel`。只有在这个档位 < `hls.nextAutoLevel` 时，才设置 `hls.nextAutoLevel = 选出档位`。
   - **保持强制档位到该片入缓冲（实现中新增，本地复现驱动）**：hls.js 1.7.4 在分片“已下载、未入缓冲”时档位一变，会按旧缓冲末端把同一 sn 换高档重下（不规划时快进后也会出现）。弱网下 ABR 估算仍偏高，这次重下让恢复后立刻卡顿（本地 8→1.5Mbps 骤降 3/3 次卡顿）。因此订阅 `FRAG_LOADED`：强制档位的主轨分片加载完时再设一次 `nextAutoLevel`；`FRAG_BUFFERED`（主轨）后解除。最多多影响一片；下一次 `plan` 或 `stop` 时清除。
   - 整个 `plan` 包在 try/catch 里，异常时返回原 `target`。
2. `lib/hls-media-source.ts`（#925 把 hls.js 装载从 drama-media-source 抽到这里，供图片广场复用）：照 `restartSeekAudio` 新增 `planSeeks` 开关；开启时创建规划器，登记到模块级 `seekPlanners` WeakMap，`destroy` 时 `stop()` 并删除；导出 `prepareHlsSeek`。`drama-media-source.ts` 打开 `planSeeks`，并像 `ownsDramaSource` 一样转出为 `prepareDramaSeek`。原生路径与图片广场不登记，原值返回。
3. 两个提交点在 `onBeforeCommit` 之前调用 `prepareDramaSeek`，后续的 `onBeforeCommit`、`currentTime` 赋值、`onCommit` 都用返回值：
   - `components/drama/use-drama-scrub.ts` 的 `finishScrub`；
   - `components/drama/drama-progress.tsx` 的 `commitKeyboard`。

## 为什么这样做

- 吸附点放在提交之前，而不是 `seeking` 事件里再改一次 `currentTime`：避免二次 seeking（会和 `restartStalledAudioOnSeek` 交错），观察器的 `target`、进度保存和 UI 也保持一致。
- 用 `nextAutoLevel` 而不是 `nextLoadLevel` 或 `currentLevel`：只强制一个分片，加载成功后 ABR 自动清除强制值，不会把手动档位模式留在播放器上。
- 只挑已有 `details` 的档位：避免为了降档多一次子清单请求（Stream 子清单首字节约 270ms）。
- 预算 1.0s 的依据：慢样本的首字节 P50 约 1.3s，加上 1.0s 下载和约 0.3s 尾段，大约 2.6s，留在 3s 内。好网络（10 Mbps）下会从 1080p 降到 720p 一个分片（4s），之后由 ABR 回升。
- 用 WeakMap 登记，而不是从 `drama-player.tsx` 传 prop：沿用 `owners` 的现有模式，不往复杂度超标的 `DramaPlayer` 里加代码。

## 复用调研

- `drama-media-source.ts` 的 `owners` WeakMap 和 `ownsDramaSource`：复用同一种「按 video 登记播放器状态」的模式。
- `drama-hls-seek.ts` 的 `isBuffered`、`covers`：直接复用。
- `drama-player.tsx` 的 `hlsHandleRef`：只用于诊断，不改。
- hls.js 公开 API：`levels[i].details.fragments`、`bandwidthEstimate`、`autoLevelEnabled`、`nextAutoLevel`、`minAutoLevel`/`maxAutoLevel`（1.7.4 均为公开 getter/setter）。

## 可靠性

- 不新增请求、计时器或监听；吸附还会减少一个分片请求。
- 并发：连续提交时，每次都按当时的缓冲和档位重新计算；强制档位会被下一次提交覆盖，或在分片加载后清除。
- 降级：hls.js 内部状态缺失（无 details、levels 为空）或抛错 → 原值，不介入。
- 和 `restartStalledAudioOnSeek` 的关系：它在 `seeking` 时 `stopLoad/startLoad`，不会重置 ABR 的强制档位（本地 Playwright 验证）；吸附后它看到的 `currentTime` 已经是新目标。
- 不适用：幂等、事务、限流、容量。

## 拒绝的做法

- 一律降到最低档：好网络下快进后 4s 画质掉到 240p，体验代价大于收益。
- 更短的分片、拖动时预取目标分片：收益覆盖弱网首字节，但要改转码或新增请求，复杂度明显更高，不在本次范围。
- 修改 hls.js 的 ABR 参数（`abrBandWidthFactor` 等）：影响全部播放，不只是快进。

## 演进与回滚

纯前端，契约不变。发布顺序：verify-fallback 先上，本任务后上，基线是两者之间的版本。回滚就是 revert 这个提交。停止条件：快进 `error`/`switched` 占比上升，出现无声或卡死反馈，或者卡顿占比劣化。

## 本地验证结果（2026-11-18，scratchpad 合成片源：4 档 0.36/0.69/1.36/2.79Mbps + 独立音频、4s fMP4，服务端分片首字节 300ms，CDP 限速，Android UA，真实 hls.js 1.7.4 与本模块打包）

| 场景                                               | 不规划     | 规划  | 恢复后卡顿                         |
| -------------------------------------------------- | ---------- | ----- | ---------------------------------- |
| 8Mbps 播 14s 后快进到分片末尾 95.4s                | 2.04–2.06s | 0.66s | 0 / 0                              |
| 8Mbps 播 14s 后骤降 1.5Mbps，快进到分片中段 101.0s | 3.38–3.40s | 1.74s | 0 / 0（未保持强制档位时 3/3 卡顿） |
