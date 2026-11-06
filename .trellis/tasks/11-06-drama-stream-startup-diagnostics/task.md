# Task Breakdown

| ID  | Status | Task                                      | Files / Scope                                                               | Depends On | Verification                                                                   |
| --- | ------ | ----------------------------------------- | --------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------ |
| T1  | Done   | 诊断 schema 增加 `kind` 与 `hls`          | shared/api/drama-timing.ts                                                  | -          | shared 测试                                                                    |
| T2  | Done   | 实验组诊断全量写入 Loki                   | backend/lib/engineering-observability.ts                                    | T1         | engineering-observability.test.ts                                              |
| T3  | Done   | Stream 域名 preconnect（布局 + 播放意图） | drama-stream-origin.ts、layout.tsx、api/drama.ts                            | -          | drama-stream-origin.test.ts、构建产物检查                                      |
| T4  | Done   | Stream 子请求资源计时与分类               | perf/drama-resources.ts                                                     | T1         | drama-media.test.ts                                                            |
| T5  | Done   | hls.js 加载统计记录与接线                 | perf/drama-hls.ts、drama-media-source.ts、drama-timing.ts、drama-player.tsx | T1         | drama-hls.test.ts、drama-media-source.test.ts                                  |
| T6  | Done   | 文档与 Vercel 变量                        | README、ARCHITECTURE、drama-experience.md                                   | T3         | Vercel production/preview/dev 已配置                                           |
| T7  | Todo   | 上线核验                                  | 后端先于前端部署                                                            | T1–T6      | Loki 中 Stream 快样本、`kind`、`diagnostics.hls`；iOS 主清单中位耗时对比 1.13s |

## Execution Log

- 2026-11-06：T1–T6 完成；`pnpm -r typecheck`、前端 727 / shared 207 / 后端相关 22 个测试、frontend lint、complexity check、frontend build 通过。
