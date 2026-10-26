# 短剧播放耗时排查

短剧耗时直接记录到日志：浏览器使用现有 `createLogger`，前端报告经鉴权发送到 `POST /api/telemetry/drama-timing`，Backend 用现有 Pino 写入 Railway。短剧专用 Sentry Logs、Metrics 和 warning 事件已移除；其他业务和通用 HTTP/异常监控保持原有行为。

计时不改变播放超时、重试、预取、签名有效期、媒体加载或自动播放策略。无需新环境变量、数据库对象或迁移。

## 起止与口径

- 列表：站内点击短剧入口起计；直接打开 `/dramas` 从文档导航的 `performance.now() = 0` 起计；其他情况下从查询开始或页面提交起计。按 `list_start_kind` 区分。从 `/` 自动分流到短剧时，不能假定已覆盖完整文档导航。
- 列表可用：列表数据对应的 DOM 已提交，包括缓存展示、空目录；不等待所有懒加载封面。选中封面独立记录 `cover_outcome/cover_load_ms`，缺少 Resource Timing 条目则不填耗时。
- 首次播放：点击封面起计，`entry=cover`。列表就绪、用户浏览 `browse_ms`、点击后的等待分别记录；`since_list_entry_ms` 包含浏览时间，不能当作播放加载耗时。
- 换剧：有效手势/按钮经防抖并确定目标后、路由切换前起计，`entry=switch`。换集/自动续集为 `episode`，不包含三秒倒计时；重播为 `retry`。缺少入口记录的播放页为 `direct`，只从播放器初始化观察开始计。
- 成功：同时有当前资源的 `playing` 和首帧。优先 `requestVideoFrameCallback`；旧 WebView 降级为 `playing` 后 `currentTime > 0` 的 `timeupdate`，并记录 `frame_method`。`canplay/loadedmetadata/play()` Promise 成功不能单独判为成功。
- 自动播放被拒绝是终态 `autoplay_blocked`，之后手动恢复不覆盖该次自动播放结果。
- 等待十秒发一次 `phase=slow` 快照并继续等待；成功、错误、不可播、切换、离开或后台产生一次 `phase=final`。十秒是观测阈值，不中断播放。后台结束本次观测，恢复不补算后台时长。

前端使用同页单调时钟，后端独立计时，用原请求 ID 关联，禁止前后端时间戳相减。首帧成功后结束启动观测，目前不统计播放中卡顿次数或时长。

## Railway 查询一条链路

1. 先选对环境和部署。找到 `event=drama.frontend_timing`、`source=frontend`，按操作时间、`type=list|playback`、`entry`、`phase` 和 `outcome` 确认样本。
2. 按 `observation_id` 关联同次慢快照和最终结果；`list_id` 关联列表。`elapsed_ms` 是起止直接相减的总耗时。
3. 查 `navigation_ms`、`address_wait_ms`、`address_to_source_ms`、`source_to_metadata_ms`、`metadata_to_frame_ms`、`source_to_frame_ms`、`source_to_playing_ms`。预取与路由并行，`navigation_ms` 和 `address_wait_ms` 不可相加；详情和换剧队列是并行支线。
4. 地址阶段慢时，读取同条日志的 `queries`：每次查询有 `startMs/durationMs/outcome`，每次 HTTP 尝试有 `requestId/startMs/queueMs/headersMs/bodyMs/totalMs/status/outcome`。查询重试与 HTTP 重试分层记录，尝试间空档为退避或调度，不塞进上一次请求。
5. 用 `request_ids` 或尝试的 `requestId` 找 `event=drama.request_timing`、`source=backend`、`request_id` 相同的后端记录，比较 `auth_ms/db_read_ms/assemble_ms/sign_ms/total_ms`。报告接收请求另有 `upload_request_id`，不能当作播放接口 ID。
6. `db_read_ms` 包括 Backend 到 PostgREST 的网络往返和 repository 整理，不是纯 SQL 时间；`sign_cache=hit|miss|inflight` 是进程内签名缓存，不是视频 CDN 命中率。
7. `address_to_source_ms` 大时检查前端调度；`source_to_metadata_ms/source_to_frame_ms/source_to_playing_ms` 大时定位到媒体加载、准备和启动阶段，尚不能直接区分媒体首字节、下载和解码。

`headersMs` 包含 API 网络、CORS 和后端等待；`bodyMs` 包含 API body 读取、JSON 解析和 envelope 检查，均非视频下载时间。旧缓存历史请求不重复计算；进入前已在途的请求允许负 `startMs`。`pending` 只表示快照时支线未结束，不表示超时。

## 上报可靠性与容量

- 浏览器先写同口径日志，再异步发送；失败记录 `drama.timing_upload_failed`，不改变播放结果。复用 API client 的 Telegram 鉴权，POST 不重试，低优先级并发槽与 `keepalive`；总预算五秒，包括排队和响应体。
- `keepalive` 尽力支持离开/后台时发送，不保证强制关闭、离线或鉴权过期时送达。无本地持久化、离线补传或远程送达保证；缺报不能推断成功。浏览器日志不自动进入 Vercel 日志。
- 接收端只允许共享 schema 中的有限枚举、数值、关联 ID 和计时结构，未知字段拒绝；不接收媒体地址、签名、对象路径、请求/响应正文或原始错误。
- 单次 body 上限 32 KiB，最多十二次查询、每次四次 HTTP 尝试，明细截断显式标记。鉴权用户每进程每分钟最多 120 次上报，全进程每分钟最多 1000 次；用户限流表最多 2000 项。超限返回 429，无数据库写入和新依赖。这是进程诊断容量保护，多副本配额独立。
- 成功调用日志输出后返回 `{ accepted: true }`；输出抛错返回 503，不伪造接收成功。该确认不等于 Railway 日志永久落盘。
- `source=frontend` 属于客户端自报，不作为计费、权限或安全事实；进程日志时间是接收时间。

## 验证与发布

先部署 Backend，再部署 Frontend 到同一环境；旧 Backend 没有接收接口，上传会失败但视频不受影响。回滚应用版本即可，无数据恢复步骤。

自动回归覆盖：现有计时/媒体状态机、预取与缓存、迟到结果隔离、慢快照/终态、失败不阻塞播放、POST 参数/超时、鉴权、未知/嵌套敏感字段拒绝、body/明细数量上限、限流窗口、日志输出失败及 Backend 失败路径。跨包执行 shared tests、所有消费者 typecheck 和适用 build/lint。

真机验收需分别记录 TEST/Production 环境和 release：

1. Telegram 打开列表，停留后点击封面等到播放；在 Railway 查到列表/播放报告，确认浏览时间与播放等待分开。
2. 连续换剧、换集和重播；各次 `observation_id` 独立，旧观察不污染新资源，`request_ids` 可关联 Backend。
3. 重进同剧，区分 cache/inflight/fetch；分别限速 API 和媒体，验证地址阶段与媒体阶段可区分。
4. 十秒慢快照和最终结果属于同一观察；自动播放限制记录 `autoplay_blocked`。
5. 离开/后台/失败时核对终态；阻断接收接口，浏览器有上传失败诊断，播放不受影响，不把缺报算成成功。

本地测试通过不等于已完成 Telegram/线上送达验收。
