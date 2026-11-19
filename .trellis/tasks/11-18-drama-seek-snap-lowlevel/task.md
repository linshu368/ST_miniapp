# Task Breakdown

| ID  | Status | Task                                                              | Files / Scope                          | Depends On | Verification               |
| --- | ------ | ----------------------------------------------------------------- | -------------------------------------- | ---------- | -------------------------- |
| T1  | Done   | createHlsSeekPlanner（snapTarget + pickSeekLevel + 保持强制档位） | lib/drama-hls-seek.ts                  | -          | typecheck                  |
| T2  | Done   | seekPlanners 登记与 prepareDramaSeek                              | lib/drama-media-source.ts              | T1         | typecheck                  |
| T3  | Done   | 两个提交点改用吸附后的目标                                        | use-drama-scrub.ts、drama-progress.tsx | T2         | typecheck、现有测试        |
| T4  | Done   | 单测 8 例（待拍板）                                               | lib/drama-hls-seek.test.ts             | T1         | vitest                     |
| T5  | Done   | 本地 Playwright 限速验证                                          | scratchpad                             | T3         | 请求数、档位回升、恢复耗时 |
| T6  | Todo   | spec 更新；在 verify-fallback 之后发布并复算                      | drama-experience.md                    | T1–T5      | 按版本 7 天对比            |

## Execution Log

- 2026-11-18：实现 createHlsSeekPlanner / prepareDramaSeek 与两个提交点；本地限速复现发现 hls.js 同 sn 换档重下导致弱网恢复后卡顿，加入“保持强制档位到入缓冲”后 0/3；单测 +10 例；frontend vitest 75 文件通过、typecheck、lint（仅存量警告）、complexity check、`pnpm test:ui --grep @drama --project=android` 34/34。未提交，等待用户同意后在 verify-fallback 之后开 PR。
