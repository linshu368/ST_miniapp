# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                        | Files / Scope                                      | Depends On | Verification                              |
| --- | ------ | ----------------------------------------------------------- | -------------------------------------------------- | ---------- | ----------------------------------------- |
| T1  | Done   | 修复合并冲突并恢复可验证基线                                | backend telemetry route/test                       | -          | backend typecheck；19 tests；diff check   |
| T2  | Done   | 固化 Sentry、当前代码、重叠任务和构建体积调研               | report、research、现有 Trellis 任务                | T1         | research 可追溯；frontend build           |
| T3  | Done   | 打通目标 query/代理的取消信号并消除双层重试                 | frontend api client/query hooks、lobby route       | T2         | 现有 client/route tests；取消/重试矩阵    |
| T4  | Done   | 去除 characters 重复订阅、详情请求和图片重复调度            | gallery、recent card、characters API               | T3         | 请求计数；@roleplay；route size           |
| T5  | Done   | 按需加载 chat 默认关闭面板，必要时再拆非首屏媒体操作        | chat page/components                               | T3         | route 90.7k，记录停止继续拆分证据；@chat  |
| T6  | Done   | 按需加载首页评论 UI，保持播放器关键路径不变                 | drama comment context/sheet/layout/player          | T3         | `/` 首载不回退；@drama                    |
| T7  | Done   | 优化 support unread 刷新并补代理阶段日志                    | frontend support hook、backend support route/tests | T3         | 请求计数；阶段日志字段；@profile          |
| T8  | Done   | 验证 messages/regenerate 既有首字与计费链路，不修改竞速语义 | existing conversation/generation tests             | T5         | first-token/fallback/cancel/billing tests |
| T9  | Done   | 全量门禁、差异审计和本地验收                                | frontend/backend/ui-tests                          | T4-T8      | typecheck/test/lint/build/UI/diff check   |
| T10 | Done   | 更新模块知识、实现/验收记录并自动归档                       | Trellis task/spec metadata                         | T9         | task validate；archive --no-commit        |

## Execution Log

- 2026-10-29：创建任务；状态保持 planning，未写产品代码。
- 2026-10-29：按用户要求先解决 telemetry 两处合并冲突；backend typecheck、19 条相关测试与 `git diff --check` 通过。
- 2026-10-29：生产构建通过；基线为 `/` 283 kB、`/characters` 271 kB、`/chat/[characterId]` 396 kB 首载，chat 路由独占 101 kB。
- 2026-10-29：完成复用、可靠性、最小方案、恢复与验证规划；等待规划审核后执行 `task.py start`。
- 2026-10-29：完成请求取消/重试收敛、角色页请求去重、chat/characters/home 可选 UI 拆包和 support 分段耗时日志。
- 2026-10-29：最终构建 `/` 281 kB、`/characters` 254 kB、`/chat/[characterId]` 372 kB 首载；chat 独占 90.7 kB，继续拆分将触碰关键路径，按验收条款停止。
- 2026-10-29：Frontend/Backend/UI 测试通过；全量并发超时/竞速项均隔离复跑通过；`@chat` 8/8、`@drama` 41/41、`@profile` 11/11，roleplay 冷编译失败项预热后通过。
- 2026-10-29：模块知识载荷与 Trellis 基线校验通过，准备自动归档。
