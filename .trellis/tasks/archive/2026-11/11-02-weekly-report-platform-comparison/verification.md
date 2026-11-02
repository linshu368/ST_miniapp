# 验证记录

## 查询口径

- 数据源：Sentry Explore `spans`，环境 `production`，字段 `tg_platform`。
- Android 仅取 `tg_platform=android`，iOS 仅取 `tg_platform=ios`；没有把 OS、SDK platform、桌面端、Web 或 unknown 混入。
- 目标周未发现 `android_x` 可见导航/pageload 样本，报告明确保留缺失状态。
- 逐日查询继续使用原报告七个 48 小时重叠整窗。

## 数据验证

- 七窗联合覆盖期导航计数：Android 9,095、iOS 2,475，样本比例约 3.7:1。
- 新增全站导航逐日平台 P95、核心页面同路由整周期 P95、首页 pageload 逐日平台 P95。
- 核心页面对比使用同一 route，避免仅凭全站路由结构差异归因。
- iOS 小于 100 的 pageload 单元均标记低样本；studio、消息中心等低样本路由也已提示。
- Grafana 已保存日报未保留平台子组且本次看板不可重新读取，因此分平台 Grafana 指标写“无可见样本”，没有补零或用 Sentry 代填。

## 产物

- 更新：`D:\JobExe\ST\sentry\2026-11\2026-10-26 至 2026-11-01 周性能报告.md`
- 原有 Sentry 主表、错误、依赖、SSE 口径和 Grafana 非平台数据未改动。
