# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                                                                                                            | Files / Scope                                                                                              | Depends On             | Verification                                              |
| --- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------- |
| T1  | Done   | 共享层：记忆结构、远近分档、检查任务、提示词（含玩家要求）、输出校验                                                                            | `packages/shared/src/memory-bar/*`                                                                         | -                      | `memory-bar.test.ts` 12 条通过                            |
| T2  | Done   | 迁移：`experience.chat_memory_snapshots` + `get_chat_memory` / `record_chat_memory`，`user_character_preferences.memory_request`；registry 登记 | `packages/shared/migrations/2026112x_memory_panel.sql`、`docs/db/registry.yaml`、migrations README         | 审核通过               | `pnpm lint:db-contract`；TEST 执行后核对 shape、权限、RLS |
| T3  | Done   | 接口契约：状态接口加 `memory`、refresh 加 `memoryOutcome`、`PUT …/memory-request`                                                               | `packages/shared/src/api/status-bar.ts`                                                                    | T1                     | shared test + 全部消费者 typecheck                        |
| T4  | Done   | 后端记忆检查：取模触发、读区间轮次与旧记忆区、调模型（复用 `callStatusModel`）、校验、落库、日志                                                | `backend/src/features/memory-bar/*`、`MemoryBarRepository.ts`、`turn-execution.ts` 挂钩                    | T2 T3                  | 失败路径单测；Pino JSON 断言                              |
| T5  | Done   | 后端接口：状态读并行带记忆、手动更新并行、记忆要求读写                                                                                          | `features/status-bar/service.ts`、`routes/status-bar.ts`                                                   | T4                     | 路由单测（本人/越权/超长/VIP）                            |
| T6  | Done   | 正文模型侧：`{{MEMORY_RULES}}` 填空、`slotModes.memory` 视为 off、协议常量、入模历史剥记忆区                                                    | `engine/render-instructions.ts`、`turn-execution.ts`、`rich-reply-protocol.ts`、`conversations/history.ts` | -                      | engine / history 单测                                     |
| T7  | Done   | 旧记忆区隐藏（三处后处理）                                                                                                                      | `shared/src/text-postprocess/{rich-reply,rich-reply-fallback,apply}.ts`                                    | -                      | text-postprocess 单测                                     |
| T8  | Done   | 离线试跑真实会话                                                                                                                                | 本地脚本（scratchpad），不进仓库                                                                           | T4；用户同意用生产 key | 用户抽看结果文件                                          |
| T9  | Done   | 前端：B 时间线、更早的记忆、记忆要求弹层、面板入口规则、「没有新进展」提示                                                                      | `frontend/src/components/status-bar/*`、`lib/api/status-bar.ts`、ui-tests 场景                             | T3 T5                  | 预览截图（手机宽度）、typecheck                           |
| T10 | Doing  | 生产迁移 + 一次发布 + 运营改主体模板文字                                                                                                        | GitHub Actions db-migrate、PR                                                                              | T2–T9；用户批准        | 部署核对、48 小时观察                                     |
| T11 | Doing  | 清理迁移：退役 `memory_rules_mode`、`memory_rules`、模板占位校验                                                                                | 新迁移 + admin-client 注册表                                                                               | T10 观察稳定           | TEST → 生产                                               |

## Execution Log

- 2026-11-23：T1 完成（本地分支 feat/memory-panel，未推送）；规划文档待用户审。
- 2026-11-23：T2–T7 完成；迁移两份（memory_panel、memory_bar_prompt）已在 TEST 执行成功。用户追加：记忆栏 prompt 放运营平台（memory_bar_prompt），未成年人等内容限制写在 prompt 里由用户调整，代码只固定输出格式。
- 2026-11-23：T8 离线试跑（只读生产对话、生产模型通道、不写库）：5 个会话 × 36 轮 = 60 次检查，0 失败，兜底 10%（主通道 incomplete），单次中位 3.7 秒，最终 1.2–1.5k 字、档位按设计推进。首轮里程碑每 36 轮 17–26 条过多 → 收紧运营 prompt 初稿 + 每次最多 1 条后降到 4–6 条。这批会话节奏快，「没进展不写」未被触发（单测覆盖），上线后看日志比例。
- 2026-11-23：T9 完成，本地预览场景 memory-panel / memory-only，390/320 无横向溢出。
- 2026-11-23：T10 生产迁移两份执行成功（runs 45114347151 / 45114435476）；`memory_bar_prompt` v1 发布到运营平台；#1080 合并、Railway 部署 45cd80f4 成功。用户要求顺带清理旧记忆区并简化主体模板（只剩正文 + 选项）。
- 2026-11-23：T11 提前做（用户要求，不等 48 小时观察）：分支 feat/memory-cleanup——正文协议 v2（只讲正文和选项）、去掉 memory_rules 槽位与配置项、老回复里的记忆区只识别不显示（同状态栏）、迁移 20261123_memory_bar_legacy_cleanup（7 处替换在生产只读核对各命中 1 次）。主体模板 v21、选项规则去掉记忆区那句，待用户看差异后发布。
- 2026-11-23：T11 完成（#1081 + 迁移 TEST/生产，#1083 没闭合的状态栏/记忆区也隐藏）。T12（用户追加）：#1087 状态栏/记忆栏兜底改 OpenRouter deepseek/deepseek-v4-flash；随后两个模型都放运营平台（status_memory_model_config，迁移 20261123_status_memory_model_config，没配用默认），日志 status_bar.update / memory_bar.update 加 model 字段。
