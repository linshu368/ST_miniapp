# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status  | Task                                                                      | Files / Scope                       | Depends On | Verification                          |
| --- | ------- | ------------------------------------------------------------------------- | ----------------------------------- | ---------- | ------------------------------------- |
| T1  | Done    | 读取规范、复用链路并采集 7d 生产基线                                      | specs、Grafana Loki、research       | -          | 基线含 route/platform/N 与无样本说明  |
| T2  | Done    | 完成 PRD、设计、执行计划和移动性能门禁                                    | task artifacts                      | T1         | `task.py validate` / `task.py start`  |
| T3  | Done    | 补齐五路由统一就绪语义与 2 秒预算维度                                     | perf tracker、creation、profile     | T2         | 既有 perf tests                       |
| T4  | Done    | 增加导航意图主数据预取和平台优先级；短剧按回归结果仅保留 route chunk 预热 | API hooks、BottomNav、mobile policy | T2         | existing tests/typecheck/UI           |
| T5  | Done    | 增加五路由 Grafana dashboard 与运维文档                                   | docs/grafana                        | T3         | JSON parse + live LogQL review        |
| T6  | Done    | 运行完整验证并更新模块事实                                                | frontend/ui-tests/spec/task         | T3,T4,T5   | typecheck/test/lint/build/UI          |
| T7  | Blocked | 将 dashboard JSON 导入 Grafana Cloud 并按 release 验证生产目标            | Grafana Cloud                       | T5,T6      | 当前连接只读；发布后每路由/平台 N≥100 |
| T8  | Done    | 治理 characters/profile 真实加载与口径长尾                                | gallery、profile、API hooks、perf   | T6         | related tests/typecheck/UI            |
| T9  | Done    | 完整回归并记录二阶段发布边界                                              | frontend/ui-tests/spec/task         | T8         | test/lint/build + mobile UI           |

## Execution Log

- 2026-11-03：完成当前代码链路、Android/iOS 7d 基线、API 聚合基线与缺口审计。
- 2026-11-04：完成五路由 ready/预算维度、平台 route warmup、characters/favorites/wallet intent 预取和 dashboard JSON；Cloud 连接可查询但不可写，在线导入待有写权限的工程师执行。
- 2026-11-04：完整 frontend test 69 files/757 tests、typecheck、lint、build 通过；Android/窄屏五入口导航通过，Android/窄屏充值空态分别通过，Android 剧场布局通过。组合 profile 套件曾出现场景切换抖动，隔离复跑通过。
- 2026-11-04：短剧 intent 数据预取曾令五入口用例稳定停在首批6张卡；移除该分支后 Android/窄屏均通过，因此短剧只保留 route chunk 预热和既有缓存。
- 2026-11-04：结合近7天 Sentry trace 与最近可读 Grafana 窗口追加二阶段长尾治理；Profile 按请求扇出和统计放大叠加处理，Characters 按图片/主线程/非关键请求竞争处理，当前进入实现。
- 2026-11-04：二阶段实现完成。Characters 的会话史/社交/角标等待当前路由关键视觉结算，视觉 timeout 纳入终态，自动推荐1.5秒降级且手动换批仍为5秒；Profile 首帧仅立即读取钱包，签到/VIP/套餐首帧后启动，设置按头像菜单读取，邀请/社区近视口启动，红点由 BottomNav 单一网络 owner 负责。
- 2026-11-04：Frontend typecheck、69 files/768 tests、lint、build 通过；Android 定向角色2项/Profile3项和320px定向3项通过。完整 `@roleplay` 组含18项，首次整组运行超过外层5分钟后终止并清理本工作区残留进程，随后按本轮风险定向复跑通过；iOS 真机及生产 P95 仍需发布后按 release 验证。
- 2026-11-04：最终状态再次通过 lint 与 Android 普通 Profile 场景；lint 仅保留仓库既有 `<img>` 警告。
- 2026-11-04：两次在 UI preview 结束后发现本地 Next 包缺少 `dist/build/webpack-build/impl`；均使用不改锁文件的 `pnpm install --force --frozen-lockfile` 恢复，随后独立 production build 通过。该本地依赖/预览清理异常不归因于页面代码，建议另行排查 preview 在 Windows 的进程关闭行为。
