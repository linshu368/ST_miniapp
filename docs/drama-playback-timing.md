# 短剧播放耗时排查

## 五秒长尾常态采集（2026-10-29，本地实现，待发布）

- 继续从每次原启动入口采集，不新增五秒定时快照。真实成功、失败、离开或后台的 `phase=final` 达到5000ms时，完整有界报告经后端已有OTLP出口写Cloud Loki，事件名 `drama.startup_diagnostic`；迟到 `phase=network` 复用同一观察ID补媒体证据，不生成第二次启动。
- 成功仍要求首帧且playing；elapsed保持实际值，不在五秒中断播放。原十秒slow报告仍兼容Pino，但不会另存这条Loki诊断流。
- 每条报告沿用strict shared白名单与32KiB上限，保留media/queries/marks/diagnostics；观察/视频/会话ID仅在JSON正文。iOS字段不可读仍标limited，不输出URL、token、路径、身份或任意正文。
- 路由停止Supabase分析写入，即使旧DRAMA_TIMING_PERSIST_ENABLED=true；原表/导入器/SQL看板保留历史，不重写、不删除。下文数据库落表/7天详情/14天摘要只描述历史SQL路径，不适用于新的Loki流；Loki保留期按实际Cloud配置，未在本轮修改。
- ENGINEERING_TELEMETRY_ENABLED与现有OTLP私网端点是新出口的前提；复用256条日志队列、2秒预算和既有drop/failure健康指标。202仅接口接收，关闭/限流/断网/强退仍可能缺报，无离线补传。
- 事后入口为现有st-engineering-drama新增的两个详情面板；原浏览器流选择器不影响它们，版本筛选读取报告里的客户端release。发布与查询见runbook。

短剧耗时直接记录到日志：浏览器使用现有 `createLogger`，前端报告经鉴权发送到 `POST /api/telemetry/drama-timing`，Backend 用现有 Pino 写入 Railway。短剧专用 Sentry Logs、Metrics 和 warning 事件已移除；其他业务和通用 HTTP/异常监控保持原有行为。

计时不改变播放超时、重试、预取、签名有效期、媒体加载或自动播放策略。默认保持日志模式；新增 v2 诊断与可选 Grafana 落表实现，需先执行对应环境的 `20261027_drama_playback_observability.sql`，再设置 `DRAMA_TIMING_PERSIST_ENABLED=true` 并重新部署 Backend。源文件存在不代表远端已经迁移或启用。发布、历史导入与真机验收见 [短剧看板操作说明](grafana/drama-playback-runbook.md)。

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

## 媒体启动详情

同一 `drama.frontend_timing` 报告增加可选 `media`，不增加 POST 次数，不改变播放策略。先按 `observation_id` 找慢快照与终态，再看：

- `marks.play_called/play_resolved/play_rejected/loadeddata/canplay`：与既有 metadata、playing、first_frame 一样，都是从本次播放入口起算的首次偏移毫秒。`loadeddata` 是当前位置画面数据可用，`canplay` 不代表已开始播放，更不代表首帧已显示。Promise 结果若在启动终态之后才到，不补报或改写终态。
- `media.events[]`：按发生顺序记录 `name/atMs/state`；包含 play 调用/结果、loadedmetadata/loadeddata/canplay/play/playing/first_frame、waiting/stalled/suspend/pause、user_play/user_pause/user_retry，以及 visibility_hidden/pagehide。`trigger=automatic|user` 区分原自动调用与用户调用；拒绝只保留 `error=not_allowed|aborted|not_supported|other`，不记录异常消息。
- `media.snapshot`：十秒慢快照和终态生成时的即时状态，不是上一事件的旧状态。包括 `readyState`（0 无信息、1 元数据、2 当前数据、3 后续数据、4 浏览器判断数据充足）、`networkState`（0 未初始化、1 空闲、2 加载中、3 无可用资源）、paused/muted/seeking、currentTimeMs、bufferedAheadMs 和 visibility。媒体已释放/切源或属性不可读时状态可能缺失，不能当成零。
- `bufferedAheadMs` 只算覆盖当前播放位置的连续已缓冲时长；不跨缓冲空洞，也不是下载字节数或下载速度。可读且没有覆盖区间时为 0，读取失败或非有限边界时缺失。
- 每次观察最多保留前 32 条媒体事件；`eventsTruncated=true` 表示后续事件被截断，不能按缺少事件推断它没有发生。首次关键 marks 与实时 snapshot 继续采集。慢报告固定当时数组和状态，终态后不继续累加事件。

排查顺序：metadata → loadeddata 的长等待说明当前画面数据尚未就绪；loadeddata/canplay → playing 的长等待需要结合缓冲、paused、用户操作和 play 拒绝判断。waiting/stalled/suspend 都是浏览器状态信号，尤其 suspend 可能是浏览器主动停止预加载，不能单独判为网络故障。缓冲充足但首帧迟到仍不足以直接证明解码慢。

后台沿用原有 `outcome=background` 并结束观察，可从生命周期事件与 visibility 辨识；恢复不重新累计本次启动。用户手动 play 的结果只补诊断，保持原有 UI/终态处理；自动播放拒绝后的手动恢复不覆盖已结束的 autoplay_blocked。首帧成功后不采集播放中操作或卡顿。

旧版报告没有媒体 Resource Timing/首字节。v2 被动读取当前源的可见资源条目，并明确区分 unsupported/no_entry/limited/available；跨域、WebView、在途请求等限制仍可能导致缺失。条目不提供原始 Range 区间/CDN 命中，不能自动证明某个两字节请求的原因；这些仍需真实网络或供应商证据。禁止把签名缓存或 API body 耗时当作媒体传输指标。

## v2 统计与能力边界

- 播放报告增加 `version=2/context`，含前端 release、随机页面会话、粗平台/浏览器大版本；不上传完整 UA、IP 或 Telegram 身份。Vercel 构建 SHA 自动注入 `NEXT_PUBLIC_DRAMA_RELEASE`，后端版本独立记录。
- 新增轻量 `phase=start`，在点击处理完成后的微任务中排队，继续使用 background 优先级；原 slow/final 保留，网络迟到最多补一次 `phase=network`，每次最多四次上报。不补报离线历史，不承诺完全未送达尝试的真实分母。
- `diagnostics.network.entries` 最多16条，以 src 精确匹配、代际与时间窗口隔离，URL 只留瞬时匹配内存。记录可见的相对请求边界、DNS/连接/TLS、TTFB 和浏览器字节字段；0/不可见字段不能直接证明缓存。final 不等待请求完成；尾观察最多5秒且不晚于设置源后60秒，后台/切源立即释放。`closed` 描述窗口关闭，不等同网络请求失败。
- 帧回调记录处理时长和送往合成器/预期显示时间，处理时长缺失保持缺失；不是“元数据到首帧的纯解码时间”。支持时只汇总长任务，最多128条内部区间，输出计数/总时长/最大值/元数据至首帧重叠时长；截断显式标记，不逐帧轮询。
- 首帧等待为 `first_frame` 偏移；启动完成为 `max(first_frame,playing)`，两者均到才成功。分析视图细分源→元数据、元数据→loadeddata、loadeddata→frame、frame→启动完成。缺失/逆序为 NULL，不能截为0。导航/预取并行，阶段P95不能相加。
- `miniapp_analytics.drama_playback_observations` 每环境/观察一行，数据库RPC原子合并乱序与重复；首个final不可被start/slow/冲突final改写。summary全量；慢/失败诊断全量、快速成功明细确定性5%。可见网络摘要和帧/长任务摘要也全量保存，避免明细采样影响分布。
- 摘要14天、详细数据7天；受限清理job初始关闭，验证容量后启用。仅service_role写，Grafana NOLOGIN reader只读，anon/authenticated无权限。无业务外键，播放API不读写此表。
- 持久化开启时写入成功后返回 `accepted:true,persisted:true`；DB短超时2秒、单进程最多2个在途写、过载429/故障503。默认日志模式保留旧 `accepted:true`。环境开关启动时读取，关闭后需重新部署；遥测请求独立于播放请求。
- Grafana 独立 UID `st-drama-playback`，只新增短剧看板，不修改经营/首token看板。默认24小时、5分钟刷新、最多读14天，复用现有只读数据源与连接上限。分位数附有效N，退出/后台/无终态单列，不把缺报算成功；旧日志标legacy且不能补回新字段。

## 上报可靠性与容量

- 浏览器先写同口径日志，再异步发送；失败记录 `drama.timing_upload_failed`，不改变播放结果。复用 API client 的 Telegram 鉴权，POST 不重试，低优先级并发槽与 `keepalive`；总预算五秒，包括排队和响应体。
- `keepalive` 尽力支持离开/后台时发送，不保证强制关闭、离线或鉴权过期时送达。无本地持久化、离线补传或远程送达保证；缺报不能推断成功。浏览器日志不自动进入 Vercel 日志。
- 接收端只允许共享 schema 中的有限枚举、数值、关联 ID 和计时结构，未知字段拒绝；不接收媒体地址、签名、对象路径、请求/响应正文或原始错误。
- 单次 body 上限 32 KiB，最多十二次查询、每次四次 HTTP 尝试，明细截断显式标记。鉴权用户每进程每分钟最多 120 次上报，全进程每分钟最多 1000 次；用户限流表最多 2000 项。超限返回 429，无数据库写入和新依赖。这是进程诊断容量保护，多副本配额独立。
- 媒体诊断复用上述大小/频率约束，media/state/event 全部 strict 白名单；旧报告不带 media 仍接受。旧 Backend 会拒绝新增字段，因此扩展 validator 的 Backend 必须先于新 Frontend 部署；不影响旧客户端视频播放。
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
6. 限速媒体，核对 loadeddata/canplay/play 结果和十秒 snapshot 的即时缓冲；启动时暂停/恢复、重试、换源及后台，核对用户事件与源代际隔离。检查上报 HTTP 200，若 400 先查 Backend 是否已部署扩展 media 契约。

本地测试通过不等于已完成 Telegram/线上送达验收。
