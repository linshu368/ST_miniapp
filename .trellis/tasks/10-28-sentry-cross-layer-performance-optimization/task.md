# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status  | Task                                                                         | Files / Scope                                                            | Depends On           | Verification                                                  |
| --- | ------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------- |
| T1  | Todo    | 固化生产基线与阶段指标，修复 drama 原始错误 cause                            | Sentry/Pino、backend perf metrics、drama repository/route                | -                    | 固定查询窗口可复现；敏感字段检查；相关现有测试                |
| T2  | Todo    | 导航 epoch、取消传播和单层重试                                               | frontend API client、query client、entry phase、request concurrency      | T1                   | frontend typecheck/test/lint/build；导航取消人工场景          |
| T3  | Todo    | 短剧全链路 waterfall/媒体/渲染排查，首屏并行化与 telemetry 隔离              | frontend drama、backend drama/telemetry、shared drama contract（如需要） | T1,T2                | 冷/热/弱网/取消、first-frame；大厅无短剧 API/chunk/媒体残留   |
| T4  | Todo    | Characters/Profile/Chat 次要请求分波和动态加载                               | frontend pages/components/api hooks                                      | T2                   | 现有 UI tests + 移动端人工回归                                |
| T5  | Todo    | 影像广场 waterfall、批量签名、投影、缓存和媒体加载优化                       | backend image plaza、frontend create、shared contract（如需要）          | T1,T2                | 分阶段 P95、签名计数、媒体字节、离开页面取消                  |
| T5A | Todo    | 大厅加载隔离与短剧/影像优化非回归门禁                                        | frontend root providers、characters、request concurrency、UI fixtures    | T2,T3,T5             | 大厅冷启动/返回；请求数、字节、长任务、导航 P95 回退不超过 5% |
| T6  | Blocked | 2026-10-29 整体复盘 first-token 24 小时数据并取得继续/停止决定；此前只读观察 | Sentry/Railway/Supabase 只读证据                                         | T1、等待用户复盘确认 | 样本量、观察时长、delivery failure 与可见 P95 记录            |
| T7  | Blocked | 仅在 T6 复盘后获用户明确批准时实施 GenerationConfigSnapshot 与终态收口       | generation feature、runtime config、conversation route                   | T6、用户明确批准     | generation 现有测试；计费/额度/CAS/取消矩阵；真实 SSE smoke   |
| T8  | Todo    | Text postprocess immutable cache 与 miss 批读                                | backend text-postprocess                                                 | T1                   | warm/miss/unavailable 测试与耗时指标                          |
| T9  | Todo    | DB 候选计划验证；仅在证据通过时创建独立 migration                            | Supabase TEST/Production 只读计划、shared migrations                     | T1,T5,T7             | shape、ACL/RLS、EXPLAIN、锁/容量、回滚记录                    |
| T10 | Todo    | 分批发布、24 小时对照、模块知识与收尾                                        | Railway/Sentry/Supabase、Trellis module updates                          | T2-T9                | 所有验收命令、生产对照和回滚记录                              |

## Execution Log

- 2026-10-28：根据 Sentry、Railway、Supabase 生产只读证据创建任务；状态保持 planning，未修改产品代码。
- 2026-10-28：用户要求 first-token 相关内容暂不修改，等待 2026-10-29 整体复盘；T6/T7 标记 Blocked，期间只允许只读指标采集。
- 2026-10-28：补充短剧与影像广场专项加载排查，并将 `/characters` 与根启动链路设为独立非回归门禁；仍处于 planning，未写产品代码。
