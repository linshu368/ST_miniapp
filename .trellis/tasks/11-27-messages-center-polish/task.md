# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                         | Files / Scope                                                                        | Depends On | Verification                                                       |
| --- | ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------ |
| T1  | Done   | 14 天未读窗口常量与判断、`all` 契约                          | `shared/src/api/notifications.ts`                                                    | -          | `pnpm -r typecheck`                                                |
| T2  | Done   | 列表上限 50、窗口外视为已读、未读数按窗口、`all` 分支        | `backend/src/routes/notifications.ts` + 既有测试补用例                               | T1         | `vitest run src/routes/notifications.test.ts`（7 例）              |
| T3  | Done   | 全部已读乐观更新与失败回滚                                   | `frontend/src/lib/api/notifications.ts`                                              | T1         | typecheck；ui-tests `@messages`                                    |
| T4  | Done   | 分类红点、分类栏「全部已读」、更早整组收起、点开不等待       | `frontend/src/app/(main)/profile/messages/page.tsx`                                  | T3         | ui-tests `@messages`（390 / 320）                                  |
| T5  | Done   | 从详情返回保留分类与展开                                     | `lib/notifications/list-view-memory.ts`、`messages/[id]/page.tsx`                    | T4         | ui-tests `@messages`                                               |
| T6  | Done   | 本地验收场景 `messages`，心愿通知 mock 支持 `all`            | `ui-tests/fixtures/{message-center,server,data}.ts`、`tests/profile.spec.ts`、README | T4         | `pnpm test:ui --grep "@profile\|@wishes"`、`pnpm test:ui:fixtures` |
| T7  | Todo   | TEST 环境验收：全部已读写库、窗口外不计未读                  | Railway development + TEST 库                                                        | T2         | dev 环境 curl `unread-count` / `read {all}`                        |
| T8  | Todo   | 生产发布后核对：未读数下降、`notification.read_all` 日志出现 | 生产只读 SQL + Railway 日志                                                          | T7         | 见 PRD 验收                                                        |

## Execution Log

- 2026-11-27：交互稿 `ST_miniapp/labs/messages-center/` 用户选定「分类栏右边 / 整组收起 / 14 天」；T1–T6 完成，本地检查全绿。
- 首次跑 `@wishes` 时失败：分类按钮在有未读时被改名为「消息，有未读」，破坏了按名称定位。现在分类名保持不变，用 `data-unread` 标记是否有未读。
