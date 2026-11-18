# 影像广场排序、固定两列与视频观测

2026-11-18：本地候选，未执行TEST/production迁移或部署。本地验证不证明生产P95已达标。

## 排序和布局

推荐先展示本站有赞作品，按like_count倒序、稳定ID决胜。零赞作品在每个媒体/模型组内按source_heat降序取得相对名次，再按名次轮流展示各模型。原始热度量级不跨模型比较；正热度在前，0/缺热度在后，新分享没有时间加权。最新独立按published_at（分享时间）倒序、ID倒序。

全部/图片/视频在数据库分页前筛选；全量排名过滤另一媒体不会改变本媒体模型间次序。搜索和标签只过滤已有顺序。模型样本耗尽后其余继续。

所有屏宽固定两列。根据声明宽高比向短列稳定追加，保持已有卡片的列位置；任一列底部进入预取范围即可驱动同一加载闸门，先释放缓存渲染批次，再请求下一页。保留Android/iOS原预算。最终耗尽时两列尾部允许最后一张卡片高度内的自然差异，不裁剪媒体或补造条目。

列表视频只请求poster，不挂video或请求清单/分片。详情/工作室保留Stream/HLS、低档起播/ABR及Apple分支；活动播放器按可见性/省流量预加载，后台/离页释放源。换签一次、合并并发错误、保留位置；换source取消旧观测回调。

## 排名数据与发布

唯一新增迁移为 `packages/shared/migrations/20261118_media_plaza_feed_ranking.sql`。

- media_plaza.image_plaza_feed_scores为D类当前代排名，work_id同域关联works，initial_feed_order为正唯一bigint，ranking_revision为同代UUID。旧works.initial_feed_order保持原值，仅供旧消费者过渡，不双写。
- rebuild_image_plaza_feed_order原子重建，最多100000件；排他事务advisory lock、5秒锁预算、60秒语句预算。read_image_plaza_recommended_feed用同名共享锁完成有界DB读取，签名在锁外。无热路径全量重算、定时任务或新配置key。
- table开启RLS；PUBLIC/anon/authenticated不能读写表或执行函数；service_role有指定权限。无新公开HTTP接口、资金或资产变更。
- 推荐v2游标绑定filter/media与ranking_revision，旧v1推荐或过期revision明确返回IMAGE_PLAZA_INVALID_CURSOR。前端清旧链自动恢复一次，再失败保留刷新入口；query key升级。latest v1独立。
- 实时点赞/分享仍采用动态feed，前端按ID去重，不承诺跨请求冻结目录。新分享未入当前代时位于零赞尾部，以ID决胜。

图片seed apply新增作品后重建一次。当前视频seed CLI只读审核，旧Supabase写入/SQL生成路径已退役；经审核的视频SQL批次落位后统一运行维护入口，不修改历史迁移或复活旧导入：

```powershell
pnpm --filter @miniapp/backend image-plaza:rebuild-feed --target test
pnpm --filter @miniapp/backend image-plaza:rebuild-feed --target test --apply
```

默认只预览计数，目标必须匹配配置。本次未执行远端。production须先展示差异、计数/容量和恢复步骤并取得本次对话明确同意，才使用production目标及`--apply --confirm-production`。提交未知先核对revision/计数，不盲重试。新增热度作品导入至重建完成间可能暂处尾部；发布验收要求正热度新作品已入排名。

发布顺序：本环境shape/规模/权限核实→TEST单文件迁移→排名/分页/权限/计划验证→Backend全部副本→Frontend→真机和窗口。production独立核验，不能用TEST结论代替。

回滚先退Frontend/Backend消费者，保留派生表/函数；旧编号不变，可恢复旧读路径。排名错误forward-fix后原子重建，过期客户端恢复首页；不自动DROP、不回滚钱包或删除资产。停止条件包括shape未知、容量超限、锁/语句超时、权限泄漏、静态漏页、错误/stall/P95恶化。

只读postflight检查RLS/ACL/owner、索引、revision唯一、候选≤100000、正热度未入排名数量及分页/EXPLAIN。禁止提交业务行导出。本地SQL引擎为单连接WASM，不能证明多连接锁竞争或生产API P95。

## 指标定义

同一浏览器观测结果镜像Sentry与Faro，source_measurement_version=plaza_v1，Faro总版本仍为engineering_v1。Sentry duration与Faro plaza.\* measurement逐一对应：

- plaza.feed.duration：query开始到响应完整解析，含排队，page_kind=first_page/next_page；错误/超时/取消单列，期间切后台不进入成功P95。
- plaza.poster.duration：列表/详情观测入口到关键封面解码并获得绘制机会，loaded成功；error/absent/background/left独立终态。继续保留page.critical_visual。
- plaza.video_prepare.duration：活动播放器准备到媒体可用，不等于首帧；10秒watchdog只结束观测，不取消播放。
- plaza.first_frame.duration：native play事件等可观察播放意图到真实首帧，rVFC优先，旧引擎使用playing后时间推进与绘制机会，measurement分列。
- plaza.entry_first_frame.duration：详情挂载（含work查询等待）到真实帧，包含用户等待点击，仅诊断，不与纯加载2秒SLO混算。
- plaza.seek.duration：seek开始到目标新画面，包含暂停seek；新seek/换源使旧回调失效。
- plaza.rebuffer.duration：本活动窗口累计卡顿时长；plaza.rebuffer.count为实际次数。Faro汇总事件带有界stall_count数值，不把一次汇总当一次卡顿。

Sentry终态为plaza.feed.outcome、plaza.poster.outcome、plaza.video.outcome（按stage分列）；Faro为plaza.feed_terminal、plaza.video_terminal、plaza.rebuffer。失败不补零、不进入成功分布。

entry_kind=initial/continuation区分初次与后台恢复/换源，延续活动重新起钟，不计后台停留。StrictMode不产生假page-left。后端观测POST继续2KiB、30/min及每artifact生命周期最多8次；不逐帧HTTP上报，遥测失败不阻断业务。

属性仅限route模板、media/sort、stage/outcome、cache/page_kind/entry_kind、measurement、平台/网络桶及公开release/environment。禁止业务ID、URL/签名、initData、提示词或Replay身份。服务端{err}安全投影、request/trace关联继续；feed保留media/ranking_version/数量/耗时。API分组区分feed/detail/playback，观测上传排除产品API聚合。

## P95与窗口

Android/iOS分别验收：列表/详情critical visual≤2000ms，工作室ready≤1500ms，feed浏览器≤800ms、完整HTTP server≤500ms；参考网络下行≥10Mbps/RTT≤100ms，真实首帧/seek≤2000ms。feed.completed内部耗时仅诊断，不能代替完整HTTP server耗时。

当前基线均为null（本任务无独立可见样本）。发布前后各24小时，按环境/release/平台/路由/media/sort/entry_kind/measurement比较；每组显示N，N<100延长72小时并标低样本，同时审阅失败/超时/后台/离开和stall。新增指标先建立首窗，后续release再比较，不能回填旧drama/onPlaying样本。浏览器网络桶不证明参考带宽；unknown保持未知，受控网络/真机另验。

Sentry对上述duration选p95与count，按sentry.environment/release和有限属性筛选。Grafana沿用本项目已核验的Cloud流/logfmt契约，首次发布需核验新事件实收；不自动创建看板/告警。首帧模板：

```logql
quantile_over_time(0.95,
  {service_name="st-miniapp"} | logfmt
  | kind="measurement" | type="st_plaza_first_frame"
  | app_environment="production"
  | context_source_measurement_version="plaza_v1"
  | context_entry_kind="initial" | context_outcome="succeeded"
  | context_tg_platform=~"android|android_x|ios"
  | unwrap duration_ms | __error__="" [24h]
) by (app_version, context_tg_platform, context_route, context_measurement)
```

终态模板；event属性是event_data，measurement属性是context，不能混用：

```logql
sum by (app_version, event_data_tg_platform, event_data_stage, event_data_outcome) (
  count_over_time(
    {service_name="st-miniapp"} | logfmt
    | kind="event" | event_name="st_plaza_video_terminal"
    | app_environment="production"
    | event_data_source_measurement_version="plaza_v1" [24h]
  )
)
```

feed/poster/seek替换对应st*plaza*\*名称；N必须使用与P95完全相同的measurement筛选。固定窗口起止带明确时区，报告用Asia/Shanghai；不平均分组P95或混合计时起点。

## 本地SQL性能防回退

重建后同步ANALYZE作品与派生排名，使批量导入后的读取获得新统计信息。推荐读取先有界获取点赞区，再沿排名索引读取零赞区，避免全目录LEFT JOIN排序。本地10万条合成数据回归断言首屏排名索引只读取21条；该执行计划与耗时仅为本地正确性证据，不代表生产过滤选择性、多连接锁或P95。空目录重建与读取统一返回nil revision。

## 复验入口

```powershell
node scripts/test-media-plaza-feed-ranking.mjs <本地PGlite的dist/index.js绝对路径>
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend exec vitest run src/features/image-plaza src/routes/image-plaza.test.ts src/routes/video-plaza-playback.test.ts
pnpm --filter @miniapp/frontend test
pnpm -r typecheck
pnpm test:ui:fixtures
pnpm test:ui --grep '@image'
```

@image覆盖320/390px三页混排/筛选、旧游标一次恢复、宽屏仍两列、列表零清单分片。代理导致本地探测502时，仅在本次命令为127.0.0.1/localhost设置NO_PROXY，不改断言/超时/端口，不终止他人服务。真实Stream、Telegram控件、多连接SQL与生产窗口仍须分别验收。
