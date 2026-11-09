# 技术设计

## 1. 范围与现状证据

链路：`DramaPlayer` 挂载 → `loadDramaSource` 选择原生/hls.js → `onLoadedMetadata` 设置续播 `currentTime`。现状：`new Hls()` 未设 `startPosition`，先拉 sn0 估带宽再在 `onLoadedMetadata` 里 seek，hls.js 清空已加载内容重拉目标分片，且 ABR 已据 sn0 升档；`preloadDramaHls()` 在 `drama-home`/详情页挂载的 `useEffect` 里同步调用，和播放器首次 `import('hls.js')` 抢带宽。详见 `prd.md` 的生产数据。

## 2. 复用调研

- 续播状态机：复用 `drama-player.tsx` 已有的 `resume` / `resumePending` / `resumeExactPosition` ref 三元组，不新增状态字段，只在其基础上多算一次目标秒数。
- hls.js 接入点：复用 `drama-media-source.ts` 的 `loadDramaSource`，只加一个可选参数，不改变其 native/hls.js 分支判断、`onHls` 诊断回调签名。
- 预加载调度：复用 `navigation-quiet-window.ts` 已导出的 `afterNavigationQuietWindow()`（内部已有 raf+raf+idle 释放逻辑），不新建调度器；非 Android 或非五入口导航时该 Promise 立即 resolve，等价于现状（不劣化）。
- 诊断：复用现有 `drama.startup_diagnostic`（`hls.entries[].sn`）和 `media.events[].state.currentTimeMs`，发布后用于核实对齐效果，不新增埋点字段。
- 已检索但不扩展：`capAppleHlsQuality`、Apple 原生分支判断、`Hls` loader 配置、`packages/shared` 播放契约——均属第 2/3 批范围，本任务只读不改。

## 3. 最小实现

1. 在 `drama-media-source.ts` 新增两个纯函数（不依赖 React/DOM，可单测）：
   - `alignResumeSeconds(seconds, format)`：`format !== 'hls'` 或 `seconds <= 0` 原样返回；否则 `Math.floor(seconds / STREAM_HLS_FRAGMENT_SECONDS) * STREAM_HLS_FRAGMENT_SECONDS`。`STREAM_HLS_FRAGMENT_SECONDS = 4` 作为具名常量，注释写明依据（Stream 视频分片固定 4.000s）。
   - `resolveResumeTarget({ seconds, duration, exact, format })`：先复用现有"接近片尾从头播"判断（`!exact && seconds >= duration - 0.5` → 0），否则 `clamp(seconds, duration)`，`exact` 为真时原样返回，为假时再过 `alignResumeSeconds`。
   - `loadDramaSource` 签名追加第 6 个可选参数 `options?: { startPosition?: number }`，`new Hls({ ..., startPosition: options?.startPosition ?? -1 })`（`-1` 是 hls.js 的"自动"默认值，不传时行为不变）。
2. 在 `drama-player.tsx` 的媒体加载 `effect`（约 489 行）里，紧接现有 checkpoint 分支之后、调用 `loadDramaSource` 之前：
   - 读 `resumePending.current`、`resume.current`、`resumeExactPosition.current`，若命中且 `resume.current.videoId === playback.video_id`，用 `exact ? seconds : alignResumeSeconds(seconds, playback.format)` 算出 `startPosition`；否则 `undefined`。
   - 存入一个新 ref（如 `appliedStartPositionRef`），供 `onLoadedMetadata` 判断是否需要跳过重复 seek。
   - 把 `{ startPosition }` 作为第 6 个参数传给 `loadDramaSource`。
3. `onLoadedMetadata`（约 1059 行）里，`target` 改用 `resolveResumeTarget({ seconds: progress.seconds, duration: video.duration, exact: resumeExactPosition.current, format: playback?.format })` 统一计算；仅当 `hlsHandleRef.current !== null`（说明走的是 hls.js 而非原生）且 `appliedStartPositionRef.current === target` 时跳过 `video.currentTime = target` 赋值，`setTime(target)` 始终执行以同步 UI 状态。
4. `preloadDramaHls()` 的两处调用（`drama-home.tsx:18`、`dramas/[id]/page.tsx:27`）改为：
   ```ts
   useEffect(() => {
     let cancelled = false;
     void afterNavigationQuietWindow().then(() => {
       if (!cancelled) preloadDramaHls();
     });
     return () => {
       cancelled = true;
     };
   }, []);
   ```
   两处结构相同、各 5 行，不额外抽公共 hook（收益小于引入的间接层）。

## 4. 可靠性设计

- 超时/重试：不涉及网络请求超时逻辑，`startPosition` 是本地计算值，无需超时兜底；hls.js 对越界 `startPosition`（如对齐值超过实际时长）会按其内部逻辑钳制，不会抛错中断播放（现有 `ERROR` 监听已覆盖 fatal 错误兜底）。
- 幂等/并发：`appliedStartPositionRef` 和其他续播 ref 一样按本次挂载的 effect 生命周期赋值，cleanup 时不清零也不影响下一次 effect 重新计算（下一次会先于使用前重新赋值）。
- 降级：`alignResumeSeconds`/`resolveResumeTarget` 对非 hls、秒数非正、`duration` 非 finite 等输入直接原样返回/走已有分支，没有新的失败态。
- 可观测性：不新增埋点，复用现有 `drama.startup_diagnostic` 做发布后验证（见 prd.md）。

## 5. 演进与恢复

- 兼容：`loadDramaSource` 新增参数为可选且在末尾，不破坏现有调用方（测试文件里省略该参数时行为与之前一致）。
- 发布顺序：本任务是三批合入中的第 1 批（1→2→3），基于 `origin/main`（`b9923f3c`，#709 已上线）。不依赖第 2、3 批的改动即可独立合入验证。
- 停止条件：发布后若续播样本"元数据→数据"均值未下降、或 hls 分片 sn 与目标分片不一致、或卡顿/错误率上升，回退本次改动（只影响前端，Frontend 单独发布即可回滚）。
- 回滚：三处改动（`drama-media-source.ts`、`drama-player.tsx`、两个预加载调用点）互相独立，可单独回退任意一处而不影响其余两处。

## 6. 可验证性

- 单测（新增，落在已有测试文件 `drama-media-source.test.ts`）：
  - `alignResumeSeconds`：hls 且非 4 的整数倍 → 向下取整到边界；hls 且恰好是边界值 → 不变；hls 且 `seconds=0` → 0；`format='mp4'`/`undefined` → 原样返回。
  - `resolveResumeTarget`：接近片尾（`seconds >= duration - 0.5`）且非 exact → 0；exact 路径不对齐；hls 非 exact 路径对齐且不超过 `duration`。
  - `loadDramaSource` 传入 `options.startPosition` 时，mock 的 `Hls` 构造参数里包含该值；不传时沿用现有默认行为（新增一条 assert 到现有 mock 用例或新增一条用例）。
- 人工回归：复用 `packages/ui-tests` 现有短剧场景确认播放/续播/切集/重试基本功能不回归（mock 媒体无法验证真实 HLS 分片边界，只能验证交互不崩）；真实分片对齐效果只能在生产 Stream CDN 上验证，见下方"发布后验证"。
- 命令：
  ```bash
  pnpm --filter @miniapp/frontend exec vitest run src/lib/drama-media-source.test.ts
  pnpm --filter @miniapp/frontend typecheck
  pnpm --filter @miniapp/frontend test
  pnpm --filter @miniapp/frontend lint
  pnpm lint:complexity
  git diff --check
  ```
- 发布后验证：按 prd.md「发布后验证方法」，用 Grafana Loki 查询 `drama.startup_diagnostic`（`delivery.group=stream`、`entry=direct`、`outcome=playing`），对比新版本续播样本的 `metadata_to_data`、首片 `hls.entries[0].sn` 是否等于目标分片、会话首播 `source_set`→`manifest.startMs`。
