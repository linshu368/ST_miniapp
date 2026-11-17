# Task Breakdown

| ID  | Status  | Task                                         | Files / Scope                                           | Depends On | Verification                             |
| --- | ------- | -------------------------------------------- | ------------------------------------------------------- | ---------- | ---------------------------------------- |
| T0  | Done    | 准备：拉取 main、分支、登记性能基线、start   | task.json                                               | -          | `task.py start` 通过                     |
| T1  | Done    | shared 契约 DramaPlayRequestSchema           | packages/shared/src/api/drama.ts                        | T0         | shared test + typecheck                  |
| T2  | Done    | 抽出 /play 处理，注册 POST                   | backend routes/drama-play.ts, routes/drama.ts           | T1         | backend typecheck/test，complexity check |
| T3  | Done    | 前端 POST + 意图表 + 封面触发 + 单测         | frontend lib/api/drama.ts(+test)                        | T1         | frontend typecheck/test                  |
| T4  | Done    | 详情页换剧点击即发意图                       | dramas/[id]/page.tsx                                    | T3         | typecheck + @drama                       |
| T5  | Done    | 拆 use-drama-scrub，加 500ms onChange 忽略窗 | components/drama/drama-progress.tsx, use-drama-scrub.ts | T0         | @drama 无回归                            |
| T6  | Done    | UI 回归：松手只提交一次                      | ui-tests/tests/drama.spec.ts                            | T5         | pnpm test:ui --grep @drama               |
| T7  | Done    | 文档同步 + complexity update                 | docs/drama-playback-timing.md, spec drama-experience.md | T2-T6      | complexity-budget check                  |
| T8  | Blocked | TEST 真机验证（需确认 Android 机）           | -                                                       | T7         | 日志每次拖动仅一条 seek                  |
| T9  | Todo    | 发布（先后端后前端，需用户同意）             | -                                                       | T8         | 3–7 天观察                               |

## Execution Log

- 2026-11-04：main 快进到 1df9d3ce，建分支，规划文档完成。
- 2026-11-04：T1–T7 完成并验证：shared 197、backend 1326、frontend 705 单测通过；`pnpm -r typecheck`（frontend 重新 build 后）、lint、frontend build、`@drama` UI 44 项（android+narrow）、fixtures 自检通过；complexity 基线收紧（dramaRoutes 179→123，DramaProgress 移出基线）。新增断言已验证：忽略窗置 0 时写入 `[2.5275, 2.5]`，置 500 时仅 1 次。
- 方案外新增（待用户确认）：apiClient `idempotent` 开关（POST /play 保留传输层重试）；`apiRouteGroup` 把 `/api/dramas/play` 归 `drama_playback`；`mobile_performance.api.p95_target_ms=1500` 为占位目标。
- 阻塞：T8 需要先向用户确认 Android 测试机；`module_knowledge.py check/baseline-check` 因存量文档 `admin-client-auth.md` 路径通配报错，与本任务无关，drama-experience.md 已直接写入。
