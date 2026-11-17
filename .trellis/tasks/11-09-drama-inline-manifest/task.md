# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                      | Files / Scope                                                                                                    | Depends On | Verification                                                   |
| --- | ------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| T1  | Done   | shared 契约字段           | `shared/src/api/drama.ts`                                                                                        | -          | `pnpm --filter @miniapp/shared typecheck`                      |
| T2  | Done   | 后端主清单缓存            | `backend/src/features/drama/stream-manifest-cache.ts`（新）                                                      | -          | `stream-manifest-cache.test.ts`（10 条）                       |
| T3  | Done   | 接线 `/play`              | `backend/src/routes/drama-play.ts`、`drama.ts`、`engineering-observability.ts`                                   | T2         | `drama-play.test.ts`（5 条）                                   |
| T4  | Done   | 前端自定义 pLoader        | `frontend/src/lib/drama-inline-manifest-loader.ts`（新）                                                         | T1         | `drama-inline-manifest-loader.test.ts`（7 条）                 |
| T5  | Done   | 接线 `loadDramaSource`    | `frontend/src/lib/drama-media-source.ts`                                                                         | T4         | `drama-media-source.test.ts` 补 2 条                           |
| T6  | Done   | 诊断字段 `manifestInline` | `shared/src/api/drama-timing.ts`、`frontend/src/lib/perf/drama-hls.ts`、`drama-player.tsx`                       | T1         | `drama-timing.test.ts`（新 4 条）、`drama-hls.test.ts` 补 2 条 |
| T7  | Done   | 复杂度预算修复            | 拆 `createDramaPlayHandler`（`sendStreamPlayback`）、拆 `recordHlsLoads`（`loadTimingFields`/`loadLevelFields`） | T3, T6     | `pnpm lint:complexity`                                         |

## Execution Log

- 2026-11-09 阶段一只读验证：用生产签名配置确认主清单内容与 token 无关、路径重写后鉴权通过、边缘不缓存主清单/子清单、子清单因分片级签名跨 token 不同、CORS 只暴露 `cf-ray`。结论支持本批实现，子清单内联维持暂缓。
- 2026-11-09 规划评审：诊断标记方式从"隐性留白"改为显式 `manifestInline` 字段（用户确认接受跨契约文件改动）；测试范围确认为 4 个新文件。
- 2026-11-09 实现：按 implement.md 顺序完成 T1-T6；写 `stream-manifest-cache.test.ts` 时发现并修复一个真实 bug——大小上限原来只在默认拉取函数里校验，不是缓存层通用职责，换个拉取函数就绕过去了。
- 2026-11-09 验证：`pnpm -r typecheck` 全通过；shared/backend/frontend 新增与既有相关测试全通过；`pnpm lint:complexity` 发现 `createDramaPlayHandler`（124/120 行）和 `recordHlsLoads`（127/120 行）两处新增超标，拆分后通过（T7）；frontend `build`/`lint` 通过，遗留警告均为改动前已存在。
- 未做：PRD 验收里"本地/预览环境连续两次 `/play` 确认 `manifest_cache=hit`"的人工验证，需要真实 Stream 白名单视频和本地环境，留给发布前/发布后核对。
