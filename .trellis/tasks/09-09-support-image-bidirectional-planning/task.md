# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status  | Task                                                           | Files / Scope                                                     | Depends On | Verification                                            |
| --- | ------- | -------------------------------------------------------------- | ----------------------------------------------------------------- | ---------- | ------------------------------------------------------- |
| T0  | Blocked | 人工评审规划并确认 private bucket、审核风险、真实 webhook/环境 | task artifacts / test & prod 配置                                 | -          | 评审记录与明确实施授权                                  |
| T1  | Todo    | 扩展客服图片 shared 契约及测试                                 | `packages/shared/src/api/{support,cs-platform}.ts`、exports/tests | T0         | shared typecheck/test；所有消费者 typecheck             |
| T2  | Todo    | 新建消息表与 private bucket migration，并在 test 验证          | `packages/shared/migrations/<new>.sql`、回滚/执行记录             | T1         | shape、约束、索引、RLS/grants、锁/容量、旧文本验证      |
| T3  | Todo    | 实现 Backend 图片校验、缩略图、Storage、签名和补偿             | backend helper/dependency/tests                                   | T2         | 格式/超限/伪装/像素炸弹/Storage 失败测试；Railway build |
| T4  | Todo    | 实现链路 B Backend API 与可靠性测试                            | `routes/support.ts`、`routes/cs-platform.ts`、repository/tests    | T3         | ownership、幂等、未读、摘要、补偿、签名刷新测试         |
| T5  | Todo    | 实现 Frontend 客服中心图片 UI/API                              | support page、`lib/api/support.ts`、outbox/组件/tests             | T4         | frontend typecheck/test/lint/build + 移动端人工回归     |
| T6  | Todo    | 实现 CS 客服工作台图片 UI/API                                  | `src/api.ts`、SupportConversationPanel、styles/components         | T4         | CS typecheck/build + test/prod 环境隔离人工回归         |
| T7  | Todo    | 实现 Telegram 入站/出站图片与 repository 扩展                  | 双 webhook、Telegram adapter、CsPlatformRepository/tests          | T3         | getFile/download/sendPhoto、403/429/超时、重投测试      |
| T8  | Todo    | 实现 CS 回访面板图片 UI/API                                    | `src/api.ts`、ConversationPanel、styles/components                | T7         | CS typecheck/build + 真 Bot 双向回归                    |
| T9  | Todo    | 全量验收、advisor、文档、module facts 与发布/恢复演练          | affected packages/docs/task artifacts                             | T5,T6,T8   | 完整命令矩阵、人工场景、advisor、发布 smoke/停止条件    |

## Execution Log

- 2026-09-09：完成需求稿/交互 txt 与当前源码差异调研；确认当前只有文本闭环，需求稿所称图片 migration/helper/API/UI 均不存在。
- 2026-09-09：规划产物完成，任务保持 planning；T0 等待人工评审，不执行 `task.py start`。
