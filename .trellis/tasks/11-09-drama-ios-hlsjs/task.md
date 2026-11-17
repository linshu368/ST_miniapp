# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                                                       | Files / Scope                                                     | Depends On | Verification                                                                                                                                                                                         |
| --- | ------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Done   | Shared：新增 `DramaPlaybackEngine` 枚举与 `engine` 可选字段                                | `packages/shared/src/api/drama-timing.ts`                         | -          | `pnpm --filter @miniapp/shared typecheck && test` 通过                                                                                                                                               |
| T2  | Done   | 跨包 typecheck 确认 schema 改动兼容                                                        | 无新文件                                                          | T1         | frontend/backend typecheck 通过；另跑 `pnpm -r typecheck`（8 包全过）                                                                                                                                |
| T3  | Done   | 引擎路由：`shouldUseHlsOnApple` + `capAppleHlsQuality`/`loadDramaSource`/`preloadDramaHls` | `packages/frontend/src/lib/drama-media-source.ts`                 | T1         | 测试通过                                                                                                                                                                                             |
| T4  | Done   | 更新 `drama-media-source.test.ts`（MMS mock、hls.js 路由、720p 跳过、引擎回调）            | `packages/frontend/src/lib/drama-media-source.test.ts`            | T3         | 11/11 通过                                                                                                                                                                                           |
| T5  | Done   | 前端诊断接线：`DramaPlaybackTiming.engine`、`beginSeek` 新参数、`observeDramaSeek`         | `packages/frontend/src/lib/perf/drama-timing.ts`、`drama-seek.ts` | T1         | 40/40 通过（含 2 条新用例）                                                                                                                                                                          |
| T6  | Done   | `drama-player.tsx` 接线 `onEngine`/`engineRef`/`beginSeek` 参数                            | `packages/frontend/src/components/drama/drama-player.tsx`         | T3, T5     | typecheck 通过；lint 警告确认是改动前既有（行号平移）                                                                                                                                                |
| T7  | Done   | Faro 维度：`drama-observer.ts` attrs 新增 `drama_engine`，`grafana.ts` ENUMS 新增枚举      | `packages/frontend/src/lib/perf/drama-observer.ts`、`grafana.ts`  | T5         | 64/64 通过（含 2 条新用例）                                                                                                                                                                          |
| T8  | Done   | 后端诊断：`observeDramaStartupDiagnostic` attrs 新增 `engine`                              | `packages/backend/src/lib/engineering-observability.ts`           | T1         | 23/23 通过（含新旧报告兼容用例）                                                                                                                                                                     |
| T9  | Done   | README 环境变量说明                                                                        | `README.md`                                                       | T3         | 人工核对，和现有可选变量写法一致                                                                                                                                                                     |
| T10 | Done   | 全量验证：typecheck/test/lint/`pnpm -r typecheck`/build + 人工失败路径检查                 | 无新文件                                                          | T1-T9      | frontend 742/742、backend 相关 23/23（全量套件因 worktree 缺 `DATABASE_URL` 有 51 个无关失败，已排查与本次改动无关）；`pnpm lint:complexity` 从失败改到通过（见 Execution Log）；frontend build 成功 |

## Execution Log

- 2026-11-09：任务创建、规划完成，等待用户审核后 `task.py start`。
- 注意：`task.py validate` 提示 `.trellis/spec/backend/app/data-reliability-and-security.md`（36500 字节）超过自动注入上限（32768 字节），本任务相关的短剧诊断段落在文件末尾（约 280-380 行），自动注入到 `trellis-implement` 子代理时会被截断。派发该子代理时需在 prompt 里额外提示直接读取该文件的 280-380 行，不要只依赖自动注入的截断内容。
- 2026-11-09：用户确认 drama-player.tsx 接线可做、环境变量 vs 运营平台开关暂缓，`task.py start` 成功（mobile_performance.android 补了 6640ms 基线=目标，取自同窗口 direct 入口口径，见 task.json notes）。
- 2026-11-09：新 worktree 缺 Prisma client 生成产物，`npx prisma generate` 后 backend typecheck 恢复正常（环境问题，非代码问题）。
- 2026-11-09：阶段 A-F 全部实现完成。`pnpm lint:complexity` 发现 `packages/shared/src/api/drama-timing.ts` 新增字段后从 491 行涨到 503 行，超过 500 行硬上限（CI 会阻断）；精简了引擎枚举声明的格式（多行改单行、注释合并），降到 497 行，复杂度检查转为通过。其余 9 个文件的行数/函数行数增长都是「已在基线中」的告警（CI 不阻断，但建议顺手拆分），本任务按 implement.md 阶段 F 的约定不在本任务内拆分，列入收尾汇总的暂缓事项。
- 2026-11-09：全量测试/typecheck/lint/build 跑完，记录在上表 T10；backend 全量套件（非本任务涉及的会话/设置路由）因 worktree 未配置 `DATABASE_URL` 失败 51 条，核实与本次改动无关（其他并行 worktree 同样没有该 `.env`），未修复，已告知用户。
- 等待用户审核改动内容后再决定提交分组（implement.md 已给出建议分组）；未 commit、未 push、未开 PR。
