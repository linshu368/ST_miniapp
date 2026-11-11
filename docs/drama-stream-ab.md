# 短剧播放来源与发布验收

推荐列表置顶本环境清单中的 30 部剧。清单内每个指定单集对所有账号都走 Cloudflare Stream；第 31 部起及置顶剧中未映射的其他单集走 Supabase。搜索、历史、续看按相同的视频 ID 选源。

## 配置与资源交付

以下变量仅由 Backend 的 runtime-config 读取。TEST、production 各自准备资源和凭证。管理 API token 只用于素材准备，播放后端本地签发15 分钟的观看凭证。

- `DRAMA_STREAM_ENABLED`：播放开关，默认关闭。关闭后新取址恢复原路径，保留配置以归属迟到的实验事件。
- `DRAMA_STREAM_EXPERIMENT_ID`、`DRAMA_STREAM_EXPERIMENT_KEY`：沿用观测标识与匿名用户统计密钥。标识长度 1–64，使用字母、数字、短横线或下划线；密钥至少 32 字符。
- `DRAMA_STREAM_HOST`：本账户 customer 播放主机名，使用 cloudflarestream.com 域名，不包含协议或路径。
- `DRAMA_STREAM_KEY_ID`、`DRAMA_STREAM_PRIVATE_KEY`：本环境签名密钥的 ID 和 PEM 私钥（也接受供应商返回的 base64 PEM），仅进入后端 secret。
- `DRAMA_STREAM_MANIFEST`：受保护的 JSON 配置，包含 `environment`（test 或 production）与有序 `videos` 数组。每项是 `dramaId`、`videoId`、`uid`。必须完整 30 项且每类 ID 唯一。采用全竖屏、多档 v3 片单，ID 以当前环境实际目录为准。

## 数据库中的 Stream 视频（存量迁移）

`videos.storage_provider='cloudflare_stream'` 的行直接用库里的 `stream_uid` 签名播放，不属于上述清单，也不需要 `DRAMA_STREAM_ENABLED`；签名用同一组 `DRAMA_STREAM_HOST`、`DRAMA_STREAM_KEY_ID`、`DRAMA_STREAM_PRIVATE_KEY`，缺失时这些行不可播且不进列表。`DRAMA_LEGACY_SUPABASE_ENABLED` 默认开启（阶段一：存量 Supabase 视频与 Stream 视频并存）；设为 `false` 进入阶段二：Supabase 视频不再播放，只有所有视频都是就绪 Stream 的剧才进入列表。切换与回滚见 `.trellis/tasks/11-10-drama-stream-db-playback/prd.md`。

清单必须匹配数据库环境，Stream 与 Bunny 开关互斥。停用 Stream 后新取址恢复原路径。旧入组比例和采样账号变量不再参与选源，部署本版本无需改动它们。签名凭证缺失或签名失败时，清单内单集返回不可播。

## 接口与客户端

`GET /api/dramas` 按清单顺序置顶，清单外的剧保留随机相对顺序。固定地址 `POST /api/dramas/play` 与旧端 GET 共用处理器，鉴权并确认单集归属与可播状态后选源。旧端省略格式或请求 MP4 回退时，清单内仍返回 HLS；仅支持 MP4 的客户端无法播放这些单集。

播放器使用原生 HLS 或 hls.js。签名或媒体失败后，客户端对同一视频自动重新取址一次，保留原失败终态和累计等待。清单内重试继续走 Stream。

## 两项端到端读数

起播采用封面入口到真实首帧及 playing 的既有计时。未缓冲快进仅取提交前正在播放、direction=forward、buffered=no，观察目标帧与恢复播放。元数据就绪、已缓冲定位与后台行为分开报告。

前端沿用 `drama.startup`、`drama.seek` 及终态信号，新增 Stream 来源白名单和起播 `stream_budget`（3 秒）标签。旧 5 秒标签保持其定义。网络细节不可测时标记缺失。签名媒体路径在 Sentry 中脱敏。

历史 A/B 窗口可用以下命令复算。按发布时间和 release 分开观察全量 Stream 流量。

```bash
pnpm --filter @miniapp/backend exec tsx src/scripts/compare-drama-stream.ts --file /absolute/path/window.ndjson --environment test --experiment EXPERIMENT_ID --from ISO_START --to ISO_END
```

每份导出最多 14 天、64 MiB、50000 行，人工确认完整性。不要把各窗口的 P95 求平均来计算总窗口 P95，应对完整去重原始观察重新计算。结果按原分组报告终态分布、操作数、去重用户、3 秒成功率、可测成功 P95、恢复、冲突与缺终态。回退及重试根计为一个起播意图。失败也进入 3 秒成功率分母。跨片或跨窗口用户数不能相加。置信区间须按用户聚类单独评估。

## 发布与验收顺序

1. 核对片单版本、环境中的首个可播单集、显示方向、封面、UID、私有访问、多档转码和合理画质，记录 30/30 回执。
2. TEST 保持 Bunny 关闭，先发布 Backend 再发布 Frontend。使用原 A/B 和定向账号分别验证第 1、30 条的 Stream HLS、第 31 条和置顶剧未映射单集的 Supabase MP4。
3. 在 Telegram iOS/Android 验证首播、续看和同集重试。核对实际取址、首帧及失败日志，签名或 HLS 失败后不得出现 Supabase 回退地址。
4. 生产部署完成后按同一边界复核。需要整体验证回滚时，关闭 Stream 开关、保持 Bunny 关闭，并确认所有实例的新取址恢复 Supabase。

官方资料：[复用播放器](https://developers.cloudflare.com/stream/viewing-videos/using-own-player/)与[私有播放签名](https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/)。
