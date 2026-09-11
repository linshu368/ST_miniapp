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
| T1  | Todo   | 定义图片配置、描述、attempt、错误、200 字 prompt 上限与会话批量查询契约            | `packages/shared/src/api/images.ts`、shared exports                                          | -          | shared typecheck/test；消费者 typecheck                  |
| T2  | Todo   | 增加 experience 图片 attempt 表、索引、领取/收口 RPC 与 Storage bucket 策略       | `packages/shared/migrations/*.sql`                                                           | T1         | test 环境单文件迁移；shape/RLS/grant/锁/回滚核验         |
| T3  | Todo   | 准备角色卡取数、`character_persona_and_style` 读取和分镜师 prompt 资源            | backend repositories、`features/image/` prompt 资源                                           | T1,T2      | 字段存在/缺失场景；角色锚点不伪造；backend typecheck     |
| T4  | Todo   | 扩展 generation 的 DeepSeek 写稿/翻译与 Grok/Liaobots 生图能力                    | `packages/backend/src/features/generation/`、`features/image/`、storage/config               | T3         | DeepSeek 配置复用结论；Grok 配置缺失/成功/失败人工接口回归 |
| T5  | Todo   | 增加图片配置、默认写稿/自定义中文直出、翻译后生图、attempt 查询/创建路由与 runner | backend routes、`app.ts`、runtime config                                                     | T4         | 默认/自定义路径、200 字、翻译、202/402/409/422/5xx、重启恢复、并发与超时场景 |
| T6  | Todo   | 按图 1~9 增加 React Query API、图片面板状态机、消息挂图、大图预览与充值回跳       | frontend `lib/api`、chat page/components                                                     | T1,T5      | frontend typecheck/test/build；图 1~9 与 Telegram WebView 人工验收 |
| T7  | Todo   | 运行全链路验收、记录 test 环境发布顺序与停止/恢复条件                             | frontend/backend/shared、migration runbook                                                   | T2-T6      | PRD 必验路径和故障矩阵逐项记录                           |
| T8  | Todo   | 功能上线验证后更新架构与模块现状 spec                                             | `docs/ARCHITECTURE.md`、module spec/module-updates                                           | T7         | module knowledge check；文档链接检查                     |

## Execution Log

- 2026-09-11：当前任务仅完成规划与评审材料，不执行 T1~T8，不运行 `task.py start`。
- 2026-09-11：追加需求已纳入规划：图片链路分默认写稿后出图与自定义原文出图；prompt 上限 200 字；当时图片模型选择保留评审空位，2026-09-12 已更新为 Grok/Liaobots。
- 2026-09-11：追加前端交互稿要求：按图 1~9 覆盖入口、写稿加载、确认、自定义、出图加载、ready 卡、放大预览、失败和余额不足充值。
- 2026-09-12：追加外部生图流水线参考：默认路径用分镜师 prompt + DeepSeek 写中文短文；默认/自定义均先翻译英文再调用 Grok/Liaobots；Grok 配置来自 `LIAOBOTS_AUTH`、`LIAOBOTS_BASE`、`GROK_MODEL`。
- 按需求不新增测试文件；“不写新测试”不豁免既有检查与人工失败路径验证。
