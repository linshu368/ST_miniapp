# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID   | Status | Task                                                                 | Files / Scope                                                              | Depends On                      | Verification                                                                                                         |
| ---- | ------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| T1   | Done   | 收齐主体、状态栏、记忆栏准确文案，并记录用户确认的 TEST 正则对齐结论 | requirement research                                                       | -                               | 文案清单、TEST 用户确认及边界记录                                                                                    |
| T1-P | Todo   | 在 Production 发布前只读核对已发布后处理标签协议                     | Production config/renderer metadata                                        | T1                              | Production 证据与 `[choice]`、`[status]`、`[memory]` 一致                                                            |
| T2   | Done   | 设计并实现用户开关窗口与逻辑轮模式快照 migration                     | shared migrations, Prisma                                                  | T1                              | Prisma format/validate/generate、Unix-socket local migration harness、migration ledger/diff 静态检查通过；远端未写入 |
| T3   | Done   | 扩展 Shared 用户设置与生成配置契约                                   | shared API                                                                 | T2                              | shared typecheck/test、consumer typecheck                                                                            |
| T4   | Done   | 扩展 Backend 偏好写入、开轮模式和 prompt 渲染                        | backend settings/conversations/engine、Shared runtime-config schema/export | T2, T3                          | shared/backend typecheck/test、定向 engine/repository 回归                                                           |
| T5   | Done   | 增加 Frontend 状态栏/记忆栏开关                                      | frontend generation preferences                                            | T3, T4                          | frontend test/lint/typecheck/build；可重复移动端人工矩阵已记录，待环境级 T7 执行                                     |
| T6   | Done   | 升级 Admin 平台规则单页管理                                          | admin config schemas/navigation/editors、后续 managed-config migration     | T2, T3, T4 Shared schema export | admin test/typecheck/build、迁移 lint/ledger；远端环境人工检查待 T7                                                  |
| T7   | Todo   | 更新文档、模块知识并完成跨层验收                                     | docs/specs/all consumers                                                   | T2-T6                           | 全量适用命令与 TEST 人工矩阵                                                                                         |

## Execution Log

- 2026-10-13：基于 `origin/dev@cf1569e7` 创建规划任务；确认本轮不进入实现。
- 2026-10-13：用户确认激活窗口从 false->true 生效后的当前轮起算两轮；状态栏/记忆栏默认开启，选项保留历史且默认开启；状态栏/记忆栏文案待提供。
- 2026-10-13：收到新版主体、状态栏、记忆栏附件。用户确认 TEST 正则已与新版主体对齐；Production 尚未进行远程只读核对，拆分为 T1-P 发布门禁。
- 2026-10-13：完成 T2 本地变更：新增用户级状态/记忆开关和三个 0..2 计数；false→true 由数据库触发器原子重置为 2；开新逻辑轮在 current-postprocess wrapper 同一事务内锁定设置、领取 full/concise/off 并写入 history snapshot；重生成只复制同轮既有快照，不领取次数。旧 `interaction_mode_blocks` 未读写。
- 2026-10-13：只读账本检查（GitHub Actions inspect，未执行 SQL migration）：TEST 与 Production 均已有 20260928/20260930 开轮前置且无 checksum drift；TEST 已记账 20261012 retire，Production 未记账。该检查不读取后处理正文/标签，Production 标签协议仍为 T1-P，未验证。
- 2026-10-13：本地验证通过 `pnpm lint:migrations`、`pnpm test:migration-ledger`、`git diff --check`。隔离工作树无依赖目录，Prisma binary 不存在，`prisma validate` 未运行；未执行 TEST/Production 数据库写入。
- 2026-10-13：完成 T3：Shared 用户设置与生成配置读模型新增 `pref_show_status`、`pref_show_memory`，两个 PATCH 契约字段均保持 optional 并用严格 Zod schema 校验。Backend 仅同步 repository 行类型、select/映射和既有 route 适配；缺列读模型回退为 true，未公开计数或每轮模式，也未接入 T2 RPC（留给 T4）。验证记录见 `research/t3-shared-contract-validation.md`。
- 2026-10-13：恢复隔离 worktree 的锁定依赖；`prisma format`、以不可连接本地占位 URL 执行的 `prisma validate`、以及 `prisma generate` 均通过。format 仅对既有 T2 Prisma 字段对齐；未访问数据库。
- 2026-10-13：新增并通过 `scripts/test-platform-instruction-slot-windows-local.sh`：PostgreSQL 17 Unix-socket 临时 cluster 从 20260930 current-postprocess wrapper 前置结构应用单个 T2 migration，覆盖历史偏好/default、三槽 0..2、full/full/concise、off/reopen、regeneration、三会话并发、失败事务回滚、snapshot guard、owner/SECURITY DEFINER/search_path/execute ACL/RLS/grant/security_invoker。完整本地证据见 `research/t2-local-migration-validation.md`；TEST/Production 均未读写，仍保留各自 preflight/apply/postflight 门禁。
- 2026-10-13：补完 T2 静态门禁：`pnpm lint:migrations`、`pnpm test:migration-ledger`、`pnpm --filter @miniapp/shared --filter @miniapp/backend typecheck` 与 `git diff --check` 全部通过。未运行 T3-T7 的消费层测试、构建或远端 preflight/postflight。
- 2026-10-13：完成 T6：新增后续 `20261013_admin_platform_instruction_slots.sql`，为 `choice_rules`、`status_rules`、`memory_rules` 建立安全三字段 JSONB seed、Admin allowlist/CHECK/validator，并把 `system_instructions` 收紧为 `CHOICE_RULES`、`STATUS_RULES`、`MEMORY_RULES`、`WORD_COUNT`、`USER_CUSTOM_INSTRUCTIONS` 五个必需占位符；`INTERACTION_MODE` 不能替代任一槽位。`interaction_mode_blocks` 未读、未写、未删除且不进入 Admin 入口。
- 2026-10-13：Admin「平台规则」改为选项、状态栏、记忆区、主体模板四 tab。三个槽位直接消费 T4 导出的 `InstructionSlotRulesSchema`/type；每个 tab 继续使用既有的环境绑定草稿、发布、历史和回滚卡，不新增请求或第二份草稿状态。TEST/Production client、生产写入二次确认逻辑未改。
- 2026-10-13：T6 本地验证通过：`pnpm --filter @miniapp/admin typecheck`、`pnpm --filter @miniapp/admin test`（12 files / 97 tests）、`pnpm --filter @miniapp/admin build`、`pnpm --filter @miniapp/shared typecheck`、`pnpm lint:migrations`、`pnpm test:migration-ledger`、`git diff --check`。Admin test/build 仅创建本地 Vite 临时/构建输出；没有执行 TEST/Production SQL apply、草稿/发布/回滚写入、部署、提交或推送。T7 仍须完成环境级 migration preflight/apply/postflight、TEST/Production 草稿/发布/回滚人工验收、T1-P Production 标签协议只读核对及跨层矩阵。
- 2026-10-13：完成 T4：三个偏好开关改经 `app_core.update_instruction_slot_preferences` 原子 RPC 写入，普通设置字段仍走既有 repository 更新且不再直写这些开关；开轮/重生成 RPC 返回的 `full`/`concise`/`off` 仅在 Backend 内部校验、记录安全摘要并传入 engine，缺失或非法模式在 LLM/SSE 前失败。Shared 新增并从根出口导出严格的 `InstructionSlotRulesSchema`/type；Backend 对 `choice_rules`、`status_rules`、`memory_rules` 逐 key 读取、版本签名、降级和不含正文的日志。渲染现行五个占位符，不再消费 `INTERACTION_MODE`；HTTP/SSE DTO 未加入模式、计数或 history snapshot。验证记录见 `research/t4-backend-validation.md`。
- 2026-10-13：完成 T5：Frontend `ChatGenerationSettings` 继续复用 generation-config React Query query/mutation，新增「状态栏」「记忆区」独立 Switch，分别仅 PATCH `pref_show_status` / `pref_show_memory`；现有「结尾给出选项」仍仅 PATCH `pref_show_options`。所有显示值以服务端回读 config 为准，过渡期缺失值仅按 Shared/Backend 既定语义展示为开启；不显示或维护窗口计数、每轮模式。复用 mutation pending 禁用，保存失败显示可恢复的既有组件内错误反馈。验证与人工矩阵见 `research/t5-frontend-validation.md`；未执行 TEST/Production 写入、发布、提交或推送。
- 2026-10-13：TEST 首次执行 T6 managed-config migration 时，既有 `miniapp_text_postprocess_config` 专用 draft/release 历史触发新通用 key CHECK，事务完整回滚。修复后的 CHECK 仅为该专用 immutable-version pointer 加例外，不将其加入 generic allowlist 或开放通用 Admin 写路径；新增隔离 PostgreSQL 17 回归覆盖 8+8 历史行保留和未知 key 拒绝。详见 `research/t6-admin-managed-config-validation.md`。未重试 TEST migration，T7 仍须先只读核对 ledger 后手动重跑。
