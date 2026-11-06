# 治理 Android 五入口公共导航长尾

## Goal

降低 Android / Android X 在五个一级入口之间 SPA 切换时的公共 P95 长尾，避免目标页面可见前由路由预热、未读、设置和 Profile 次级读取争抢网络与主线程；iOS 行为、业务数据语义和接口超时保持不变。

## Requirements

- 仅修改 Frontend 公共导航调度及配套文档，不修改 Backend、shared 契约、数据库、页面视觉或业务结果。
- Android 五入口有效点击开始后进入有界导航安静窗口；目标页面 content ready/failed 后，经绘制与空闲机会恢复非关键工作；页面未结算时必须有超时兜底，不能永久饿死后台任务。
- 导航安静窗口必须独立于 Sentry/Grafana 是否启用，不得把功能调度绑定到遥测开关。
- Android 后台 route chunk 预热从每轮最多两个收紧为一个；iOS 与普通浏览器继续沿用现有最多两个。
- Android 明确 intent 只保留会影响 content ready 的角色主查询预取；Profile 钱包、Creation 收藏等非 content-ready 查询不得在 touch intent 的极短提前量内与目标 route chunk 竞争。
- Profile 钱包保持立即读取；未读、客服、设置、签到、VIP、套餐、邀请、社群等次级读取在安静窗口结束后再按现有首帧/近视口条件执行。
- 现有 `page.navigation`、ready、terminal、stall 和 API timing 定义不变；不得为了改善 P95 提前或删除 ready 终点，也不得把等待时间填零。
- 调度异常必须安全降级，不能阻止导航、关键查询、用户主动操作或页面错误恢复。
- 输出修改清单与发布后 P95 验证说明；不把本地测试结果写成生产已达标。

## Acceptance Criteria

- [ ] Android 五入口点击后，非关键 route 预热和 Profile 次级读取在 content ready/failed 前不启动；4 秒内未结算时自动恢复。
- [ ] content ready/failed 后至少经过一次可绘制机会再恢复后台工作，重复导航和重复 ready 不会泄漏 timer/listener 或错误释放新导航。
- [ ] Android 后台 route 预热最多一个，iOS/other 仍最多两个；iOS 不启用导航安静窗口。
- [ ] Profile 钱包和 Characters 主列表等 P0 不被安静窗口阻塞，用户主动交互请求不被延后。
- [ ] 既有与新增回归覆盖平台隔离、超时兜底、过期 release、后台恢复与预热数量。
- [ ] Frontend typecheck、test、lint、build、complexity 和 `git diff --check` 通过；适用 UI 回归执行或记录无法执行原因。
- [ ] 发布后按 release/platform/route 验证 Android P95、2 秒达标率、terminal/stall 和 API 请求量，iOS 与普通请求 P95 不回退超过 5%。

## Android/iOS 性能 P95 门禁

- 受影响页面：`/watch`（历史看板部分窗口显示为 `/`）、`/dramas`、`/characters`（含底栏恢复 `/chats`）、`/creation`、`/profile`。
- 受影响接口：通知/客服未读、settings、签到、VIP、套餐、邀请和社群的发起时机；接口契约、服务端处理与 timeout 不变。
- Android 页面加载 P95：7d 总体基线 4067.06 ms / 目标 2000 ms；其中 `/profile` 5278.4 ms 是重点。
- iOS 页面加载 P95：7d 总体基线 2078.4 ms / 目标 2000 ms；本任务不启用 iOS 专项调度，并以同 release 不回退超过 5% 为保护线。
- 接口 P95：相关次级读取已见最慢 Android 约 6304 ms / 工程目标 2000 ms；本任务只减少导航期 queue 竞争，不宣称解决服务端接口本身长尾。
- 数据来源与观测窗口：Grafana Cloud production 五入口 `page.navigation` 和 `engineering_v1 api.total`，2026-10-29 至 2026-11-05（7d）。
- 发布后验证：同 release 连续两个完整 24h，按 Android/iOS 与 route 分组；每组 N<100 延长至 7d 并标记低样本，不补零。联合检查 2 秒率、terminal/stall、API queue/total 和请求量。

规划完成后同步填写 `task.json.meta.mobile_performance`：有影响使用 `required`，确实不影响移动端页面加载和接口性能时使用 `not_applicable` 并填写具体理由。门禁未完成时 `task.py start` 会阻断。

## Notes

- 用户已明确要求开始处理优化，无需再次请求实施授权。
- 这是调度与性能口径相关的高风险改动，规划确认在现有测试体系内增加/扩展回归用例，不引入新测试框架。
