# 短剧取地址固定 POST 与 Android 快进去重

## 目标

现有口径下，短剧起播 P95 与无缓冲快进 P95 均 ≤3s。本任务负责其中两块：取地址链路、Android 快进重复提交；媒体段（Cloudflare Stream AB）由他人推进，不在本任务内。

## 背景（Railway production 日志，10-28～11-04）

- 起播 P95 8.2s，3s 内完成 60%；取地址（入口→地址就绪）P95 2.1s。
- `/play` 后端处理 P50 78ms / P95 272ms，前端看到 P50 758ms / P95 2.27s，约 90% 是客户端到 Railway（新加坡）的网络开销。
- 10-29 去掉意图前预取后，点封面取地址 P50 857→1448ms、P95 1972→2989ms：`/play` 要等路由跳转、播放器挂载后才发出（约点击后 558ms）。
- Android 539/1718（31%）的快进会在 50ms 内被几乎同一目标（差约 0.02s）的第二次提交替换，iOS 为 0；被替换的记录在“3 秒达标率”里算未达标。

## 需求

1. 新增固定地址 `POST /api/dramas/play`（请求体 `{drama_id, video_id?, format?, fallback?}`），使 CORS 预检（`maxAge` 7200s，按 URL 缓存）可复用；原 `GET /api/dramas/:id/play` 保留给旧客户端，两者共用同一处理逻辑。
2. 前端改用 POST 取址；点封面、详情页换剧在点击当下就发出 `/play`，播放器挂载后的 `useDramaPlaybackQuery` 接上这次请求。
3. 必须遵守 10-29 规则：每次播放意图都重新取址，不得恢复意图发生前的预取。
4. Android：指针松手提交后短时间内忽略原生 range 的 `onChange`，每次拖动只产生一条 seek。

## 验收标准

- 本任务单独验收：各入口（封面/换剧/选集）取地址 P50/P95 下降；Android 快进“50ms 内被替换”比例接近 0。
- 总目标验收（含 Stream 部分）：生产 Android/iOS 连续 7 天起播、无缓冲快进 P95 ≤3s。
- 回滚只需回退前端，GET 一直保留。

## 不做

Stream AB、转码与关键帧、API 部署区域、自动播放被拦截、Bunny 复盘；意图前预取下一集/下一部；首页 `direct` 首次预检；签名缓存命中率；`drama-player.tsx`、`dramas/page.tsx` 不改（均在超长基线）。
