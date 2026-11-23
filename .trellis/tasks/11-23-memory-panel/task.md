# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status  | Task                                                                                                                                            | Files / Scope                                                                                              | Depends On             | Verification                                              |
| --- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------- |
| T1  | Done    | 共享层：记忆结构、远近分档、检查任务、提示词（含玩家要求）、输出校验                                                                            | `packages/shared/src/memory-bar/*`                                                                         | -                      | `memory-bar.test.ts` 12 条通过                            |
| T2  | Todo    | 迁移：`experience.chat_memory_snapshots` + `get_chat_memory` / `record_chat_memory`，`user_character_preferences.memory_request`；registry 登记 | `packages/shared/migrations/2026112x_memory_panel.sql`、`docs/db/registry.yaml`、migrations README         | 审核通过               | `pnpm lint:db-contract`；TEST 执行后核对 shape、权限、RLS |
| T3  | Todo    | 接口契约：状态接口加 `memory`、refresh 加 `memoryOutcome`、`PUT …/memory-request`                                                               | `packages/shared/src/api/status-bar.ts`                                                                    | T1                     | shared test + 全部消费者 typecheck                        |
| T4  | Todo    | 后端记忆检查：取模触发、读区间轮次与旧记忆区、调模型（复用 `callStatusModel`）、校验、落库、日志                                                | `backend/src/features/memory-bar/*`、`MemoryBarRepository.ts`、`turn-execution.ts` 挂钩                    | T2 T3                  | 失败路径单测；Pino JSON 断言                              |
| T5  | Todo    | 后端接口：状态读并行带记忆、手动更新并行、记忆要求读写                                                                                          | `features/status-bar/service.ts`、`routes/status-bar.ts`                                                   | T4                     | 路由单测（本人/越权/超长/VIP）                            |
| T6  | Todo    | 正文模型侧：`{{MEMORY_RULES}}` 填空、`slotModes.memory` 视为 off、协议常量、入模历史剥记忆区                                                    | `engine/render-instructions.ts`、`turn-execution.ts`、`rich-reply-protocol.ts`、`conversations/history.ts` | -                      | engine / history 单测                                     |
| T7  | Todo    | 旧记忆区隐藏（三处后处理）                                                                                                                      | `shared/src/text-postprocess/{rich-reply,rich-reply-fallback,apply}.ts`                                    | -                      | text-postprocess 单测                                     |
| T8  | Blocked | 离线试跑真实会话                                                                                                                                | 本地脚本（scratchpad），不进仓库                                                                           | T4；用户同意用生产 key | 用户抽看结果文件                                          |
| T9  | Todo    | 前端：B 时间线、更早的记忆、记忆要求弹层、面板入口规则、「没有新进展」提示                                                                      | `frontend/src/components/status-bar/*`、`lib/api/status-bar.ts`、ui-tests 场景                             | T3 T5                  | 预览截图（手机宽度）、typecheck                           |
| T10 | Todo    | 生产迁移 + 一次发布 + 运营改主体模板文字                                                                                                        | GitHub Actions db-migrate、PR                                                                              | T2–T9；用户批准        | 部署核对、48 小时观察                                     |
| T11 | Todo    | 清理迁移：退役 `memory_rules_mode`、`memory_rules`、模板占位校验                                                                                | 新迁移 + admin-client 注册表                                                                               | T10 观察稳定           | TEST → 生产                                               |

## Execution Log

- 2026-11-23：T1 完成（本地分支 feat/memory-panel，未推送）；规划文档待用户审。
