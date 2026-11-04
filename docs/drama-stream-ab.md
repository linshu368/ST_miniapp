# 30 条竖屏短剧 Stream A/B

本地接入实现使用同一播放器比较 Supabase MP4 与 Cloudflare Stream HLS。正式性能结论来自验收后冻结的生产观察窗口。

## 配置与资源交付

以下变量仅由 Backend 的 runtime-config 读取。TEST、production 各自准备资源和凭证。管理 API token 只用于素材准备，播放后端本地签发15 分钟的观看凭证。

- `DRAMA_STREAM_ENABLED`：实验开关，默认关闭。关闭后新取址恢复原路径，保留配置以归属迟到的实验事件。
- `DRAMA_STREAM_ENROLLMENT_BPS`：0–10000 的入组比例，默认 0。建议 TEST 全量覆盖，生产健康灰度 1000，正式 10000。入组与 50:50 分组分别哈希，扩量保留组别。灰度和正式窗口分别记录。
- `DRAMA_STREAM_EXPERIMENT_ID`：新实验标识，最多 64 位字母、数字、短横线或下划线。整个窗口固定。
- `DRAMA_STREAM_EXPERIMENT_KEY`：受保护的独立随机分配密钥，至少 32 字符。整个窗口固定。
- `DRAMA_STREAM_HOST`：本账户 customer 播放主机名，使用 cloudflarestream.com 域名，不包含协议或路径。
- `DRAMA_STREAM_KEY_ID`、`DRAMA_STREAM_PRIVATE_KEY`：本环境签名密钥的 ID 和 PEM 私钥（也接受供应商返回的 base64 PEM），仅进入后端 secret。
- `DRAMA_STREAM_MANIFEST`：受保护的 JSON 配置，包含 `environment`（test 或 production）与有序 `videos` 数组。每项是 `dramaId`、`videoId`、`uid`。必须完整 30 项且每类 ID 唯一。采用全竖屏、多档 v3 片单，ID 以当前环境实际目录为准。

`DRAMA_CDN_ENABLED`（Bunny）和 Stream 同时启用时，Stream 禁止入组。无效配置也恢复原路径。配置就绪应由发布前核验确认，不能靠实际用户发现配置错误。

## 接口和客户端

`GET /api/dramas` 先沿用随机排序，再把同一片单中的 30 部固定在前面。其余剧保持本次随机相对顺序。新版客户端使用新版本的本地目录缓存，避免旧目录阻碍初次验证。最新、搜索、历史及续看保留各自入口的语义。

新版兼容客户端对 `/api/dramas/:id/play` 声明 `format=hls`，服务端在鉴权、单集归属和可播判定之后，根据实际选中单集进行入组。A 返回原签名 MP4，B 返回私有 HLS 清单及 `format=hls`。旧客户端沿用 MP4。

同一 video 元素在支持时使用原生 HLS，否则动态加载 hls.js。切源时销毁实例、取消迟到装载，观测通过装载归属识别 blob 源。Stream 致命失败或签名失败可触发同一意图至多一次 `fallback=mp4`，服务端保留 B 分组并标记实际 Supabase 来源。恢复仍经鉴权。重试沿用计时根和累计等待时间，原失败终态保留。

## 两项端到端读数

起播采用封面入口到真实首帧及 playing 的既有计时。未缓冲快进仅取提交前正在播放、direction=forward、buffered=no，观察目标帧与恢复播放。元数据就绪、已缓冲定位与后台行为分开报告。

前端沿用 `drama.startup`、`drama.seek` 及终态信号，新增 Stream 来源白名单和起播 `stream_budget`（3 秒）标签。旧 5 秒标签保持其定义。网络细节不可测时标记缺失。签名媒体路径在 Sentry 中脱敏。

只读本地导出复算入口：

```bash
pnpm --filter @miniapp/backend exec tsx src/scripts/compare-drama-stream.ts --file /absolute/path/window.ndjson --environment test --experiment EXPERIMENT_ID --from ISO_START --to ISO_END
```

每份导出最多 14 天、64 MiB、50000 行，人工确认完整性。不要把各窗口的 P95 求平均来计算总窗口 P95，应对完整去重原始观察重新计算。结果按原分组报告终态分布、操作数、去重用户、3 秒成功率、可测成功 P95、恢复、冲突与缺终态。回退及重试根计为一个起播意图。失败也进入 3 秒成功率分母。跨片或跨窗口用户数不能相加。置信区间须按用户聚类单独评估。

## 发布与验收顺序

1. 核对片单版本、环境中的首个可播单集、显示方向、封面、UID、私有访问、多档转码和合理画质，记录 30/30 回执。
2. TEST 配置关流，先部署兼容后端，再部署新版前端，验证旧端、新端和片单外播放。
3. TEST 全量入组，用受控账号覆盖 A/B，Telegram iOS/Android 分别验证新播、换集、续看、未缓冲快进、签名过期、失败重试和回退。核对两项读数及凭证脱敏。模拟 MP4 验收不能替代真实 HLS 真机验收。
4. 生产资源、Bunny 关流后恢复证据、费用、灰度开关另行核对，审核部署和开流。异常时先关 Stream 开关，验证新播放回 Supabase。保留历史资产和观察数据。

官方资料：[复用播放器](https://developers.cloudflare.com/stream/viewing-videos/using-own-player/)与[私有播放签名](https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/)。
