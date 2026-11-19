# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                     | Files / Scope                                                                                               | Depends On | Verification                   |
| --- | ------ | ------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------ |
| T1  | Done   | prefetch 诊断 schema     | packages/shared/src/api/drama-timing.ts                                                                     | -          | shared test + typecheck        |
| T2  | Done   | 主清单解析               | packages/frontend/src/lib/drama-hls-playlist.ts                                                             | -          | 单测                           |
| T3  | Done   | 播放资源缓存与意图迁移   | lib/api/drama-playback.ts, lib/drama-playback-resources.ts, lib/api/drama.ts                                | T2         | 单测：过期、重试绕过、意图复用 |
| T4  | Done   | loader 命中与回写、usage | lib/drama-inline-manifest-loader.ts, lib/drama-media-source.ts                                              | T3         | 单测：按 URL 命中、不匹配透传  |
| T5  | Done   | 诊断透传                 | lib/perf/drama-hls.ts                                                                                       | T1, T4     | typecheck                      |
| T6  | Done   | 片库可见封面、按下封面   | hooks/use-drama-playback-warmup.ts, components/drama/drama-theater-cards.tsx, stores/drama-library-store.ts | T3         | 人工验证（待 preview）         |
| T7  | Done   | 全量验证                 | -                                                                                                           | T1–T6      | implement.md 命令              |

## Execution Log

- 2026-11-18：规划完成；基线见 prd.md / task.json。
- 2026-11-18：实现完成。验证：shared 244/244、frontend 856/856、backend 短剧与 telemetry 91/91 通过；`pnpm -r typecheck` 0 错误；`lint:complexity` 通过（shared drama-timing.ts 加字段后 516 行，拆出 drama-timing-hls.ts 后 471 行）；frontend build 通过。backend 全量另有 52 个用例因本 worktree 无 DATABASE_URL/SUPABASE 环境变量失败，与本次无关。
- 未做：preview 环境人工验证（implement.md 清单），需要真实 Stream 白名单视频；主清单解析未用真实 Stream 清单核对（本机无生产签名配置）。
