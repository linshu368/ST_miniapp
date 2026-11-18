# 优化 Android 与 iOS 图片广场媒体加载性能

## Goal

依据 `D:/JobExe/ST/sentry/2026-11/2026-10-26 至 2026-11-01 周性能报告.md`，在保持图片广场生成、分享、下载、播放、筛选、翻页和历史返回完整性的前提下，降低 Android/iOS `/create` 与 `/create/studio/:conversationId` 的可避免前端长尾，使页面导航和首个关键媒体可见 P95 分平台稳定低于 3 秒。

## Requirements

- `/create` 必须按平台有界挂载首批作品并随接近列表尾部渐进补齐；触底翻页、搜索、标签、媒体类型、排序、下拉刷新、点赞、详情、用同款及返回定位语义不得变化。
- 广场列表继续只展示视频 poster，不在列表加载视频正文；图片和 poster 使用现有 Supabase public transformation，外部 URL 原样回退，转换图失败时必须回退原地址。
- 首屏最多两张图片 eager，只有第一张 high priority；其余媒体 lazy，图片失败需显示稳定占位而不是永久骨架。
- `/create/studio/:conversationId` 保留完整消息历史、图片生成、失败重试、封面回流、分享、保存、视频编辑/重生成/下载/播放功能；历史视频只在接近视口或用户明确点击后绑定真实 `video_url`，不得自动播放或中断已开始播放的视频。
- Studio 图片显示使用有界响应式规格，保存、打开原图、分享和作为参考图仍使用原始 artifact URL；转换失败回退原图。
- `page.ready` 继续表达数据和交互就绪；新增/接通 `page.critical_visual` 表达首批 poster/图片真正 load/error/absent，视频生成完成时间不计入页面加载 P95。
- 标签计数、模型配置和入口 Feed 预热只能在首屏关键工作后执行，并继续遵守前台、在线、Save-Data、2G/slow-2G 门禁；用户主动开始创作仍立即预取配置，不被后台门禁阻断。
- 不修改 Backend、shared DTO、数据库、计费、生成状态机、视频签名/Range、服务端排序或每页数量；不新增依赖。
- production 结论必须按 `tg_platform=android|ios`、release 和样本门槛分别判断；本地通过不能宣称线上达标。

## Acceptance Criteria

- [x] Android、iOS、unknown 均有确定且有界的图片广场首批/批次/rootMargin、图片优先级和视频近视口激活策略；`android_x` 归 Android。
- [x] `/create` 冷进入首批最多挂载平台预算数量，接近尾部先补齐本地已有作品，再获取下一页；返回页面仍能恢复已浏览锚点且不因预算卸载已显示内容。
- [x] 首个关键 poster/图片结算后记录 `/create` critical visual；无作品、无预览、加载失败均有明确终态，监控失败不影响 UI。
- [x] 列表及 Studio 图片使用有限 `srcset`/尺寸，非 Supabase URL 不改写，转换失败回退原 URL；原图下载、分享、封面和视频参考功能保持原地址。
- [x] Studio 历史视频在接近视口或点击“播放视频”前不绑定 MP4；激活后保留原生 controls、playsInline、metadata preload、下载、分享、编辑和重生成。
- [x] Studio 空会话、非媒体终态和最新可见媒体均能结算 critical visual；现有 `image.display.duration` 仍只统计最新生成图片真正显示。
- [x] `/creation` 在首屏工作结束且网络允许时预热默认图片广场 Feed；失败静默，进入 `/create` 仍由现有 query 正常重试。
- [x] 既有 mobile policy/supabase image/API 测试、Frontend typecheck/test/lint/build 及 `pnpm test:ui --grep @image` 通过；记录真实 Android/iOS Telegram 验收待办。

## Android/iOS 性能 P95 门禁

- 受影响页面：`/creation`（仅后台预热，不得回退）、`/create`、`/create/studio/:conversationId`。
- 受影响接口：`GET /api/image-plaza/feed`、`GET /api/image-plaza/feed/tag-counts`、`GET /api/image-plaza/config`、`GET /api/image-plaza/conversations/:id?include_video=1`、`GET /api/image-plaza/video-attempts/:id`；本任务不改接口实现或契约，只调整客户端并发时机。
- Android 页面加载 P95：`/creation` 基线 3030 ms、Studio 基线 4960 ms；`/create` 无可见样本。目标导航与 critical visual 均 `<3000 ms`。
- iOS 页面加载 P95：`/creation` 基线 2140 ms、Studio 基线 1840 ms（25 个低样本）；`/create` 无可见样本。目标导航与 critical visual 均 `<3000 ms`。
- 接口 P95：Feed 周内峰值 3219 ms、最近 418 ms 但仅 5 个样本；目标普通图片广场接口 P95 `<2000 ms`，其中 Feed 稳态优先 `<1000 ms`。其余接口无可见样本，发布后补采，不补零。
- 数据来源与观测窗口：production Sentry 整窗，2026-10-26 至 2026-11-01；Grafana Android/iOS 图片广场细分无可见样本。
- 发布后验证：每个平台每页面有效样本/估算计数 `>=100`，连续两个完整观察窗达标；count `<100` 标低样本，`<20` 标极低样本。视频 poster/首帧、metadata/first frame、完整生成耗时分开，禁止把完整视频生成或连接时长算页面 P95。

## Notes

- 周报显示 Studio 10 月 30、31 日导航 P95 分别 10.53s、8.72s，11 月 1 日恢复到 3.46s，但尚未稳定低于 3 秒。
- 本轮通过前端资源调度和真实关键视觉观测降低可避免成本；接口服务端 P95 是否改善必须上线后验证，不能从本地实现推断。
- 用户要求严格保证体验和功能完整性；因此不做 Studio 历史截断、不改变视频生成/播放业务状态，也不引入全局单播放器强制互斥。
- 按用户既有要求，完成实现和验证后自动 `archive --no-commit`；不自动 commit 或 push。
