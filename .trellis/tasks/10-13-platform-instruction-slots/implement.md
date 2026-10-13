# Implementation Plan

## Gate 0: inputs and live facts

- [x] 收齐新版主体、状态栏、记忆栏的准确文案；以 2026-10-13 用户提供附件为准，见 `research/platform-rule-copy-and-tag-evidence.md`。
- [x] 记录用户确认的 TEST 正则与新版主体对齐；未在本轮读取远程 TEST 配置。
- [ ] 在 Production 发布前只读核对 Production 当前后处理正式版本，记录 `[choice]`、`[status]`、`[memory]` 的真实开闭标签、顺序和容错差异；不得以 TEST 结论替代。
- [ ] 核对 TEST/Production migration ledger 与相关表/RPC 前置 shape；不得用一方代替另一方。
- [ ] 复核最新 `origin/dev` 和 managed-config validator wrapper 链，避免覆盖后续配置分支。

## Phase 1: database and contracts

- [x] 新 migration 扩展 `app_core.miniapp_user_settings`、`experience.chat_history` 和现有开轮/偏好 RPC；设置 lock/statement timeout、preflight、自检、RLS/grants 与 forward-fix 说明。远端 apply/postflight 留待独立发布阶段。
- [x] seed 三个槽位 runtime key，扩展 Admin allowlist/CHECK/validator，并更新 `system_instructions` 占位符校验。
- [ ] 保留 `interaction_mode_blocks` 兼容数据但停止新链路消费。
- [ ] 更新 Prisma 映射和 Shared 用户设置/生成配置 DTO；不公开内部计数和模式字段。
- [x] migration 内设计与 TEST/Production pre/postflight 记录覆盖 false->true、重复 true、独立槽位、两次 full、第三次 concise、关闭、重生成和并发分配；本轮不执行远端 SQL。

## Phase 2: Backend

- [x] 扩展用户偏好读写和原子切换入口。
- [x] 从开轮结果读取持久化槽位模式并传给 Engine。
- [x] 平台配置读取改为主体 + 三槽位 + 字数档位，加入逐 key fallback/version signature/degraded 日志。
- [x] 渲染五个现行占位符，删除 `INTERACTION_MODE` 消费逻辑。
- [x] 更新既有 engine/conversation/repository 测试；该逻辑涉及并发和迁移，回归测试属于必须项。

## Phase 3: Frontend and Admin

- [x] Frontend 增加状态栏、记忆栏开关，验证默认开启、独立切换、pending 禁用和刷新回读；本地证据见 `research/t5-frontend-validation.md`。
- [x] Admin 增加三个槽位 schema/default/editor，并把平台规则入口升级为单页 tabs 工作区。
- [x] 复用现有 managed-config 草稿/发布/历史/回滚；本地验证 TEST/Production client 隔离与生产确认逻辑未改。远端草稿/发布/回滚仍留待环境授权的人工验收。
- [ ] 更新架构与相关 spec/module knowledge，明确新 key、激活窗口和旧 key 兼容期。

## Phase 4: validation

- [x] `pnpm lint:migrations`
- [x] `pnpm test:migration-ledger`
- [x] `pnpm --filter @miniapp/shared typecheck`（T4 schema/export 接入后）
- [x] `pnpm --filter @miniapp/backend typecheck && pnpm --filter @miniapp/backend test`（T4：82 files / 647 tests）
- [x] `pnpm --filter @miniapp/frontend typecheck && pnpm --filter @miniapp/frontend test && pnpm --filter @miniapp/frontend lint && pnpm --filter @miniapp/frontend build`（T5）
- [x] `pnpm --filter @miniapp/admin typecheck && pnpm --filter @miniapp/admin test && pnpm --filter @miniapp/admin build`
- [x] T6 Admin/managed-config local validation record：`research/t6-admin-managed-config-validation.md`；远端 migration 与发布/回滚人工门禁保留给 T7。
- [ ] `pnpm -r typecheck`
- [ ] TEST 单文件 migration preflight/apply/postflight：列、默认值/check、RPC owner/search_path/execute、RLS/grants、managed key、草稿/发布/回滚、并发与回滚边界。
- [ ] 人工矩阵：三个槽位各自关闭；开启后的当前/下一/第三轮；关闭再开启；同轮重生成；多会话并发；三槽位组合；刷新后偏好；标签 renderer 与真实正式规则。

## Stop conditions and rollback

- 文案缺失、migration 前置 shape 不符或 validator wrapper 来源无法确认时停止；Production 标签协议未核对时停止 Production 发布，但不将用户已确认的 TEST 对齐结论误标为缺失。
- 应用回滚不删除新增列/key，旧 Backend 继续依赖保留的 `interaction_mode_blocks`。
- 配置发布错误通过回滚/新发布恢复；数据库缺陷走 forward-fix，不改写已执行 migration。
