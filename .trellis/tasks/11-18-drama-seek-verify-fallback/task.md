# Task Breakdown

| ID  | Status | Task                                       | Files / Scope                                         | Depends On | Verification                          |
| --- | ------ | ------------------------------------------ | ----------------------------------------------------- | ---------- | ------------------------------------- |
| T1  | Done   | 抽出 buildSeekReport，接入 timeupdate 兜底 | lib/perf/drama-seek.ts                                | -          | typecheck、complexity check           |
| T2  | Done   | 扩展快进判定单测（待拍板）                 | lib/perf/drama-seek-diagnostics.test.ts               | T1         | vitest                                |
| T3  | Done   | spec 补兜底规则，complexity update         | drama-experience.md、scripts/complexity-baseline.json | T1         | complexity check                      |
| T4  | Todo   | PR → 合并 → 部署确认 → 3–7 天复算          | -                                                     | T1–T3      | iOS 漏判样本、first_frame_method 分布 |

## Execution Log

- 2026-11-18：抽出 `buildSeekReport`/`seekDirection`，`observeDramaSeek` 324→315 行，基线已收紧；新增 `createProgressFallback` 并接入 timeupdate 分支；单测 +4 例，`src/lib/perf` 14 个文件 308 例通过；frontend typecheck、lint（仅存量警告）、complexity check 通过。未提交，等待用户同意后开 PR。
