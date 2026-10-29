# 生产基线与瓶颈证据

## 1. 数据来源与限制

- Sentry：复用仓库内 2026-10-27 至 2026-10-29 已固定的生产快照。当前浏览器未登录该组织，未把无法访问的实时 Sentry 数据伪装为当前事实。
- Railway：2026-10-29 查询 production 项目 `gallant-insight`、服务 `stminiapp`，当前成功部署 commit `98eced4`。
- Grafana：2026-10-29 查询最近 24 小时工程页面和短剧 dashboard，作为当前全量补充证据。
- 结论按 release 和时间窗口使用；Sentry 历史快照与当前 Grafana 不直接混算。

## 2. Sentry 固定基线

| 窗口                         | 页面/事务                |    p95 |         样本 |
| ---------------------------- | ------------------------ | -----: | -----------: |
| 2026-10-27 15:00–10-28 14:28 | 首页 navigation          |  6.27s | 见父任务快照 |
| 同上                         | 首页 pageload            |  9.67s | 见父任务快照 |
| 同上                         | `/characters`            |  4.59s | 见父任务快照 |
| 同上                         | `/dramas`                |  4.37s | 见父任务快照 |
| 2026-10-28 15:00–10-29 15:00 | 首页 navigation          |  8.14s |           40 |
| 同上                         | 首页 pageload            | 28.38s |          180 |
| 同上                         | `/characters` navigation |  5.55s |          340 |

第二个窗口之后已经完成请求取消、一次重试、同请求去重、角色详情/评论懒加载。以上适合作为“优化前”固定基线，不代表当前代码尚未包含这些改动。

## 3. 当前 Grafana 24 小时

### 页面

| 页面/类型           | `page_ready` p95 | 样本 |   `page_fresh` p95 |
| ------------------- | ---------------: | ---: | -----------------: |
| `/` document        |         5713.5ms |   47 |             4921ms |
| `/` SPA             |          29.05ms |    4 | 4921ms（路由汇总） |
| `/characters` SPA   |        2126.46ms |   68 |          4795.19ms |
| `/characters` mount |         136.62ms |   33 |          4795.19ms |
| `/dramas` SPA       |         604.98ms |   36 |          2324.92ms |

首页 first visual document p95 约 5146.8ms，但成功样本仅 4，另有 error/page-left，不能据此宣称稳定结论。三页需要统一的关键视觉口径和更大样本。

### drama API 阶段

- `st_api_total` drama p95 约 4496.5ms。
- stage p95：queue 65.1ms、headers 3446ms、body 440.2ms。
- 成功首尝试 77 次、成功二次尝试 4 次、两次后 aborted 6 次、两次后 http_error 5 次。

长尾主要出现在 dispatch 到 headers，而不是客户端队列；结合 Railway handler p95，需重点验证客户端网络、Railway edge、Telegram WebView、鉴权和重试路径。

### Grafana p95 优化指向

按当前 p95 与目标差距，优先级为：

1. 首页 document/first visual：从约 5.1–5.7 秒降至 2 秒，优先目录缓存、主海报和播放 CDN 链路。
2. drama 客户端 headers：从约 3.45 秒降至 1.5 秒，先定位客户端到响应头链路；queue 仅 65.1ms，不值得优先重构调度器。
3. 角色卡：`page_ready` 只高于目标约 126ms，但 `page_fresh` 高约 2.3 秒；重点隔离后台刷新，不大改已稳定首屏。
4. 短剧广场 SPA：`page_ready` 约 605ms 已达标；主要守住不退化并补关键封面 settled/冷缓存指标。

正式合格线、样本量和失败率约束见 `prd.md` 4.2；本文件保存观测事实，不替代验收规则。

## 4. Railway production

- 最近 24 小时 `/api/dramas` GET 最慢小时 p95 约 1079ms，多数小时约 160–500ms。
- 最近 24 小时 `/api/characters` GET 最慢小时 p95 约 935ms，多数小时约 130–540ms。
- 过去 7 天 characters 曾在 10 月 26 日出现约 30 秒历史尖峰，当前已稳定；作为回归警戒而不是当前常态。
- CPU 平均约 0.0329、峰值约 0.1119；内存平均约 0.2515GB、峰值约 0.4877GB，限制均为 32。没有资源饱和证据。

结论：扩容 Railway 不足以把页面 p95 拉到 2 秒，优先处理缓存、关键媒体和边缘链路。

## 5. 代码与 CDN 现状

- `/` 和 `/dramas` 共用 drama list query，但没有持久化目录缓存；React Query 默认 stale 30 秒、gc 5 分钟。
- `/dramas` 封面使用 Supabase public 原图；前两张 eager/high，其余 lazy/low。
- `/characters` 已有版本化列表缓存、10 张分批渲染和 Supabase 360×480 q68 transformed avatar；首次缓存内容快，后台 freshness 仍慢。
- `/api/lobby-characters` 经同源 Next BFF 代理 Railway，双方 `no-store`；是否直连必须以真机 A/B 决定。
- 首页播放器的 detail/playback 并行，video `preload=auto`；生产 playback 为 Supabase signed URL。
- Bunny 仅在 TEST PR 525、test database/origin 严格门禁下启用，现有 Range/签名功能证据不等于 Telegram 性能收益。

## 6. 构建基线

已有优化后的固定记录：`/` first load 约 281KB，`/characters` 约 254KB。应先量化 JS parse/long task，再决定是否继续拆包，避免把关键播放器延后。
