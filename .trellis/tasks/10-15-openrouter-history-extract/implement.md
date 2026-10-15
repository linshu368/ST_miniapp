# 执行计划（待审阅）

1. 复核当前分支、目标库、迁移账本、全部 DB/代码消费者和历史行可归属规则；形成 TEST/Production 各自的前置结构记录。若归属或旧 Backend 兼容未明确，暂停删列阶段。
2. 在 `packages/shared/migrations/` 新增一张 `experience.openrouter_chat_history` 的前向 migration，并在 Backend 生成/结算/回捞仓储接入占位与幂等补齐。主表业务结束原因及计费事实仍走原路径；不新增公开 DTO 或跨层依赖。
3. 在 TEST 按文件逐一执行并验证 shape、权限/RLS、FK、唯一性、重复 upsert、失败与并发路径；安全分批回填已确认 OpenRouter 的历史行，核对缺失、空值、重复和 raw JSON 内容。改回捞及 `current_chat_history` 消费者后再评估旧列清理，清理另设停止点。
4. 优先扩展现有相关回归测试，覆盖免费/付费、取消/超时、迟到用量、重复回捞和计费失败恢复；若现有测试无法锁定关键迁移/并发风险，审阅后再创建专项测试文件。运行 shared/backend 相关测试、受影响包 typecheck、`pnpm -r typecheck`、build、lint、migration 静态检查及 `git diff --check`。记录 TEST 人工 SSE/结算/回捞场景及失败路径。
5. 更新 README、架构和相关 spec 的实际读写位置、发布顺序及 rollback/forward-fix；给出 Production 单独迁移与验收方案，不自动执行 Production、部署、提交或推送。
