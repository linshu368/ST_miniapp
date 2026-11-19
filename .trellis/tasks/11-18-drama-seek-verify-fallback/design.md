# 设计

## 方案

只改 `packages/frontend/src/lib/perf/drama-seek.ts`。

1. 新增模块级小函数 `createProgressFallback(target)`，返回 `{ observe(currentTime): boolean }`。它记录第一次越过目标的 currentTime；之后再次出现 currentTime 继续前进（> 首次值 + 0.05s）时返回 true。函数是纯逻辑，不碰 video，也不碰计时。
2. `onEvent` 的 timeupdate 分支（现有的 `seekedMs !== undefined && !seeking && !paused && readyState >= 2` 条件内）：`frameSupported` 为 true 且 `frameMs === undefined` 时调用 `fallback.observe(video.currentTime)`；返回 true 就写 `frameMs ??= elapsed()`、`frameMethod = 'playing_and_timeupdate'`，再走现有的 `maybeFinish()`。
3. 不支持帧回调的现有路径、帧回调路径、各终态处理都不变。

## 为什么是「两次前进」

帧回调正常的设备上，恢复播放后的第一帧回调在一帧时间（16–33ms）内就到，早于下一次 timeupdate（约 250ms），所以兜底不会抢在精确方法之前。只有在合格帧确实没出现时才触发兜底，这时判定会比真实恢复晚约一个 timeupdate 周期，口径偏保守，不会虚报达标。

## 不让 observeDramaSeek 变长

基线 324 行，规则要求不能继续往里加。本次把 `buildReport`（约 55 行，只依赖闭包里的状态）抽成模块级函数 `buildSeekReport(state, phase, outcome, network)`，闭包里只留调用。抽出的行数多于新增的行数，函数净变短；完成后运行 `node scripts/complexity-budget.mjs update` 收紧基线。完整拆到 120 行以内不在本次范围（见 implement 的待拍板项）。

## 复用调研

- `perf/drama-media.ts` 起播的 `onTimeUpdate`：同样是 timeupdate 兜底，但它在 `useFrameCallback` 为 true 时完全不用 timeupdate。起播没有 mediaTime 条件，不受影响，所以不改它，也不强行共用（两处的判定条件不同）。
- `drama-observer.ts mirrorSeekTiming`：`first_frame_method` 和 `frame_processing_status=unsupported` 已经能在 Faro 上区分兜底命中，不需要新字段。
- shared `DramaTimingReport.frameMethod` 的枚举已含 `playing_and_timeupdate`，契约不变。

## 可靠性

- 不新增请求、计时器或监听；兜底只在已有的 timeupdate 回调里多做一次比较。
- 失败模型：设备的 timeupdate 不前进 → 兜底不触发，结果等同现状；currentTime 回跳（再次 seeking）→ 现有逻辑会把 `resumed` 置 false，兜底状态随之重置（seeking 时重建 fallback）。
- 不适用：超时、重试、幂等、事务、限流、容量。

## 演进与回滚

纯前端，契约不变，可以单独发布。回滚就是 revert 这个提交。停止条件：上线后 Android 的兜底命中率 >2%，或者快进 `playing` 占比异常上升却找不到对应体验（说明兜底误判）。
