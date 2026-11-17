# 广场视频 Cloudflare Stream 切换

本地候选代码，TEST 数据库迁移及应用发布尚待执行；不代表生产已部署。范围是未来新生成视频与指定 TEST 的现有13条。用户确认不保留广场旧MP4播放兼容，封面及业务数据保留在Supabase。

## 配置

后端复用短剧 `DRAMA_STREAM_HOST`、`DRAMA_STREAM_KEY_ID`、`DRAMA_STREAM_PRIVATE_KEY`，不依赖短剧A/B开关或片单。私钥接受完整PEM或Base64 PEM；`.env` 多行PEM必须正确引用，不能只解析出首行。上传读取 `CLOUDFLARE_ACCOUNT_ID` 与 `CLOUDFLARE_API_TOKEN`；现有 `VIDEO_STREAM_API_TOKEN` 作为管理Token别名继续使用。不需要 `VIDEO_STREAM_CONFIG` 或 `VIDEO_STREAM_PRIVATE_KEY`。

账户必须与短剧播放host及签名密钥相符，Token需Stream读写权限。账户ID不能由customer主机名推测。OAuth仅供Codex连接，不能替代服务端Token。变量只存后端受保护环境，不提交`.env`。播放本地签名不需要管理Token；新生成受理需要完整管理配置。默认交付期限20分钟。

## 数据和交付

`video_artifacts` 是E产物：稳定 `stream_uid`、`playback_url`，保留封面、尺寸、时长、来源和业务主键；不持久化临时观看JWT。`video_delivery_jobs` 是J任务：唯一attempt、独立租约token、上传会话和源SHA-256、退避与deadline。未知结果隔离保留，已发布/已补偿任务7天后有限清理。费用继续由既有billing RPC负责。

模型完成后原子入交付队列。每轮只上传一个5MiB TUS块，HEAD恢复偏移；不暂存Supabase视频、不再整段FFmpeg转码。Stream全档就绪并核验清单/分片后取封面写Supabase，短事务发布。发布未知不能退款或删除；明确失败与退款同事务，过期租约/已退款不得迟到发布。Cloudflare创建响应丢失不能盲目重建。

TUS 201必须取`stream-media-id`，不从URL猜UID。真实API当前返回`upload.cloudflarestream.com`；旧示例使用`upload.videodelivery.net`。仅允许这两个HTTPS上传主机；上传能力不携带管理Token。429尊重有界Retry-After。上传回执、能力URL和备份只保存在Git仓库之外。

## API和消费端

- 产物/视频作品返回 `playback:{format:'hls',play_url,expires_at,inline_manifest?}`；视频作品公开 `artifact_id`，种子不需要attempt。
- `GET /api/image-plaza/video-artifacts/:artifactId/playback`：本人生成产物或仍发布的作品，响应private/no-store。
- `GET /api/image-plaza/video-artifacts/:artifactId/download`：独立MP4副本的processing/ready/failed状态；只对下载签名加downloadable，不把HLS当下载文件。
- `POST /api/image-plaza/playback-observations`：严格、2KiB、限流，重新鉴权/检查产物访问权；只接收首帧、seek、stall和固定结果/耗时，不接受身份、URL和错误正文。

工作室/详情共用HLS装载和一次有限刷新，保留位置及播放状态。hls.js低档起播后ABR；支持MMS的Apple设备使用完整ABR，旧Apple原生HLS由引擎选择起始档。列表只显示封面。切源、离页、后台与迟到回调隔离。真实Android/iOS首帧及P95需独立观测，不由单测推断。

## TEST操作顺序

目标固定`zoqelpfhurwehlvypryl`，13条（10种子+3生成），集合变化立即停止。先停止TEST视频受理及worker，确认账户/配额。以下命令必须在已指定TEST的环境运行，directory为仓库外的独立恢复目录，confirm-account使用核验后的同一账户ID：

```sh
pnpm --filter @miniapp/backend video-plaza:stream-migrate --phase preflight --directory <恢复目录>
pnpm --filter @miniapp/backend video-plaza:stream-migrate --phase upload --directory <恢复目录> --confirm-account <账户ID>
pnpm --filter @miniapp/backend video-plaza:stream-migrate --phase verify --directory <恢复目录> --confirm-account <账户ID>
pnpm --filter @miniapp/backend video-plaza:stream-migrate --phase sql --directory <恢复目录> --confirm-account <账户ID>
```

每一步单独检查结果；verify可能返回部分仍处理中的计数，未13/13 verified时sql拒绝生成。创建结果未知时按精确资产标记对账，不能删checkpoint重跑。所有请求启用TLS证书校验。

数据库只通过GitHub Actions **Database Migration**、`environment=test`逐文件执行，不能由工具直接改业务表：

1. `20261117_media_plaza_stream_delivery.sql`：扩展产物列、交付队列及fenced RPC。
2. 已核验后生成的`20261117_media_plaza_stream_test_assets.sql`：恰好13行CAS原子切换；workflow同时校验TEST身份。
3. 发布Stream Backend/Frontend，核验13条取址/权限/历史/分享及一次新生成。
4. `20261117_media_plaza_stream_contract.sql`：全量非空、旧worker退出后删除旧storage_path及旧seed导入函数。
5. 应用验收完成后才运行cleanup，加`--confirm-app-verified 13/13`；只清理原13个Supabase MP4，不删封面。独立本地源文件和SHA-256保留。

不要按文件名字典序执行以上迁移。源文件清理前可恢复映射；清理后恢复先从独立备份还原对象，不能声称删除可无条件撤销。停止/恢复优先保留事实并forward-fix，不回退到MP4 writer。旧`seed-upload`、`seed-sql`入口拒绝继续写Supabase视频。

## 日志和验证

业务模块统一image，可信user/conversation/attempt/artifact/work关联request/trace；新增upload/encode/publish/playback/download/cleanup/migration场景及中文词表。原始错误用`{err}`，安全出口不输出签名URL、Token、私钥、提示词或响应正文。新增规则默认关闭，通知失败不影响业务。

已有shared、Backend/Frontend测试与全消费者typecheck必须通过；真实Pino JSON验证白名单与身份。`node scripts/test-video-stream-delivery.mjs <本地PGlite模块路径>` 验证真实SQL扩展/收缩、幂等、租约、退款、ACL和未知状态；单连接WASM不代替TEST多连接锁竞争。用户本轮明确不需要本地UI测试，未完成的UI/真机验证不能写成通过。
