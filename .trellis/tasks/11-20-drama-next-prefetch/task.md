# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                          | Files / Scope                                                   | Depends On | Verification            |
| --- | ------ | ----------------------------- | --------------------------------------------------------------- | ---------- | ----------------------- |
| T1  | Todo   | 预取来源枚举                  | packages/shared/src/api/drama-timing-hls.ts                     | -          | shared test + typecheck |
| T2  | Todo   | 已迁移 Stream 视频带 delivery | packages/backend/src/routes/drama-play.ts                       | -          | drama-timing.test.ts    |
| T3  | Todo   | 预加载同时预取地址            | packages/frontend/src/lib/api/drama.ts                          | T1         | typecheck               |
| T4  | Todo   | 下一集/下一部预取 hook        | components/drama/use-drama-next-prefetch.ts, drama-player.tsx   | T3         | 单测：键对齐、触发条件  |
| T5  | Todo   | 按下选集预取                  | components/drama/episode-sheet.tsx, drama-player.tsx            | T1         | 人工验证                |
| T6  | Todo   | 规范同步                      | .trellis/spec/frontend/app/modules/business/drama-experience.md | T3–T5      | -                       |
| T7  | Todo   | 全量验证                      | -                                                               | T1–T6      | implement.md 命令       |

## Execution Log

- 2026-11-20：规划完成；基线见 prd.md / task.json。PR1 = T1、T2；PR2 = T3–T7。
