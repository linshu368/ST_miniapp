# 设计

## 方案

新增 `packages/frontend/src/lib/drama-hls-seek.ts`，导出 `restartStalledAudioOnSeek(hls, events, video): () => void`，在 `loadDramaSource` 的 hls.js 分支里创建播放器后调用，cleanup 并入现有 `destroy`。

1. 订阅 `FRAG_LOADED`：`frag.type === 'audio'` 且为媒体分片（`sn` 为数字）时记入 `pending`（Set<Fragment>）。
2. 订阅 `FRAG_BUFFERED`：从 `pending` 删除该分片。
3. 在 `MEDIA_ATTACHED` 后给 video 挂 `seeking` 监听（保证排在 hls.js 自己的 `onMediaSeeking` 之后，复现脚本已验证此顺序）。触发时：
   - 目标 `currentTime` 落在 `video.buffered` 内 → 不处理；
   - `pending` 中存在不覆盖目标（`!(start <= t < start + duration)`）的分片 → 清空 `pending`，`hls.stopLoad()`，`hls.startLoad(t, true)`。
4. cleanup：移除 video 监听与 hls 事件订阅。所有回调 try/catch，不影响播放。

`startLoad` 第二个参数 `skipSeekToStartPosition=true`：只设定下一次加载位置，不再改写 `video.currentTime`。

## 为什么这样做

- 根因在 hls.js 内部（见 prd），1.7.4 为最新正式版、最新 canary 未改；不 fork、不 patch 依赖。
- `stopLoad/startLoad` 是公开 API，重置各 stream controller 的加载状态（含卡在 PARSED 的音频控制器），被挂起的旧音频片在 buffer-controller 队列中照常在视频入缓冲后释放（与现状相同，无新副作用）。
- 只在命中挂起条件时介入，正常快进路径零改动。

## 复用调研

- `perf/drama-hls.ts recordHlsLoads`：同样订阅 FRAG_LOADED/FRAG_BUFFERED，但它是诊断、只在观察窗口内存活且有条数上限；播放控制不应依赖诊断模块，故不复用，只复用同一事件模型。
- `drama-media-source.ts loadDramaSource`：唯一创建 hls.js 的位置，接入点。
- `drama-seek.ts`：被动观察，不改。
- `use-drama-scrub.ts`：提交 `currentTime`，不改；拖动期间多次 seeking 由 `pending` 清空保证同一挂起状态只重启一次。

## 可靠性

- 超时/重试：不新增请求；被中止的主轨请求由 hls.js 立即重发（复现中主轨请求时刻 1–3ms，无损失）。
- 并发：`seeking` 连发时第二次 `pending` 已空不重复重启。
- 降级：任何异常吞掉，等价于现状。
- 可观测：现有 `drama.seek_diagnostic` 的 hls 分片时间线足以验证（两路 startMs 差）。
- 不适用：幂等/事务/限流/容量（无写入、无新请求）。

## 拒绝的做法

- 触发 hls.js 内部事件（如 BUFFER_FLUSHING）解除阻塞：依赖内部语义，升级易坏。
- 每次快进都 stopLoad/startLoad：影响全部快进，收益只在 30% 样本。
- 限制音频领先（改 maxBufferLength 等）：hls.js 无针对单轨的配置，副作用大。

## 发布与回滚

纯前端，无契约变化，可单独发布。回滚 = revert 该提交。停止条件：上线后 hls.js 快进 not_resumed/error 比例上升或出现无声。
