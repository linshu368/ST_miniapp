# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                           | Files / Scope                                                            | Depends On | Verification                                                          |
| --- | ------ | -------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------- |
| T1  | Todo   | 固化生产基线与阶段指标，修复 drama 原始错误 cause              | Sentry/Pino、backend perf metrics、drama repository/route                | -          | 固定查询窗口可复现；敏感字段检查；相关现有测试                        |
| T2  | Todo   | 导航 epoch、取消传播和单层重试                                 | frontend API client、query client、entry phase、request concurrency      | T1         | frontend typecheck/test/lint/build；导航取消人工场景                  |
| T3  | Todo   | 戏剧首屏并行化与 telemetry 隔离                                | frontend drama、backend drama/telemetry、shared drama contract（如需要） | T1,T2      | drama UI 流程、first-frame 指标、telemetry accepted/dropped/persisted |
| T4  | Todo   | Characters/Profile/Chat 次要请求分波和动态加载                 | frontend pages/components/api hooks                                      | T2         | 现有 UI tests + 移动端人工回归                                        |
| T5  | Todo   | 图片广场批量签名、投影、缓存和资源优化                         | backend image plaza、frontend create、shared contract（如需要）          | T1,T2      | feed 调用计数、P95、frontend/backend 验证                             |
| T6  | Todo   | 完成 first-token 24 小时观察门禁并作出继续/停止决定            | Sentry/Railway/Supabase 只读证据                                         | T1         | 样本量、观察时长、delivery failure 与可见 P95 记录                    |
| T7  | Todo   | 在 T6 通过且仍有收益时实施 GenerationConfigSnapshot 与终态收口 | generation feature、runtime config、conversation route                   | T6         | generation 现有测试；计费/额度/CAS/取消矩阵；真实 SSE smoke           |
| T8  | Todo   | Text postprocess immutable cache 与 miss 批读                  | backend text-postprocess                                                 | T1         | warm/miss/unavailable 测试与耗时指标                                  |
| T9  | Todo   | DB 候选计划验证；仅在证据通过时创建独立 migration              | Supabase TEST/Production 只读计划、shared migrations                     | T1,T5,T7   | shape、ACL/RLS、EXPLAIN、锁/容量、回滚记录                            |
| T10 | Todo   | 分批发布、24 小时对照、模块知识与收尾                          | Railway/Sentry/Supabase、Trellis module updates                          | T2-T9      | 所有验收命令、生产对照和回滚记录                                      |

## Execution Log

- 2026-10-28：根据 Sentry、Railway、Supabase 生产只读证据创建任务；状态保持 planning，未修改产品代码。
