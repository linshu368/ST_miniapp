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

## 2026-11-06 Android WebView 第二阶段

### 新证据与范围

- 生产当前 release `a6fe0ee0bc250b4119e4732abcbbdad441cd39df` 的近 72 小时 Sentry 数据显示：`/characters` Android `page.data_fresh` P95 为 6782.35ms，`/api/lobby-characters` 客户端 P95 为 4195.615ms；Railway 同期 `/api/characters` 分桶最慢 P95 为 1471ms，CPU/内存没有容量饱和。
- `/profile` Android mount 后 shell ready P95 仅 29.44ms，但代表 trace 的路由提交前脚本可达数秒；wallet 在 Railway 最慢分桶 P95 142ms。一次 Android trace 中 wallet 与 unread 同时记录约 158 秒客户端超时，说明 WebView 冻结/恢复会把无关请求一起拖长，不能解释为两个后端同时变慢。
- Grafana MCP 当前因 OAuth 未授权无法读取新窗口；旧 Grafana 基线保留为发布前基线，连接恢复后必须按同 release 补跑，不能把 Sentry mount→ready 与 Grafana click→content-ready 混算。

### 新增要求

- 自动推荐继续在 450ms 启动公共首屏 hedge，确保个人批次不阻塞 2 秒内容目标；原个人请求允许在 5 秒有界预算内完成并只写入下一次缓存，不能为追求当前指标中止幂等请求而丢失迟到批次。手动“换一批/撤回”继续保留 5 秒预算。
- Android/Android X 的角色目录关键读取使用 1.8 秒客户端预算；iOS/other 保持既有 20 秒默认预算。预算覆盖请求槽排队、网络、响应体解析与契约校验；超时只结束当前读取，不自动重试写请求。
- “最新”公共目录沿用 Backend 已声明的 60 秒公共缓存语义：同源代理只透传安全的公共缓存头，推荐/指定 ID 继续 `no-store`，不得缓存个人推荐批次。
- 为无指定 ID 的公共推荐首屏使用独立持久快照；它不能覆盖完整目录缓存，也不能用于指定 ID 校准。命中时先显示快照、后台校准，失败保留原 error/retry 语义。
- `/profile` 首屏继续只保证身份、钱包占位和主要入口；VIP 入口等非关键代码只在 Android 导航安静窗口释放后加载，避免目标路由 chunk 与次级组件 chunk 同时下载/解析。用户可主动点击的消息、充值、客服入口不能被该延后阻断。

### 第二阶段验收

- [ ] Android 自动推荐在 450ms 启动公共/持久首屏 hedge，迟到个人批次不替换当前列表但可供下次复用；手动换批仍有 5 秒预算。
- [ ] Android 角色目录请求总预算为 1.8 秒；iOS/other 仍为 20 秒；调用方取消不误报为 timeout。
- [ ] `latest` 代理响应保留公共 60 秒缓存，`recommended`、指定 ID、错误响应均为 `no-store`。
- [ ] 公共推荐首屏快照与完整目录使用不同 key；损坏、过期、隐私模式安全降级，不能把部分首屏写成完整目录。
- [ ] Profile 非关键动态代码在 `secondaryReadsReady` 前不挂载，基础身份、余额、充值、消息和客服入口仍可操作。
- [ ] 发布门禁按 `/characters`、`/profile` × Android × 同一 release：前台有效 `content_ready` P95 ≤ 2000ms、2 秒达标率 ≥95%、每组 N≥100；同时检查 p99、terminal/stall/error/page_left 与 API 请求量。连续两个完整 24h 窗口均满足才宣称稳定达标，N 不足延长到 7d。
- [ ] 物理断网、系统冻结和后台时间不承诺成功内容必达 2 秒；这些样本必须单列，且前台计时器可运行时需在预算内显示缓存或明确失败，恢复前台不得产生请求齐射。
