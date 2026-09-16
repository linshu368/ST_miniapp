# Task Breakdown

## 依赖

- 09-11-batch-lab-foundation
- 09-11-batch-lab-data-samples
- 09-11-batch-lab-postprocessing 的稳定 processor/display 接口

## Tasks

| ID  | Status | Task                                   | Files / Scope               | Depends On | Verification                 |
| --- | ------ | -------------------------------------- | --------------------------- | ---------- | ---------------------------- |
| T0  | Done   | 人工评审并确认依赖/环境/安全门禁       | task artifacts + target env | -          | 用户授权继续其他子任务       |
| T1  | Done   | 冻结 shared 契约、状态、错误与容量限制 | shared contracts/tests      | T0         | schema tests + consumer 类型 |
| T2  | Done   | 实现持久边界、事务/幂等与 repository   | backend/database            | T1         | repository/migration 不变量  |
| T3  | Done   | 实现 Backend 实验与生成状态机核心能力  | owned application files     | T2         | PRD 业务验收                 |
| T4  | Done   | 覆盖失败、恢复、安全与容量             | tests/runbooks              | T3         | 故障注入与停止/回滚演练      |
| T5  | Done   | 完成消费者检查、Spec payload和集成交接 | spec/docs/module updates    | T4         | 验证命令完成，已知旧问题记录 |

## 完成定义

- [x] Batch Lab 不预留免费额度、不查/扣钱包、不写 experience.chat_history
- [x] 普通会话无法选择 internal_research 策略
- [x] 多轮用户输入不变，A/B 只接自己的前序原文，display HTML 不进上下文
- [x] 第 k 轮失败使后续阻塞，重试不重跑前序或其他成功项
- [x] 重复启动、双 worker、Backend kill/restart 不重复成功调用
- [x] 验证命令、失败路径、发布/回滚和 Spec/module payload 完整。
- [x] 本任务独立归档后，父任务仍不完成；必须等待 integration-spec 全量收口。

## Execution Log

- 2026-09-11：完成详细规划；保持 planning，T0 等待人工评审。
- 2026-09-16：用户授权继续其他子任务，执行 `task.py start 09-11-batch-lab-backend-execution`。
- 2026-09-16：完成 shared experiment/worker 契约、`20260916_batch_lab_execution.sql`、实验 repository、internal research generation policy、Batch Lab execution service、实验/worker 路由和 batch-lab client/query keys。
- 2026-09-16：验证通过：`pnpm --filter @miniapp/shared test -- batch-lab-contract`、`pnpm --filter @miniapp/backend test -- execute execution-service BatchLabExecutionRepository batch-lab`、`pnpm --filter @miniapp/batch-lab test -- client query-keys`、`pnpm --filter @miniapp/backend typecheck`、`pnpm --filter @miniapp/shared test`、`pnpm --filter @miniapp/backend test`、`pnpm --filter @miniapp/batch-lab test`、`pnpm --filter @miniapp/batch-lab build`、`pnpm -r typecheck`、`git diff --check`。
- 2026-09-16：已知非本任务阻塞：`pnpm lint:migrations` 仍因已执行旧文件 `110_batch_lab_samples.sql` 的三位数字命名失败；本任务新增 migration 使用 `YYYYMMDD_...`。`pnpm lint:imports` 仍因现有 ESLint 命令 `--rule '{}'` 解析失败。
- 2026-09-16：迁移发布顺序：先保持 Batch Lab execution UI 未开放或关闭入口，在 test 手动单文件执行 `20260916_batch_lab_execution.sql`，验证 RLS/ACL、重复 start 幂等、双 worker SKIP LOCKED 不重复 claim，再按同序执行 production。停止条件：任何钱包/experience 写入、重复成功调用、前序失败后仍运行后续轮次、RLS/ACL 异常即停止。回滚/forward-fix：关闭 execution endpoints，保留表只读审计，确认无消费者后通过审核 migration 删除新增 execution 表和函数。
