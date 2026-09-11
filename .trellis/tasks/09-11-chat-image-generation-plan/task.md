# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                                              | Files / Scope                                                                                | Depends On | Verification                                             |
| --- | ------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------- |
| T1  | Todo   | 定义图片配置、描述、attempt、错误与会话批量查询契约                               | `packages/shared/src/api/images.ts`、shared exports                                          | -          | shared typecheck/test；消费者 typecheck                  |
| T2  | Todo   | 增加 experience 图片 attempt 表、索引、领取/收口 RPC 与 Storage bucket 策略       | `packages/shared/migrations/*.sql`                                                           | T1         | test 环境单文件迁移；shape/RLS/grant/锁/回滚核验         |
| T3  | Todo   | 扩展 generation 的文本 JSON 与图片生成能力，增加 provider、Storage 和原子计费收口 | `packages/backend/src/features/generation/`、`features/image/`、repositories、storage/config | T1,T2      | backend typecheck/test；假 provider 人工接口回归         |
| T4  | Todo   | 增加图片配置、描述生成、attempt 查询/创建路由与数据库任务 runner                  | backend routes、`app.ts`、runtime config                                                     | T3         | 202/402/409/422/5xx、重启恢复、并发与超时场景            |
| T5  | Todo   | 增加 React Query API、图片面板状态机、消息挂图及大图预览/充值回跳                 | frontend `lib/api`、chat page/components                                                     | T1,T4      | frontend typecheck/test/build；Telegram WebView 人工验收 |
| T6  | Todo   | 运行全链路验收、记录 test 环境发布顺序与停止/恢复条件                             | frontend/backend/shared、migration runbook                                                   | T2-T5      | PRD 必验路径和故障矩阵逐项记录                           |
| T7  | Todo   | 功能上线验证后更新架构与模块现状 spec                                             | `docs/ARCHITECTURE.md`、module spec/module-updates                                           | T6         | module knowledge check；文档链接检查                     |

## Execution Log

- 2026-09-11：当前任务仅完成规划与评审材料，不执行 T1~T7，不运行 `task.py start`。
- 按需求不新增测试文件；“不写新测试”不豁免既有检查与人工失败路径验证。
