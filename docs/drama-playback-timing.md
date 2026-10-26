# 短剧播放耗时排查

本轮只增加观测，不改变超时、重试、预取、签名有效期、媒体加载或自动播放策略；无新环境变量、数据库对象、迁移或遥测 HTTP 接口。复用已配置的 Sentry Metrics/Logs/事件与 Railway Pino。

## 起止与口径

- 列表：站内普通点击短剧入口起计；直接打开列表从文档导航的 `performance.now() = 0` 起计；浏览器历史等没有点击入口的情况，从查询开始或页面提交起计。`list_start_kind` 明确区分，不混作同一基线。
- 列表可用：列表数据对应的 DOM 已提交，包含有缓存直接展示、空目录；不等待所有懒加载封面。选中封面独立记录 `cover_outcome/cover_load_ms`，缺少 Resource Timing 条目时不编造耗时。
- 首次播放：点击封面起计，`entry=cover`。列表就绪耗时、用户浏览时间 `browse_ms` 与点击后的播放等待分开；`since_list_entry_ms` 才是包含浏览时间的全程。
- 换剧：有效手势/按钮经防抖并确定目标后、发起路由切换前起计，`entry=switch`。换集及自动续集为 `episode`，不把自动续集的三秒倒计时算成加载；重新播放为 `retry`。没有入口记录的播放页为 `direct`，从播放器初始化观察开始计，不等同完整文档导航。
- 成功：同时观察到 `playing` 与本次资源的首帧。优先 `requestVideoFrameCallback`（帧提交合成器，存在帧级调度误差），兼容降级为 `playing` 后 `currentTime > 0` 的 `timeupdate`，并记录 `frame_method`。`canplay/loadedmetadata/play()` Promise 成功均不单独当作成功。
- 自动播放被拒绝是独立终态 `autoplay_blocked`，不能归为慢网或成功；本轮只观测该次自动播放尝试，之后用户手动恢复不再覆盖它的结果。
- 等待超过 10 秒发一次 `phase=slow` 快照，继续等待；成功、错误、不可播、切换、离开或进入后台产生一次 `phase=final`。阈值不是业务超时，不会中断视频。后台关闭本次观测，恢复前台不把后台时长补进成功耗时。

所有前端时间来自同页单调时钟；后端独立计时，以请求 ID 关联，禁止前后端时间戳相减。

## 查一条慢播放

1. 在 Sentry 按目标 **environment/release/service=frontend** 查 `perf_event=drama_timing` 的事件，或在 Logs 中用 `event_name=drama.timing` 找目标时间的记录。先区分 `type=list|playback`、`entry`、`outcome`、`phase`。正常的快速离开/切换只产生 Logs/Metrics，不创建 warning issue。
2. 从 `observation_id` 找到相同 ID 的 `drama.query_timing` 与 `drama.request_timing` Logs。`list_id` 可继续关联点击前的列表记录。成功的快速样本也有这些日志，不依赖 20% 的 trace 采样。具体送达仍依赖目标环境 Sentry DSN、SDK、网络与额度，未配置时不能用“没有记录”推断成功。
3. 先看总耗时 `elapsed_ms`：它由起止直接相减得到。`navigation_ms` 与 `address_wait_ms` **可以并行，不能相加**；详情与换剧队列也只是并行支线。
4. 如果 `address_wait_ms` 大：看查询 `startMs/durationMs/outcome` 及每次尝试的 `queueMs/headersMs/bodyMs/totalMs`。查询多条意味着包括 React Query 重试/重新拉取；同一查询的多次 HTTP 尝试是 API 传输层重试。两次尝试之间的时间空档是重试退避或调度等待，不会被塞进上一次请求耗时。
5. 从尝试的 `requestId`（概览也有 `request_ids`）去 Railway 查 `event=drama.request_timing` 且 `request_id` 相同的 Pino 记录，比较 `auth_ms/db_read_ms/assemble_ms/sign_ms/total_ms` 与 `sign_cache`。`db_read_ms` 包含后端到 PostgREST 的网络等待和 repository 整理，不是纯 SQL 执行时间。`sign_cache=hit|miss|inflight` 是进程内签名缓存，不能当成视频 CDN 命中率。
6. 如果 `address_to_source_ms` 大：检查前端挂载/调度。地址可用节点使用 API 实际结束时刻（旧缓存则为本次入口时刻），不会把 React 延迟交付误算成接口等待。若 `source_to_metadata_ms/source_to_frame_ms/source_to_playing_ms` 大：耗时主要在媒体加载、准备和播放启动阶段，再决定是否做网络首字节/下载/解码细分。

慢事件中的 `drama_marks` 是相对本次播放起点的节点偏移；`drama_query_<n>` 与 `drama_request_<n>_<m>` 是扁平 context，避免 SDK 深度归一化截断嵌套对象。`first_frame` 是首帧提交时刻，成功总耗时取首帧与实际播放两个条件都成立的时刻。

请求字段 `headersMs` 是派发到拿到响应头，包含网络/CORS/后端等待；`bodyMs` 是响应头到响应体读取、解析与契约检查结束。它们都不是视频媒体下载时间。`pending` 表示生成快照时该支线尚未结束，不表示已经超时。复用页面进入前已在途的请求时，`startMs` 可以为负；命中旧缓存的原请求不纳入本次等待。

每次最多保留 12 次查询、每次查询最多 4 次 HTTP 尝试；达到上限会显式标记 `query_details_truncated/attemptsTruncated`，不能把截断明细当完整链路。高基数标识只在日志/事件，Metrics 使用固定分类。媒体地址、签名、对象路径和正文不进入这些数据。

## 聚合查看

- `drama.startup.duration`：按 `type=playback`、`outcome=playing` 过滤后看成功启动 p50/p95；列表用 `type=list/outcome=ready`。失败、离开与后台应独立查看，不能混入成功启动分位数。
- `drama.stage.duration`：按 `stage` 查看主要区间；仍需遵守并行区间不相加。
- `drama.server.duration`、`drama.server.stage.duration`：按路由、结果、签名缓存和阶段判断后端大头。

## 验证与发布

自动回归覆盖：预取与路由重叠、旧缓存/在途复用、20 秒传输重试叠加 React Query 重试、响应体解析、排队取消、十秒快照不被迟到结果改写、快速换剧旧组件/帧回调失效、自动播放拒绝、旧 WebView 降级、失败/后台终态、重试保留旧不可播数据、日志脱敏和指标维度。

可重复的真机验收（分别记录 TEST/Production 环境和 release）：

1. Telegram 打开列表，停留几秒，点击封面等到播放；核对列表、浏览、播放三个区间，校验实际等待与 `elapsed_ms` 接近。
2. 连续切换至少三部；确认每次 `observation_id` 不同，旧记录为 `switched`，迟到请求/帧不会记到新视频。
3. 重进同一部观察缓存复用；区分 `cache/inflight/fetch`，不能把旧请求耗时重新算一遍。
4. 限速或阻断 API，观察请求队列/重试/超时与 10 秒快照；随后恢复，核对最终结果仍属于同一条记录。
5. 限速媒体、允许 API 正常返回；应看到地址阶段短，媒体阶段长。触发自动播放限制时应记录 `autoplay_blocked`。
6. 加载中离开/切后台、失败后重新播放、从历史返回列表/同一播放页；确认终态不重复，新的主动尝试重新起计。

推荐先 Backend 后 Frontend 部署到同一测试环境，再真机验收。HTTP 契约未改，部分部署保持兼容，但旧 Backend 不会有内部阶段日志；测试结论不能代替 Production。回滚对应应用版本即可，无数据恢复步骤。当前本地单测不等于已完成 Telegram/生产实测。
