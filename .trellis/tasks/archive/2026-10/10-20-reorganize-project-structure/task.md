# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                 | Files / Scope                                 | Depends On | Verification                   |
| --- | ------ | ------------------------------------ | --------------------------------------------- | ---------- | ------------------------------ |
| T1  | Done   | 审计可归纳目录与路径消费者           | 全仓                                          | -          | 三路只读审计、引用扫描         |
| T2  | Done   | 归纳根脚本与图片广场运维说明         | `scripts/`、`ops/image-plaza/`、workflow/docs | T1         | shell/node 检查、脚本入口测试  |
| T3  | Done   | 归纳 Admin 视图、编辑器与领域 helper | `packages/admin/src`、Admin spec              | T1         | typecheck/test/build           |
| T4  | Done   | 归纳少量 Frontend helper 与支付图标  | `packages/frontend/src`、Frontend spec        | T1         | typecheck/test/lint/build      |
| T5  | Done   | 将 Backend/Shared 文件归回明确领域   | Backend/Shared/spec                           | T1         | typecheck/test、根出口核对     |
| T6  | Done   | 归纳 Reply Renderer 内部文件         | `packages/reply-renderer/src`                 | T1         | typecheck/test、两消费者 build |
| T7  | Done   | 全仓路径闭合与最终验证               | 全仓                                          | T2-T6      | old-path scan、quality gate    |

## Execution Log

- 2026-10-20：完成 Frontend/Admin、Backend/Shared/Renderer、仓库脚本/运维三路只读审计；排除框架约定路径、migration、Prisma、Backend 线上脚本和高引用面低收益目录。
- 2026-10-20：移动 96 个文件，更新静态 import、mock、Worker/raw/build 入口、package scripts、workflow 和现行文档；未改变业务逻辑或公开出口。
- 2026-10-20：旧路径与相对引用扫描为 0；全仓 typecheck、1,293 个测试、lint/guards、Frontend/Admin build、Node/Shell/YAML 检查通过。Frontend 保留既有 5 条 `<img>` warning；migration-ledger 因本机缺少 PostgreSQL 工具未完整执行。
- 2026-10-20：独立最终审查无阻断问题，确认框架约定目录保持原位、所有相对路径均解析到现存文件。
