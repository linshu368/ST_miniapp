# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                             | Files / Scope                                          | Depends On | Verification                       |
| --- | ------ | -------------------------------- | ------------------------------------------------------ | ---------- | ---------------------------------- |
| T1  | Done   | 恢复自定义文本绕过写稿模型的分支 | `packages/backend/src/features/voice/generate.ts`      | -          | 自定义直接进入 TTS，默认仍调用写稿 |
| T2  | Done   | 添加默认/自定义分支回归测试      | `packages/backend/src/features/voice/generate.test.ts` | T1         | 定向 Vitest 通过                   |
| T3  | Done   | 执行后端质量检查                 | backend package                                        | T1, T2     | test + typecheck 通过              |

## Execution Log

- 2026-09-02：已确认根因来自计费改动将自定义分支统一接入 `draftSpokenText`；用户要求恢复直接合成行为。
- 2026-09-02：已恢复分支并补充测试；后端 43 个测试文件共 378 项测试及 typecheck 全部通过。
