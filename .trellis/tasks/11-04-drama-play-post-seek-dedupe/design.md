# 设计

## 复用调研

- 后端：`routes/drama.ts` 的 `/play` 处理（`measure`/`timings`/`signedUrls`/`DramaSignedUrlCache`/`selectDramaDelivery`/`selectStreamDelivery`）全部复用，只搬位置；`DramaPlaybackOptionsSchema`、`ok/fail`、`observeDramaRequest`、pino `drama.request_timing` 不变；CORS 在 `app.ts` 已有 `maxAge: 7200`，POST/Content-Type 已允许，无需改。
- 前端：`dramaTiming.beginPlayback`/`query`（pending query 会按 dramaId+videoId 自动挂到当前播放观察）、`apiClient`（已支持 POST、`queuePriority`、`timeoutMs`）、`usePrefetchDramaPlayback`（封面点击已调用）。不新增状态库、不新增请求层。
- 拒绝：把意图请求写进 React Query 缓存（需要放开 `gcTime: 0`，并与“每次意图重新取址”规则冲突）；改动 `drama-player.tsx`/`dramas/page.tsx`。

## 后端

- 契约先行：`packages/shared/src/api/drama.ts` 新增 `DramaPlayRequestSchema`（strict；`drama_id` 字符串、`video_id` uuid 可选、`format: 'hls'`、`fallback: 'mp4'` 可选）。`format/fallback` 必须带上，否则前端切 POST 后 Stream 能力声明丢失；响应沿用 `GetDramaPlaybackData`。
- `dramaRoutes` 已 179 行（基线）：把 `/play` 处理与计时类型抽到 `routes/drama-play.ts`，导出 `createDramaPlayHandler(deps)`，输入统一成 `{ dramaId, options }`；GET 与 POST 各自只做参数解析后调用它。保留 `@frontend-ready` 注释、`Cache-Control: private, no-store`、计时 hook、pino 日志。
- 指标多出 `route=/api/dramas/play`，看板按 route 分组，无需改。

## 前端

- `lib/api/drama.ts`：
  - `fetchDramaPlayback` 改 POST；
  - 新增模块级意图表 `Map<"id:videoId", {promise, at}>`；`startDramaPlayIntent(id, videoId)` 先建请求（经 `dramaTiming.query`）再入表，顺便清理过期项；`useDramaPlaybackQuery` 的 queryFn 在非 fallback 时取走同键且 ≤10s 的 promise（只用一次，取走即删），取不到就新建；
  - `usePrefetchDramaPlayback` 在封面点击时调用 `startDramaPlayIntent`。
  - 意图 promise 不进 React Query 缓存，因此无需改 `gcTime`；请求早于播放器返回时结果留在 promise 里，不会被回收。
- `dramas/[id]/page.tsx` `navigate`：`beginPlayback` 之后 `startDramaPlayIntent`。`videoId` 与播放器首次请求一致（取目标剧本机进度中未完成的 videoId），同时传给 `beginPlayback`，否则 pending query 与观察的 `requestedVideoId` 对不上。
- 调用顺序：必须先 `beginPlayback` 再发请求，这次请求才会挂到本次观察。
- `address_source`：按现有 `addressReady` 规则，beginPlayback 之后发起的请求记为 `fetch`（`inflight` 仅出现在请求早于 beginPlayback 时）。看板若依赖 `inflight`，需口径确认（见 implement 的待核验项）。

## Android 快进

- `DramaProgress` 233 行（基线）：先把拖动会话（session / pendingResume / preview / finish / cancelResume / 全局监听 / 指针事件）抽成 `use-drama-scrub.ts`，组件只剩渲染与键盘。
- 修复：`finish` 提交后记录时间；`onChange` 路径在 500ms 内直接忽略。键盘走 `onKeyDown → commitKeyboard`，不受影响。
- 根因（`pointerup` 提交后原生 range 再触发 `onChange`，此时 `session` 已清空）是日志推断，真机日志确认。

## 可靠性

- 意图请求沿用 5s 超时、`critical` 优先级，不重试；失败时 query 报错，沿用现有“重试”入口（再次 queryFn 即新建请求）。未被接上的意图请求最多白发一次（修饰键点击、10s 内未进入播放器），后端 `no-store` 且签名有内存缓存，成本可忽略。
- 幂等：`/play` 只读、无副作用；POST 不引入新写入。
- 并发：意图只能被取走一次；同键重复点击后者覆盖前者。

## 发布与回滚

- 先发后端（GET 不变、POST 新增，对旧前端无影响），确认 POST 正常再发前端；回滚回退前端即可。
- 本任务应在 Stream AB 正式观察窗口前上线；Stream worktree 需 rebase，能力声明改到 POST body。
