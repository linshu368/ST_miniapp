# 执行计划与 T4 收尾

2026-10-16 字段名调整已由用户审核并实现，TEST expand 与 Backend 推送已完成（68bf9085/caebc0c6）；T4 实时证据见 research/t4-final-audit-2026-10-16.md，生产方案见 production-release-checklist.md。以下为 T2R 原执行顺序：新增 expand migration → OpenRouter 原名类型/仓储/结算/回捞消费者 → 计费输出与原始元数据分离 → 扩展现有回归与本地迁移验证 → 同步文档与结果。远端 migration、提交/推送和部署不在本次本地实现步骤中自动执行；新 Backend 依赖该 migration。T3/T4 状态按真实验收保留。

1. 复核当前分支、目标库、迁移账本、全部 DB/代码消费者和历史行可归属规则；形成 TEST/Production 各自的前置结构记录。若归属或旧 Backend 兼容未明确，暂停删列阶段。
2. 在 `packages/shared/migrations/` 新增一张 `experience.openrouter_chat_history` 的前向 migration，并在 Backend 生成/结算/回捞仓储接入占位与幂等补齐。主表业务结束原因及计费事实仍走原路径；不新增公开 DTO 或跨层依赖。
3. 在 TEST 按文件逐一执行并验证 shape、权限/RLS、FK、唯一性、重复 upsert、失败与并发路径；安全分批回填已确认 OpenRouter 的历史行，核对缺失、空值、重复和 raw JSON 内容。改回捞及 `current_chat_history` 消费者后再评估旧列清理，清理另设停止点。
4. 优先扩展现有相关回归测试，覆盖免费/付费、取消/超时、迟到用量、重复回捞和计费失败恢复；若现有测试无法锁定关键迁移/并发风险，审阅后再创建专项测试文件。运行 shared/backend 相关测试、受影响包 typecheck、`pnpm -r typecheck`、build、lint、migration 静态检查及 `git diff --check`。记录 TEST 人工 SSE/结算/回捞场景及失败路径。
5. 更新 README、架构和相关 spec 的实际读写位置、发布顺序及 rollback/forward-fix；给出 Production 单独迁移与验收方案，不自动执行 Production、部署、提交或推送。

## T4 最终审阅发现的必要修复（2026-10-16）

现有已审核规划要求计费失败恢复、Venice 行为不变和有界无内容 metadata；最终 diff 发现新专表扫描丢失主表 pending settlement 条件，且仅黑名单过滤 JSON 不能证明内容隔离。此次在既有模块内修复，不新增任务、依赖、公开 API 或 migration：

1. 复用主表仓储增加有界未结算扫描；保留专表原名字段扫描；补上专表占位缺失的 anti-join 恢复，明确排除 Venice。三路分别最多 50 条、24h、5s timeout，按 parent ID 去重，避免 metadata 队列占满挤掉计费恢复。Venice 只沿原主表 finish reason/charge_id 恢复，不调 OpenRouter API。
2. 原始诊断改为有界 allowlist，只保留厂商元数据字段和数值错误码，不持久化未知字段/error message；fetch 失败日志使用安全诊断。保留 canonical 字段/zero/NULL 语义。
3. 扩展现有 repository/sync/mapper 测试，覆盖元数据完整但结算失败、Venice 恢复、缺失占位、重复候选和恶意未知正文/凭证。这是既有计费/隐私风险回归要求，无新增测试文件。
4. 运行 Backend 全测试、Shared 测试、workspace typecheck/build、lint/import/legacy/migrations、本地迁移回归。人工 TEST 验收继续独立保留；本地修复不代表 PR/部署已包含。

可靠性：DB 唯一键与 charge_id 仍是幂等事实；多实例可重复读取/收口；不引入跨网络事务、无限重试或队列。暂停/恢复仅回退本地补丁，保留 additive DB 与新旧字段；Production 仍需逐文件独立批准。超出 24h 的遗失占位/旧 writer 窗口需审查 catch-up，不宣称自动恢复。
