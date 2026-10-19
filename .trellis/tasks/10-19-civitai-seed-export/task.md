# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                    | Files / Scope                  | Depends On | Verification                       |
| --- | ------ | ----------------------- | ------------------------------ | ---------- | ---------------------------------- |
| T1  | Done   | 原始写入链路与范围审核  | seed-import/storage/migrations | -          | 用户确认不写生产                   |
| T2  | Done   | TEST catalog 与只读导出 | 离线脚本                       | T1         | 8032 对作品/图片，0 软删除         |
| T3  | Done   | SQL 模板与 Storage 说明 | shared/migrations、ops         | T1         | 文件完成；SQL 实际运行另为发布门禁 |
| T4  | Done   | 产物校验和检查          | 本地                           | T2,T3      | hash/条数/163 tests/typecheck      |

## Execution Log

- 2026-10-19 用户确认先编写 SQL 数据迁移文件，Storage 独立出方法，不写生产。
- 2026-10-19T06:37:24Z TEST 只读导出：8032 works/artifacts，8032 中文提示词，10 张 >20MiB 图片；总图片 16637199531 字节，SQL 28548456 字节。SQL、payload、manifest、模板 hash 及逐项路径/大小一致性通过。
- node --check、migration filenames、git diff --check、shared typecheck 通过；shared 16 文件/163 测试通过。没有新增测试文件。
- MCP 无 TEST 项目访问权；本地 direct DNS ENOTFOUND，随后明确使用 TEST_DATABASE_URL pooler 成功，只读事务，无远端写入。未找到本地 PostgreSQL/Docker，SQL 实际执行/重复/冲突/回滚尚未演练，已写入 runbook 发布门禁。
- 生产未连接；Storage 未复制；未提交 Git。实际数据位于 Git 忽略的 ops/exports/civitai-1792391831356。
