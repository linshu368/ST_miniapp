# 优化 Android 与 iOS 首页、角色、短剧加载性能

## Goal

依据 `D:/JobExe/ST/sentry/2026-11/2026-10-26 至 2026-11-01 周性能报告.md` 的 production 分平台数据，降低 Android 与 iOS 在首页 `/`、角色发现 `/characters`、短剧列表 `/dramas` 的可避免前端长尾；以各平台各页面 P95 稳定低于 3 秒为发布后目标，同时保留现有播放、筛选、返回恢复和导航语义。

## Requirements

- Android 首页冷启动必须优先展示可用关键视觉，不能把“视频完整可播”作为用户看到首页内容的唯一前提；视频仍应自动播放，失败时保留海报、控件和重试能力。
- iOS 首页与短剧导航应在 P0 页面工作完成后优先预取对应路由；Android 应优先预取角色路由。后台预取仍须遵守离线、Save-Data、2G、后台页等现有限制，且每页最多预取两个目标。
- `/characters` 与 `/dramas` 按平台控制首批挂载量、增量批次和触发距离，减少 Android 角色卡和 iOS 短剧海报的主线程、解码与网络竞争；滚动到底仍必须展示全部条目，返回锚点恢复不得回退。
- 首屏图片只允许真正关键的一张使用 `fetchPriority=high`；同一首行其余图片可 eager，但不得与第一关键视觉同级抢占。角色卡离屏内容应允许浏览器跳过布局/绘制。
- 不修改 Backend、shared 契约、数据库、计费、短剧签名策略或服务端排序，不新增依赖，不以提前结束 Sentry 自动 transaction 代替真实可见内容优化。
- 生产效果必须按 `tg_platform=android|ios` 分别复核；没有足够样本时写“待验证”，不得用本地 fixture 或另一平台结果宣称达标。

## Acceptance Criteria

- [x] Android、iOS、unknown 三类均有确定且有界的渲染/预取策略；`android_x` 按 Android 策略处理，非 Telegram 环境安全回退。
- [x] 首页在视频 `loadeddata` 前即可显示并上报已加载海报；视频可播后移除覆盖层，自动播放、失败、换剧和详情页行为不变。
- [x] `/characters` 首批卡片和 `/dramas` 首批海报按平台预算挂载，首个关键图片为 high，第二张不再 high；触底增量、搜索、筛选及返回滚动恢复通过既有验收。
- [x] 平台路由预取保持串行、P0 后执行、最多两个目标，并继续受网络/可见性保护。
- [x] 平台策略回归测试、Frontend typecheck/test/lint/build 通过；`@roleplay`、`@drama`、`@navigation`、`@startup` 相关现有 UI 验收通过或记录不可运行原因。
- [ ] 发布后以每个平台每页面有效样本/估算计数不少于 100 为判定门槛，连续两个完整观察窗 `/`、`/characters`、`/dramas` 导航/关键视觉 P95 均低于 3 秒；首页视频可播另行观察，不把海报可见冒充完整媒体 ready。

## Notes

- 周报基线：`/` Android 4.37s、iOS 8.20s；`/characters` Android 6.16s、iOS 4.58s；`/dramas` Android 2.54s、iOS 6.29s。首页 pageload Android 6/7 个窗口慢于 iOS，且仍在 14.57–25.40s。
- 本地构建和 fixture 只能验证实现与相对成本，无法证明 production P95；3 秒目标需部署后按 release、平台、样本门槛复核。
- 用户要求任务执行完成后自动归档；不自动 commit 或 push。
