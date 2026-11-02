# 短剧播放耗时排查

短剧只有一个计时 owner：`lib/perf/drama-timing.ts`，媒体证据由 `drama-media.ts/drama-resources.ts` 提供。日常统计入口为 [工程短剧看板](https://ea3213527545.grafana.net/d/st-engineering-drama)，服务端分段在 [工程服务看板](https://ea3213527545.grafana.net/d/st-engineering-backend)。Faro/Loki 负责全量性能分布与结果；Pino 负责有界单次诊断；旧数据库看板保留历史与切换前对照。

## 五秒长尾常态采集（2026-10-29，本地实现，待发布）

- 继续从每次原启动入口采集，不新增五秒定时快照。真实成功、失败、离开或后台的 `phase=final` 达到5000ms时，完整有界报告经后端已有OTLP出口写Cloud Loki，事件名 `drama.startup_diagnostic`；迟到 `phase=network` 复用同一观察ID补媒体证据，不生成第二次启动。
- 成功仍要求首帧且playing；elapsed保持实际值，不在五秒中断播放。原十秒slow报告仍兼容Pino，但不会另存这条Loki诊断流。
- 每条报告沿用strict shared白名单与32KiB上限，保留media/queries/marks/diagnostics；观察/视频/会话ID仅在JSON正文。iOS字段不可读仍标limited，不输出URL、token、路径、身份或任意正文。
- 路由停止Supabase分析写入，即使旧DRAMA_TIMING_PERSIST_ENABLED=true；原表/导入器/SQL看板保留历史，不重写、不删除。下文数据库落表/7天详情/14天摘要只描述历史SQL路径，不适用于新的Loki流；Loki保留期按实际Cloud配置，未在本轮修改。
- ENGINEERING_TELEMETRY_ENABLED与现有OTLP私网端点是新出口的前提；复用256条日志队列、2秒预算和既有drop/failure健康指标。202仅接口接收，关闭/限流/断网/强退仍可能缺报，无离线补传。
- 事后入口为现有st-engineering-drama新增的两个详情面板；原浏览器流选择器不影响它们，版本筛选读取报告里的客户端release。发布与查询见runbook。

本次统一定义代码为 `drama_v3`，尚未发布/启用；报告结构仍为兼容的 `version=2`。这两个版本号含义不同，不用报告结构版本替代测量定义。新代码不新增数据库对象、依赖或监控 cron，不改媒体 src、播放/预取/重试/签名策略。

## 唯一计算定义与粒度

`packages/shared/src/api/drama-timing.ts` 的 `dramaTimingStages(marks)` 是新报告、Faro投影和服务端诊断的阶段计算入口；不在看板另算同一阶段。旧字段保留，补齐 `entry_to_source`、`metadata_to_data`、`data_to_frame`、`frame_to_startup`。前端 measurement 统一毫秒，后端 OTel histogram 为秒。

缺失节点不发该阶段，逆序不截成0；合法零耗时仍保留。`frame_to_startup=max(first_frame,playing)-first_frame`，两节点都存在才算。原 `elapsedMs` 总耗时仍为入口到原终态时刻。并行/重叠阶段不得相加，也不得相减两个P95。旧SQL看板只用于legacy对照和历史，迁移文件不改写。

首页 `/`、目录 `/dramas`、详情 `/dramas/:id` 在观察创建时绑定，迟到报告不根据当前地址猜路由。目录通过 `list_start_kind` 区分 document_navigation、navigation_click、route_commit、query_start、retry；播放通过入口、地址cache/fetch/inflight与首帧方式分层。后台终态在tracker中产生，日志与Faro使用同一个outcome。

## 上报模式与切换门禁

- 构建变量 `NEXT_PUBLIC_DRAMA_TIMING_MODE` 缺省/非unified为legacy：原报告仍全量上传旧接口，接收端不再触发数据库写入，便于对照上传行为。
- 显式unified且Faro公开配置有效时：全量started/terminal、耗时和诊断能力摘要走原Faro；旧接口不再上传start。慢观察（≥5秒）、所有非成功终态的有界细节保留100%，不足5秒的成功按observation ID确定性保留5%；slow/final/network沿同一观察决策，不建立额外持久状态。
- 采样后的报告标 `purpose=diagnostic`，写Pino，符合五秒播放final/network条件的报告另经Backend OTLP写Loki；接收端不再建立分析队列。repository和历史导入器再次阻止这类诊断写库，避免把采样明细误算全量。
- Faro关闭/配置非法时回到legacy；Faro网络失败不改变播放，不自动重发或回写数据库。日志上传仍是5秒总预算、background、keepalive、不重试；无离线补传或完整送达保证。
- `accepted:true`与202只代表接口接受，不能当作Cloud实收或数据库落盘；Pino抛错后仍调用独立Cloud出口。Pino正常返回也不证明平台永久保存。
- 所有浏览器遥测release在构建时统一采用实际Vercel SHA，非Vercel构建使用明确Grafana release/Sentry release；旧DRAMA release随同赋值。不得手动把旧版本标成新版本。

Backend须先兼容definition/route/purpose及新增stages，再发布Frontend，默认仍legacy。TEST/Cloud与真实媒体流程核对后才独立批准unified；接收端已停止分析写入，DRAMA_TIMING_PERSIST_ENABLED不再控制此接口。旧表、SQL视图、历史看板和清理job不在本次删除范围，不能未经保留期核对就关闭清理造成积压。回滚先把Frontend构建模式改回legacy，Backend保持兼容；数据库无需恢复。

## 工程看板与诊断分母

工程看板增加v3定义、页面、启动入口/缓存/首帧方式、目录起点筛选；启动筛选只作用于启动面板，不假装过滤缺少这些维度的播放质量窗口。日常成功率只用已知playing/error/unplayable/autoplay_blocked终态；switched/left/background单列，started/terminal窗口计数不是逐次配对覆盖率。Pino采样明细不得用于全量成功率。

新 `drama.diagnostic` event展示网络可见能力、长任务支持、截断及事件逆序；同名measurement展示first/max TTFB、max connect、首帧处理和metadata→frame主线程重叠。final快照与network尾报告分别展示，不能合成两次启动；各阶段有效N与其P50/P95一起看，缺失不填0。Faro不接收observation/request/video ID、URL或逐条媒体数组；完整有界网络区间、marks、事件、请求链仍在Pino排障。

播放中卡顿恢复与成对前台播放/卡顿窗口沿用现有观察器。卡顿占比使用同条窗口加权Σ卡顿/(Σ播放+Σ卡顿)，排除初始等待、暂停、seek与后台；只是已观测窗口，不代表完整会话或人数。

## CDN 对照增量

Grafana按桶对照候选见 `docs/grafana/engineering-performance.md` 的 CDN A/B 节：复用 `st-engineering-drama` 的原Faro链路，新增受控 `cdn_*` 属性与独立对照区，不重启SQL写入。5秒主图使用单次播放触发至首帧且playing的 `elapsedMs`，不把 `entryElapsedMs` 或 `recovery.cumulativeMs` 混进同一分布。无delivery的失败/早退保持unknown，start与final不是配对覆盖率，窗口数不冒充用户数。当前为本地候选，真实Cloud/Telegram与发布仍需新证据。

生产 20%／80% 稳定分组、服务端用户去重、关闭取址和比较命令见 [操作说明](../ops/drama-cdn-rollout.md)。新报告可含 delivery、recovery、entryElapsedMs 和 seek；兼容 Backend 先发布。新播放意图使用独立的地址查询，旧地址不作为播放结果，后台只预取详情。接收接口继续不写分析库；seek 不混入既有 startup 工程分母，首轮以完整 Pino 日志为来源。实验窗口必须核对 legacy 全量 start／结果上报，不能使用 unified 采样明细或仅慢启动 Loki 作为总分母。当前源码不代表生产已部署。

首播结束后独立观测进度提交至目标帧，type=seek；buffered=no 才是未缓冲样本，seeked不是成功。不支持帧验证的暂停 seek 记 unverified。5 秒是观测阈值，不改变播放超时；恢复子尝试保留原失败及累计时间，详情见上述说明。

## 起止与口径

- 列表：站内点击短剧入口起计；直接打开 `/dramas` 从文档导航的 `performance.now() = 0` 起计；其他情况下从查询开始或页面提交起计。按 `list_start_kind` 区分。从 `/` 自动分流到短剧时，不能假定已覆盖完整文档导航。
- 列表可用：列表数据对应的 DOM 已提交，包括缓存展示、空目录；不等待所有懒加载封面。选中封面独立记录 `cover_outcome/cover_load_ms`，缺少 Resource Timing 条目则不填耗时。
- 首次播放：点击封面起计，`entry=cover`。列表就绪、用户浏览 `browse_ms`、点击后的等待分别记录；`since_list_entry_ms` 包含浏览时间，不能当作播放加载耗时。
- 换剧：有效手势/按钮经防抖并确定目标后、路由切换前起计，`entry=switch`。换集/自动续集为 `episode`，不包含三秒倒计时；重播为 `retry`。缺少入口记录的播放页为 `direct`，只从播放器初始化观察开始计。
- 成功：同时有当前资源的 `playing` 和首帧。优先 `requestVideoFrameCallback`；旧 WebView 降级为 `playing` 后 `currentTime > 0` 的 `timeupdate`，并记录 `frame_method`。`canplay/loadedmetadata/play()` Promise 成功不能单独判为成功。
- 自动播放被拒绝是终态 `autoplay_blocked`，之后手动恢复不覆盖该次自动播放结果。
- 等待五秒发一次 `phase=slow` 快照并继续等待；成功、错误、不可播、切换、离开或后台产生一次 `phase=final`。五秒是观测阈值，不中断播放。后台结束本次观测，恢复不补算后台时长。

前端使用同页单调时钟，后端独立计时，用原请求 ID 关联，禁止前后端时间戳相减。首帧且playing后结束启动观测；后续卡顿恢复/质量窗口由同一媒体观察器独立投影，不续算启动耗时。进度提交另以独立 seek 观察。

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
- `media.snapshot`：五秒慢快照和终态生成时的即时状态，不是上一事件的旧状态。包括 `readyState`（0 无信息、1 元数据、2 当前数据、3 后续数据、4 浏览器判断数据充足）、`networkState`（0 未初始化、1 空闲、2 加载中、3 无可用资源）、paused/muted/seeking、currentTimeMs、bufferedAheadMs 和 visibility。媒体已释放/切源或属性不可读时状态可能缺失，不能当成零。
- `bufferedAheadMs` 只算覆盖当前播放位置的连续已缓冲时长；不跨缓冲空洞，也不是下载字节数或下载速度。可读且没有覆盖区间时为 0，读取失败或非有限边界时缺失。
- 每次观察最多保留前 32 条媒体事件；`eventsTruncated=true` 表示后续事件被截断，不能按缺少事件推断它没有发生。首次关键 marks 与实时 snapshot 继续采集。慢报告固定当时数组和状态，终态后不继续累加事件。

排查顺序：metadata → loadeddata 的长等待说明当前画面数据尚未就绪；loadeddata/canplay → playing 的长等待需要结合缓冲、paused、用户操作和 play 拒绝判断。waiting/stalled/suspend 都是浏览器状态信号，尤其 suspend 可能是浏览器主动停止预加载，不能单独判为网络故障。缓冲充足但首帧迟到仍不足以直接证明解码慢。

后台沿用原有 `outcome=background` 并结束观察，可从生命周期事件与 visibility 辨识；恢复不重新累计本次启动。用户手动 play 的结果只补诊断，保持原有 UI/终态处理；自动播放拒绝后的手动恢复不覆盖已结束的 autoplay_blocked。启动明细在终态后冻结；播放中卡顿恢复与质量窗口继续走工程出口。进度提交另以独立 seek 观察。

旧版报告没有媒体 Resource Timing/首字节。v2 被动读取当前源的可见资源条目，并明确区分 unsupported/no_entry/limited/available；跨域、WebView、在途请求等限制仍可能导致缺失。条目不提供原始 Range 区间/CDN 命中，不能自动证明某个两字节请求的原因；这些仍需真实网络或供应商证据。禁止把签名缓存或 API body 耗时当作媒体传输指标。

## v2 统计与能力边界

- 播放报告增加 `version=2/context`，含前端 release、随机页面会话、粗平台/浏览器大版本；不上传完整 UA、IP 或 Telegram 身份。Vercel 构建 SHA 自动注入 `NEXT_PUBLIC_DRAMA_RELEASE`，后端版本独立记录。
- 新增轻量 `phase=start`，在点击处理完成后的微任务中排队，继续使用 background 优先级；原 slow/final 保留，网络迟到最多补一次 `phase=network`，每次最多四次上报。不补报离线历史，不承诺完全未送达尝试的真实分母。
- `diagnostics.network.entries` 最多16条，以 src 精确匹配、代际与时间窗口隔离，URL 只留瞬时匹配内存。记录可见的相对请求边界、DNS/连接/TLS、TTFB 和浏览器字节字段；0/不可见字段不能直接证明缓存。final 不等待请求完成；尾观察最多5秒且不晚于设置源后60秒，后台/切源立即释放。`closed` 描述窗口关闭，不等同网络请求失败。
- 帧回调记录处理时长和送往合成器/预期显示时间，处理时长缺失保持缺失；不是“元数据到首帧的纯解码时间”。支持时只汇总长任务，最多128条内部区间，输出计数/总时长/最大值/元数据至首帧重叠时长；截断显式标记，不逐帧轮询。
- 首帧等待为 `first_frame` 偏移；启动完成为 `max(first_frame,playing)`，两者均到才成功。分析视图细分源→元数据、元数据→loadeddata、loadeddata→frame、frame→启动完成。缺失/逆序为 NULL，不能截为0。导航/预取并行，阶段P95不能相加。
- `miniapp_analytics.drama_playback_observations` 每环境/观察一行，数据库RPC原子合并乱序与重复；首个final不可被start/slow/冲突final改写。summary全量；慢/失败诊断全量、快速成功明细确定性5%。可见网络摘要和帧/长任务摘要也全量保存，避免明细采样影响分布。
- 摘要14天、详细数据7天；受限清理job初始关闭，验证容量后启用。仅service_role写，Grafana NOLOGIN reader只读，anon/authenticated无权限。无业务外键，播放API不读写此表。
- 上述数据库对象与保留期描述历史SQL路径；当前接收接口不再调用这些写入，固定返回202/`{ accepted: true }`。旧持久化flag不能恢复此接口写库；历史数据和离线导入器保留。
- Grafana 独立 UID `st-drama-playback`，只新增短剧看板，不修改经营/首token看板。默认24小时、5分钟刷新、最多读14天，复用现有只读数据源与连接上限。分位数附有效N，退出/后台/无终态单列，不把缺报算成功；旧日志标legacy且不能补回新字段。

## 上报可靠性与容量

- 浏览器先写同口径日志，再异步发送；失败记录 `drama.timing_upload_failed`，不改变播放结果。复用 API client 的 Telegram 鉴权，POST 不重试，低优先级并发槽与 `keepalive`；总预算五秒，包括排队和响应体。
- `keepalive` 尽力支持离开/后台时发送，不保证强制关闭、离线或鉴权过期时送达。无本地持久化、离线补传或远程送达保证；缺报不能推断成功。浏览器日志不自动进入 Vercel 日志。
- 接收端只允许共享 schema 中的有限枚举、数值、关联 ID 和计时结构，未知字段拒绝；不接收媒体地址、签名、对象路径、请求/响应正文或原始错误。
- 单次 body 上限 32 KiB，最多十二次查询、每次四次 HTTP 尝试，明细截断显式标记。鉴权用户每进程每分钟最多 120 次上报，全进程每分钟最多 1000 次；用户限流表最多 2000 项。超限返回 429。接收端所有模式都不写库，不增加依赖。这是进程诊断容量保护，多副本配额独立。
- 媒体诊断复用上述大小/频率约束，media/state/event 全部 strict 白名单；旧报告不带 media 仍接受。旧 Backend 会拒绝新增字段，因此扩展 validator 的 Backend 必须先于新 Frontend 部署；不影响旧客户端视频播放。
- 接口校验接收返回202/`{ accepted: true }`；Pino抛错仍调用独立Cloud出口，无分析存储队列。该确认不等于 Railway 日志永久落盘。
- `source=frontend` 属于客户端自报，不作为计费、权限或安全事实；进程日志时间是接收时间。

## 验证与发布

先部署 Backend，再部署 Frontend 到同一环境；旧 Backend 没有接收接口，上传会失败但视频不受影响。回滚应用版本即可，无数据恢复步骤。

自动回归覆盖：现有计时/媒体状态机、预取与缓存、迟到结果隔离、慢快照/终态、失败不阻塞播放、POST 参数/超时、鉴权、未知/嵌套敏感字段拒绝、body/明细数量上限、限流窗口、日志输出失败及 Backend 失败路径。跨包执行 shared tests、所有消费者 typecheck 和适用 build/lint。

真机验收需分别记录 TEST/Production 环境和 release：

1. Telegram 打开列表，停留后点击封面等到播放；在 Railway 查到列表/播放报告，确认浏览时间与播放等待分开。
2. 连续换剧、换集和重播；各次 `observation_id` 独立，旧观察不污染新资源，`request_ids` 可关联 Backend。
3. 重进同剧，区分 cache/inflight/fetch；分别限速 API 和媒体，验证地址阶段与媒体阶段可区分。
4. 五秒慢快照和最终结果属于同一观察；自动播放限制记录 `autoplay_blocked`。
5. 离开/后台/失败时核对终态；阻断接收接口，浏览器有上传失败诊断，播放不受影响，不把缺报算成成功。
6. 限速媒体，核对 loadeddata/canplay/play 结果和五秒 snapshot 的即时缓冲；启动时暂停/恢复、重试、换源及后台，核对用户事件与源代际隔离。检查上报 HTTP 202，若 400 先查 Backend 是否已部署扩展 media 契约。

本地测试通过不等于已完成 Telegram/线上送达验收。
