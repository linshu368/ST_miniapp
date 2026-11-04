# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                                                    | Files / Scope                                                                               | Depends On | Verification                                 |
| --- | ------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------- |
| T1  | Todo   | 视频流移到 `/watch`，`/` 307 到 `/characters`                                           | `app/(main)/watch/page.tsx`、`next.config.mjs`                                              | -          | build；本地 `curl -I /` 看 Location 与 query |
| T2  | Todo   | 底栏顺序与高亮、预取、启动骨架                                                          | `components/nav/*`、`lib/mobile-performance.ts`                                             | T1         | typecheck；preview 点各 tab                  |
| T3  | Todo   | `/` 字面量改 `/watch`（布局、短剧库/详情链接、查询隔离、计时与页面埋点、early-startup） | `app/(main)/layout.tsx`、`dramas/page.tsx`、`components/drama/*`、`lib/api/*`、`lib/perf/*` | T1         | 相关 vitest                                  |
| T4  | Todo   | 仓库看板与 spec 同步                                                                    | `docs/grafana/st-five-route-navigation-ready.json`、`.trellis/spec/frontend/app/*`          | T3         | 人工核对                                     |
| T5  | Todo   | 验证                                                                                    | frontend typecheck/test/lint/build；`pnpm test:ui` 相关分组                                 | T1-T4      | 命令输出                                     |
| T6  | Todo   | TEST 真机冷启动（Android/iOS）                                                          | 部署后                                                                                      | T5         | 人工                                         |

## Execution Log

- 2026-11-04：用户确认中间位按数据定（角色大厅）、首屏在代码中实现。
