# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                           | Files / Scope                       | Depends On | Verification                 |
| --- | ------ | ---------------------------------------------- | ----------------------------------- | ---------- | ---------------------------- |
| T1  | Done   | 建立并测试分平台性能策略                       | env-tags、mobile-performance        | -          | focused Vitest 6/6           |
| T2  | Done   | 优化 Android/iOS 角色与短剧列表挂载/图片优先级 | character gallery/card、dramas page | T1         | typecheck、roleplay/drama UI |
| T3  | Done   | 首页海报先可见、媒体继续异步 ready             | drama-player                        | T1         | @drama 相关 44 项覆盖        |
| T4  | Done   | 重排 Android/iOS 后台路由预取                  | bottom-nav、background prefetch     | T1         | navigation/startup UI        |
| T5  | Done   | 完整验证、模块影响复核与自动归档               | frontend、ui-tests、Trellis         | T1–T4      | test/lint/build/UI           |

## Execution Log

- 2026-11-02：完成周报、现有代码、复用点、可靠性、回滚和生产验收口径调研；尚未修改产品代码。
- 2026-11-02：实现分平台策略、首页关键海报、列表预算/图片优先级和平台路由预取；Frontend 725 项测试、lint、build 通过。
- 2026-11-02：更新既有 UI 验收以适配真实分批挂载；`@navigation` 2/2、`@startup` 7/7、`@roleplay` 失败项复跑 2/2、`@drama` 失败项复跑 2/2 通过。完整 drama 首轮 42/44，其余两项仅为旧脚本直接定位未挂载末项，修正后通过。
- 2026-11-02：模块影响复核为 `no_module_change`；资源调度参数不改变模块边界，production P95 待发布后按平台复核。
