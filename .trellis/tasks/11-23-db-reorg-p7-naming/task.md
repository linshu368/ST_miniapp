# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status  | Task                                   | Files / Scope                                                                                        | Depends On                          | Verification                                                            |
| --- | ------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| T1  | Done    | 第一批扩展迁移 + 本地验证              | `packages/shared/migrations/20261123_db_reorg_p7a_naming.sql`、`scripts/test-db-reorg-p7a-naming.sh` | -                                   | `bash scripts/test-db-reorg-p7a-naming.sh`                              |
| T2  | Done    | 第一批扩展：TEST → 生产 → 核对         | Database Migration workflow                                                                          | T1                                  | 结构/权限/定时任务/PostgREST 新旧 profile                               |
| T3  | Done    | 后端切新名字 + 遗留引用守卫            | Prisma、`DOMAIN_SCHEMAS`、原生 SQL、测试、`supabase/config.toml`、运维 SQL、`docs/db`                | T2                                  | typecheck、相关测试、`pnpm lint:db-contract`、发布后 Railway error 日志 |
| T4  | Done    | Grafana 看板 01 换新名字               | Grafana                                                                                              | T2                                  | 面板查询结果前后相同                                                    |
| T5  | Done    | 第一批收缩：删兼容层、PostgREST 去旧名 | 新迁移                                                                                               | T3、T4、pg_stat_statements 旧名停涨 | 本地 → TEST → 生产                                                      |
| T6  | Skipped | 第二批（随 6b-4）                      | billing 分成表、`media_plaza.image_plaza_*`                                                          | 6b-4                                | 同上                                                                    |
| T7  | Skipped | 第三批（文本计费收缩后）               | `experience.chat_history`、`admin.admin_users`                                                       | 6b-1c 收缩                          | 同上                                                                    |

## Execution Log

- 2026-11-23：T1 本地 PG17（非超级用户）+ PostgREST 全部通过；#1074 的 `free_zone_models.pinned` 已于 02:48 UTC 在生产执行，不会撞上兼容视图。
- 2026-11-23：T2 生产 09:39 UTC 改名（#1090/#1091，36 个函数改写，40 兼容视图 + 30 转发函数）；T3 后端 #1094 → 发布 #1095（10:02，7 个服务）；T4 看板 01 第 14 版全部面板核对；T5 收缩 #1096 生产 10:16（兼容层删除，PostgREST 只剩新名）。外部 Python 轮询旧名的程序用户确认停用。
- 2026-11-23：T6、T7 Skipped——用户决定收尾（"这个事情已经干了一周了，该收尾了"），第二、三批改名不做。
