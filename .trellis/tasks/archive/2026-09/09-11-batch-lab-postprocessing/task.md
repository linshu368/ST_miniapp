# Task Breakdown

## 依赖

- 09-11-batch-lab-foundation
- 09-11-batch-lab-data-samples 的 processor/display 存储

## Tasks

| ID  | Status | Task                                   | Files / Scope               | Depends On | Verification                       |
| --- | ------ | -------------------------------------- | --------------------------- | ---------- | ---------------------------------- |
| T0  | Done   | 人工评审并确认依赖/环境/安全门禁       | task artifacts + target env | -          | 用户授权继续其他子任务             |
| T1  | Done   | 冻结 shared 契约、状态、错误与容量限制 | shared contracts/tests      | T0         | schema tests + consumers typecheck |
| T2  | Done   | 实现持久边界、事务/幂等与 repository   | backend/database            | T1         | repository/migration 不变量测试    |
| T3  | Done   | 实现后处理与渲染安全核心能力           | owned application files     | T2         | PRD业务验收                        |
| T4  | Done   | 覆盖失败、恢复、安全与容量             | tests/runbooks              | T3         | 故障注入与停止/回滚演练            |
| T5  | Done   | 完成消费者检查、Spec payload和集成交接 | spec/docs/module updates    | T4         | 验证命令完成，已知旧问题记录       |

## 完成定义

- [x] 编辑仅复制并新建版本，旧版本/旧 display result 不变
- [x] 零匹配为 success+0，所有失败保留原文且不返回空白
- [x] 灾难性回溯被硬终止且不阻塞 Fastify event loop或遗留 worker
- [x] 危险标签/属性/URL/CSS被清洗，原文/代码按文本展示
- [x] 批处理与单条预览执行语义一致，后处理产物不进入生成上下文
- [x] 验证命令、失败路径、发布/回滚和 Spec/module payload完整。
- [x] 本任务独立归档后，父任务仍不完成；必须等待 integration-spec 全量收口。

## Execution Log

- 2026-09-11：完成详细规划；保持 planning，T0等待人工评审。
- 2026-09-16：用户授权继续其他子任务，执行 `task.py start 09-11-batch-lab-postprocessing`。
- 2026-09-16：完成 shared processor/display 契约、`20260916_batch_lab_postprocessing.sql`、processor repository、worker-thread regex executor、安全文本渲染、路由和 batch-lab client/query keys。
- 2026-09-16：验证通过：`pnpm --filter @miniapp/shared test -- batch-lab-contract`、`pnpm --filter @miniapp/backend test -- postprocessing-service BatchLabProcessorRepository batch-lab`、`pnpm --filter @miniapp/batch-lab test -- client query-keys`、`pnpm --filter @miniapp/shared typecheck`、`pnpm --filter @miniapp/backend typecheck`、`pnpm --filter @miniapp/batch-lab typecheck`、`pnpm -r typecheck`、`pnpm --filter @miniapp/shared test`、`pnpm --filter @miniapp/backend test`、`pnpm --filter @miniapp/batch-lab test`、`pnpm --filter @miniapp/batch-lab build`、`git diff --check`。
- 2026-09-16：已知非本任务阻塞：`pnpm lint:migrations` 仍因已执行旧文件 `110_batch_lab_samples.sql` 的三位数字命名失败；本任务新增 migration 使用 `YYYYMMDD_...`。`pnpm lint:imports` 仍因现有 ESLint 命令 `--rule '{}'` 解析失败。
- 2026-09-16：迁移发布顺序：先关闭 Batch Lab 写入入口或保持未开放 UI，在 test 手动单文件执行 `20260916_batch_lab_postprocessing.sql` 并完成文件尾部 post-apply 验证，再按同序执行 production。停止条件：RLS/ACL、不可变 trigger、默认 `none_v1` digest 或 display result 约束任一验证失败即停止发布。回滚/forward-fix：关闭 feature flag，确认无消费者后通过审核 migration 删除新增表和 trigger functions。
