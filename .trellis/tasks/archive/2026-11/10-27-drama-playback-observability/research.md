# 证据与复用调研

2026-10-27。CODE=当前实现，DOC=历史记录，PROD-LOG=生产日志抽查，GAP=未核验；没有读取数据库业务行。原始日志未提交 Git。

## CODE：实际链路

1. 点击封面 beginPlayback(entry=cover) 并预取 /api/dramas/:id/play；换剧switch、换集episode、重试retry各建观察，direct只从播放器初始化起计。
2. useDramaPlaybackQuery 与详情/队列并行。React Query 区分cache/inflight/fetch；播放器不等详情即可赋video.src并play()，使用playsInline、preload=metadata。
3. Backend /play：Telegram鉴权→repository查询→可播判定→签名。签名TTL3600s、缓存最多1800s、到期预留60s、500项、single-flight。
4. 浏览器直接向Supabase Storage私有drama-videos桶加载视频，字节不经过Railway Backend。签名缓存不是媒体CDN缓存。
5. drama-media.ts已有metadata/loadeddata/canplay/playing/首帧等事件，优先requestVideoFrameCallback、降级playing+timeupdate。playing和首帧均到才成功，之后不统计播放卡顿。
6. drama-timing.ts统一performance.now()，十秒一次slow、结束一次final；最多32条媒体事件、12次查询、每次4次HTTP尝试。
7. drama-observer.ts先打浏览器日志，再由api/telemetry.ts上传。5s预算、background优先级、keepalive、不重试；Backend严格白名单、32KiB body、每用户120/每进程1000次每分钟；写Pino后accepted，不落库。

## PROD-LOG：核验字段存在，不能代表整体分布

Railway只读确认 gallant-insight production（f03d6c61-84e3-434d-a81a-0ae209167ef5），stminiapp服务（8bd593b7-7c40-4ab6-8808-c0863f27a22a），最近部署972a294f-a497-4f52-b2a7-684a84518889，创建于北京时间2026-10-27 15:05:59，源分支main。没有核验Frontend SHA。

15:40左右查询过去24h、filter=drama、limit=30。返回片段中只有四次成功播放终态，是截断便利样本，不能据此计算生产P95/成功率/覆盖率。

- 一条elapsed=5824ms、source_to_metadata=3422ms、metadata_to_frame=600ms；first_frame=5334ms、playing=5824ms，相差490ms。首帧可以先于playing，不能强设canplay→playing→frame全序，也不能把启动结束叫首帧。
- 另一条/play Backend total约85ms，前端headers约1398ms；API网络/代理等待仍需保留，不能先验忽略。
- 已带media.events和snapshot，确认生产有相应报告；缺前端release、平台与媒体网络字段。

## DOC与GAP

- docs/drama-playback-timing.md明确没有媒体Resource Timing/Range/CDN/moov证据，离线/强关无送达保证。
- 10-26-drama-media-startup-timing/prd.md记载Preview启动45301ms、metadata→frame40346ms，不是生产分布。
- 10-21-drama-api-contract-backend/task.md和frontend-ui/task.md：当时TEST十个视频中六个moov尾置。仅是历史假设来源，不证明生产现在如此；旧“首帧主要反映容器”的结论不可泛化。
- docs/grafana/README.md/JSON声明PostgreSQL只读数据源，生产UID fg1oltvmm56v4b；连接池每实例1条、角色上限3条。本轮未登录实时Grafana，不能断言线上绝无Loki。
- 实施前补GAP：真实Storage TAO/重定向/Range条目可见性和交付时机、各WebView能力、日志保留及分页导出、实时Grafana授权/数据源、完整窗口N与容量。

## 复用与最小新增

- 扩展现有drama-timing/media/observer和shared/api/drama-timing.ts，不建第二套播放器/计时状态。
- 新小型network helper只负责能力检测、内存关联和有界监听；URL不离开匹配内存。
- 复用frontend/api/telemetry和backend/routes/telemetry鉴权入口；复用getDomainDb('miniapp_analytics')和功能repository分层。
- 已检索现有drama组件/hooks/helpers/repository/contracts、Grafana reader与聚合migration，未发现可复用的短剧持久表/合并函数。新增限定本功能的表与原子合并入口；不建通用SDK/采集服务。
- 复用docs/grafana的DS_POSTGRES模板，不改经营看板/旧全历史cron。
- 优先扩展现有drama-media/timing/observer、telemetry-contract、backend telemetry测试。SQL并发/ACL回归需规划审核。ui-tests当前无短剧分组，但fixture有telemetry接收路由可复用。

## 外部一手资料

- [Resource Timing规范](https://www.w3.org/TR/resource-timing/)：TAO限制跨域计时，no-cors状态/字节也可能不可见；video initiator可能是poster；没有Range请求头/Content-Range可读字段。已完成条目不是所有在途请求的实时瀑布。
- [帧回调规范](https://wicg.github.io/video-rvfc/)：回调对应送往合成器的帧；processingDuration是该帧的解码及可能的额外处理，可缺失；主线程负载会延迟回调。
- [Long Tasks规范](https://www.w3.org/TR/longtasks-1/)：被动观测超过50ms的主线程长任务，只作辅助证据，不支持时未知。
- [Supabase Smart CDN](https://supabase.com/docs/guides/storage/cdn/smart-cdn)：签名token影响缓存键；签名缓存命中不能证明媒体边缘命中。不为监控加随机参数。
- [Grafana PostgreSQL](https://grafana.com/docs/grafana/latest/datasources/postgres/configure/)：原生数据源、只读授权、有限连接。已查Supabase changelog；本轮无SDK实现，实施时重查相关变更及目标能力。
