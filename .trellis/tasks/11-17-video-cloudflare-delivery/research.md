# 复用调研与方案候选（2026-11-17）

源码缩写：backend/代表packages/backend/src/，frontend/代表packages/frontend/src/，shared/代表packages/shared/src/。

## 确认事实与源码证据

- docs/drama-stream-ab.md：短剧清单路径及数据库storage_provider/stream_uid路径支持Stream，旧资产仍可沿旧源播放。这不是本次线上账户证明。
- backend/features/drama/stream.ts:49：本地RS256、15分钟HLS签名；播放关键路径不调管理API。可抽出签名原语，不复用实验、30条清单与排序业务。
- backend/features/drama/stream-manifest-cache.ts:65：有界缓存、single-flight、冷未命中不等网络、后台失败降级。64条容量面向短剧清单，广场应独立评估容量，不能挤出短剧工作集。
- frontend/lib/drama-media-source.ts:106：原生HLS/hls.js、动态加载、startLevel=0、续播与切源清理；drama-inline-manifest-loader.ts已有内联主清单装载。共享媒体原语，保留短剧专属修复和手势。
- backend/features/image-plaza/video-job.ts:184：上游完成后下载/处理MP4，将视频及封面上传Supabase，再publish并清理上游。storage.ts:252的视频桶为media-plaza-video。
- video-worker-repository.ts调用publish_video_artifact；repository-model.ts、repository-work.ts、video-repository.ts均签发视频地址，需要一起适配。
- shared/api/video-plaza.ts:288及后续artifact/work/playback只有video_url，没有HLS播放与MP4下载的显式区分。
- frontend/components/image-plaza/studio-video-card.tsx与app/(main)/create/work/[workId]/page.tsx直接设置video.src。仅替换m3u8地址会破坏不支持原生HLS的Android/WebView消费者。
- video-job.ts:51,64使用business_module=video；observability/business-context.ts:25白名单没有video。需沿用影像域image或按完整规则新增域，不能只改调用点。
- observability/events.ts、safe-log.ts、logger-options.ts决定实际字段输出；labels.zh-CN.ts当前缺少新视频阶段operation标签。

## 数据落位缺口

历史20261027*media_plaza_video.sql:48,107,430,465声明video_attempts、video_artifacts、任务领取及发布函数，仅是MIGRATION证据。registry.yaml尚未登记这组video*\*表，需先补现状/去向设计，不能假设可任意加列。
候选落位：稳定产物引用/格式归media_plaza的E；云端处理租约、重试与deadline归media_plaza.<feature>\_jobs的J；费用仍归billing；耗时/错误只走现有日志与ops出口。准确表名、权威writer、消费者、生命周期、保留期和软引用在design定稿后才写migration；不创建平行迁移源，也不改短剧归档端拥有的结构。

## Cloudflare官方资料与约束

推荐沿用Cloudflare Stream负责存储、转码与HLS分发，不搭R2加自建ABR集群。

- https://developers.cloudflare.com/stream/
- https://developers.cloudflare.com/stream/viewing-videos/using-own-player/
- https://developers.cloudflare.com/stream/uploading-videos/upload-via-link/
- https://developers.cloudflare.com/stream/uploading-videos/resumable-uploads/
- https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/
- https://developers.cloudflare.com/stream/manage-video-library/using-webhooks/
- https://developers.cloudflare.com/stream/viewing-videos/download-videos/

上传受理、readyToStream、全部质量处理结束不是同一件事，需核验状态与实际主清单。MP4下载副本也有生成状态，必须区分播放和下载URL，不把m3u8当mp4保存。
每个账户只有一个VOD webhook。优先在既有worker中有限、持久化轮询编码状态，不覆盖可能由短剧上传端使用的回调。
管理写请求结果未知不能盲目重复创建资产。UID或上传会话应先持久化，形成按任务恢复/清理策略；未安全转存前不删唯一源。

## 可靠性与最小方案要求

上传、状态读取、清单与封面读取都有覆盖响应体的明确超时。只对安全操作有限退避，429遵守服务端约束。无新消息队列、自建转码集群或全局webhook改造。
不持有数据库事务等待转码；只在短事务中发布产物，保留预扣/退款幂等。租约隔离并发，重启继续处理同一资产，失败/超时/未知分别收敛，不触发新的模型计费生成。
封面和处理状态及时显示，只有真实可播才展示成功；有界并发与缓存独立保护短剧容量。
最终design须落实旧客户端格式兼容、后端/前端发布顺序、新受理开关和回滚后已存在Stream资产的读取。

## 日志接入要求

复用observedFetch/clientFetch、runObservedJob、withBusinessContext与Pino安全投影。覆盖upload、encoding、publish、playback、download、cleanup。
info记录受理/阶段结束/实际就绪，warn记录可恢复超时/429/刷新/拒绝，error记录确定失败与补偿失败。可信用户和任务记录提供image_conversation_id、attempt_id、artifact_id、work_id；继承request/trace/span，不为日志额外查库、不加高基数指标或Sentry标签。
允许固定provider/stage、状态、计数、耗时和错误安全摘要。Cloudflare UID不能假装UUID塞进video_id；如确需输出要单独审查受控字段。
禁止token、私钥、完整URL或查询串、签名URL、提示词、原始云响应。原始错误使用{ err }；补中文展示及适用规则，沿用告警默认关闭与通知失败隔离。
验证真实Pino JSON中的字段保留、脱敏、一次终态、并发隔离和业务失败语义。前端首帧/卡顿观测必须有后端接收与可关联出口，不能只写console。

## 当前状态

只完成规划与源码/官方资料核对，未写产品代码、未创建migration、未访问远程数据库或上传真实视频。Cloudflare MCP此前已配置OAuth，本会话仍未暴露Cloudflare工具，不能声称账号、配额和运行时凭证已核验。

## 后续用户确认与只读实况

用户依次明确：只改变未来生成、无需旧播放兼容、TEST历史视频也迁移；发现13条后确认全部迁移。当前方案以全部13条为准。
只读CLI强制DATABASE_ENV=test、ALLOW_PROD_DATABASE=false并核验project_ref与HTTPS host均为zoqelpfhurwehlvypryl；启用TLS验证。13个产物含10seed+3generated，共74,247,409字节；13/13对象HEAD成功且长度匹配。没有查询用户/提示词，没有导出业务内容到Git。
既有清单位于G:/JobWork/ST/video-plaza-seed/test-canary-20261028/processed-manifest.json，SHA256=161dc1d37ba75c570ff78ac856386d4581084f20e9bc7336cbb8693c82f0d074。其10条与数据库路径匹配、upload-state声明20/20对象已验证（历史状态，不替代本次HEAD）。9份本地视频SHA256匹配，其余4个视频可从TEST恢复。此处只记录摘要，不提交真实素材/签名URL/服务凭证。

2026-11-17真实API合同：Cloudflare TUS 201的stream-media-id有效32位；Location的HTTPS域名实际为upload.cloudflarestream.com，旧官方示例使用upload.videodelivery.net。适配仅允许这两个供应商上传主机，不转发管理Token。首轮未知响应通过唯一test-plaza资产标记核对pendingupload并补偿，未盲重建或改变业务数据；已保存有效回执接续同一UID。

TEST-API只读OpenAPI（不是MCP或生产）：video_quotes13列、video_attempts34列、video_artifacts15列，delivery_jobs不存在。13/13已备份并上传核验3～5档和匿名拒绝，样本MP4下载ready/Range成功。数据库尚未切换。
