# 广场观测定义与窗口契约

状态：设计约定，尚未注册或上报；实际代码/云端实收结果须在实施后验证，不能把本文件当作已上线事实。

## 名称及计时

同一观测器形成一次结果，再调用既有Sentry metrics和Faro工程出口。成功耗时用distribution/measurement，所有结果另记count/event；失败/后台/离开不填入成功耗时分布。

- Faro `plaza.feed` / Sentry `plaza.feed.duration`：query开始至页响应完整解析，含排队；stage=first_page/next_page，media/sort/cache有限分组。Sentry `plaza.feed.outcome`与Faro `plaza.feed_terminal`计终态。
- Faro `plaza.poster` / Sentry `plaza.poster.duration`：列表/详情观测入口到本次关键封面解码并获得绘制机会；stage=poster，outcome=loaded/error/absent/timeout/background/left；终态计入 `plaza.poster.outcome` / `plaza.feed_terminal`。既有page.critical_visual继续独立，不能把不同起点拼在一起。
- Faro `plaza.video_prepare` / Sentry `plaza.video_prepare.duration`：详情/工作室活动播放器加载起点到可用媒体；stage=prepare。不以此宣称真实首帧达标。
- Faro `plaza.first_frame` / Sentry `plaza.first_frame.duration`：native controls可观察play事件/应用实际play调用到已确认帧；stage=first_frame。进入详情到play的用户等待独立，不混入这个2秒分布。
- Faro `plaza.entry_first_frame` / Sentry `plaza.entry_first_frame.duration`：详情入口到已确认帧，stage=entry_first_frame，包含用户等待播放，仅诊断；没有同一起点旧样本时不回填。
- Faro `plaza.seek` / Sentry `plaza.seek.duration`：seek开始到目标新画面确认；stage=seek，播放/暂停两种状态和measurement版本可分辨，目标迟到/变化不能成功结算旧seek。
- Faro `plaza.rebuffer` / Sentry `plaza.rebuffer.duration`和`plaza.rebuffer.count`：首帧后的真实等待到恢复画面，按活动播放窗口汇总；seek、暂停、后台单列排除，不把其等待作为网络卡顿。
- 上述视频终态镜像Faro `plaza.video_terminal`与Sentry `plaza.video.outcome`；plaza.rebuffer事件记录汇总次数和时长。超时只结束该次观测，不取消播放。

测量方法有限值：video_frame_callback、playing_and_timeupdate、image_decode_after_frame；source_measurement_version固定plaza_v1。本版本不能与旧后端onPlay到playing的历史事件混算P95。

## 有限属性

route只允许/create、/create/work/:id、/create/studio/:id；media=all/image/video；sort=recommended/latest；stage为上述固定集合；cache=fetch/inflight/cache/unknown；navigation_type=document/spa/mount；tg_platform、net_type、net_rtt_bucket复用既有有限枚举。环境与release来自现有出口，不读业务身份。

禁止属性：work_id/artifact_id/user_id、initData、token、签名/播放URL、提示词、正文、SDK用户/Replay ID。后端既有授权观测POST仍携带artifact_id用于访问校验，但它不成为浏览器聚合属性。错误只用固定类别，不能附原始Error.message或响应正文。

Faro measurement和event名称、所有新增维度和值必须登记grafana-schema；Sentry新增plaza前缀metric须有独立属性白名单净化，不能只净化startup指标。测试实际出口净化后的样本，不能只测调用前对象。

## API与服务端

沿用api.total/queue/headers/body/upstream，补有限api_route=image_plaza_feed/image_plaza_detail/image_plaza_playback。/api/image-plaza/playback-observations从产品API聚合排除，避免上报自身形成噪声；不在组件新增fetch。

后端HTTP持续记录允许状态、耗时、request/trace/span；feed.completed补media/版本/计数；排名维护记录固定operation、候选数量、耗时及成功/拒绝/未知。服务端原始异常以{err}进入既有安全投影，不把业务行或动态SQL写日志。

## 查询交付要求

Sentry选择上述duration，聚合p95并同时显示count；按sentry.environment/release、平台、media/sort、cache、measurement筛选。Grafana基于现有engineering_v1出口的plaza measurement/event做同口径LogQL聚合；实施后核对实际Loki标签/JSON字段路径并给出可执行模板，不在尚未实收前编造字段名。

记录每个窗口的环境、release、measurement版本、Asia/Shanghai展示起止及明确时区的查询起止、N、P95、成功/失败/后台/离开/stall计数。发布前后各24h；N<100延长72h，仍不足则标低样本；禁止平均各分组P95。

目前本任务没有云端实收/独立采样基线；null表示未测，不是0ms。新增指标首个发布只能建立窗口，后续release才能对照同定义历史。网络API未知不等于参考网络；参考网络2秒验收需受控网络/真机，生产网络桶只用于切分诊断。
