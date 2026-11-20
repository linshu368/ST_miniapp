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
| T1  | Done   | 预取来源枚举                  | packages/shared/src/api/drama-timing-hls.ts                     | -          | shared test + typecheck |
| T2  | Done   | 已迁移 Stream 视频带 delivery | packages/backend/src/routes/drama-play.ts                       | -          | drama-timing.test.ts    |
| T3  | Done   | 预加载同时预取地址            | packages/frontend/src/lib/api/drama.ts                          | T1         | typecheck               |
| T4  | Done   | 下一集/下一部预取 hook        | components/drama/use-drama-next-prefetch.ts, drama-player.tsx   | T3         | 单测：键对齐、触发条件  |
| T5  | Done   | 按下选集预取                  | components/drama/episode-sheet.tsx, drama-player.tsx            | T1         | 人工验证                |
| T6  | Done   | 规范同步                      | .trellis/spec/frontend/app/modules/business/drama-experience.md | T3–T5      | -                       |
| T7  | Doing  | 全量验证                      | -                                                               | T1–T6      | implement.md 命令       |

## Execution Log

- 2026-11-20：规划完成；基线见 prd.md / task.json。PR1 = T1、T2；PR2 = T3–T7。
- 2026-11-20：PR1（d892f470）完成：shared 测试、后端 drama/telemetry 85/85、`pnpm -r typecheck`、`lint:complexity` 通过。
- 2026-11-20：PR2 实现完成：frontend 918/918、`pnpm -r typecheck`、eslint、frontend build 通过；drama-player.tsx 净减 26 行（基线告警为 main 上既有超标）。`@drama` UI 回归在本机无法运行：fixture 视频 readyState 一直为 0，在不含前端改动的 PR1 提交上同样失败，换系统 Chrome 也一样，属环境问题；改写后的「播放中预取下一集地址不抢播，续播接上缓存」用例未能本地验证。
