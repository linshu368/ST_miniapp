# Task Breakdown

## 依赖

- 09-11-batch-lab-backend-execution
- 09-11-batch-lab-postprocessing
- 09-11-batch-lab-frontend-workbench

## Tasks

| ID  | Status | Task                                   | Files / Scope               | Depends On | Verification                                  |
| --- | ------ | -------------------------------------- | --------------------------- | ---------- | --------------------------------------------- |
| T0  | Done   | 人工评审并确认依赖/环境/安全门禁       | task artifacts + target env | -          | 用户继续执行授权；依赖任务已归档              |
| T1  | Done   | 冻结 shared 契约、状态、错误与容量限制 | shared contracts/tests      | T0         | JSONL/detail/reuse/annotation schema tests    |
| T2  | Done   | 实现持久边界、事务/幂等与 repository   | backend/database            | T1         | history migration + repository methods        |
| T3  | Done   | 实现历史血缘、复用与导出核心能力       | owned application files     | T2         | Backend routes/client/UI 操作入口             |
| T4  | Done   | 覆盖失败、恢复、安全与容量             | tests/runbooks              | T3         | env mismatch、id mismatch、partial JSONL 测试 |
| T5  | Done   | 完成消费者检查、Spec payload和集成交接 | spec/docs/module updates    | T4         | module-updates + typecheck/test/build         |

## 完成定义

- [x] 复制后修改新草稿不改变来源实验；copy 使用新实验行和深复制 variants。
- [x] reuse 保存新实验、保留 A/B 真实原文来源且模型调用数为零；`reuse_display` 实验不创建 generation attempts。
- [x] 部分失败仍可导出且每个失败项明确存在；JSONL attempts 含 failed/blocked/unknown 状态和错误字段。
- [x] JSONL 每行通过 shared schema 且无需源库即可还原本次输入/组合/窗口/结果。
- [x] 大实验导出走 attachment stream；读取来源为冻结 batch_lab 事实，不把正文写日志。
- [x] 验证命令、失败路径、发布/回滚和 Spec/module payload 完整。
- [x] 本任务独立归档后，父任务仍不完成；必须等待 integration-spec 全量收口。

## Execution Log

- 2026-09-11：完成详细规划；保持 planning，T0等待人工评审。
- 2026-09-16：用户授权继续执行；依赖 `backend-execution`、`postprocessing`、`frontend-workbench` 已完成并归档。
- 2026-09-16：扩展 shared Batch Lab 契约：experiment detail lineage、copy、reuse display、annotation、JSONL schema/version/export row。
- 2026-09-16：新增 `20260916_batch_lab_history_export.sql`，为 `batch_lab.experiments` 增加 `kind/source_experiment_id/generation_source_experiment_id`，新增 `batch_lab.annotations`。
- 2026-09-16：Backend 新增详情、copy、reuse-display、annotation upsert、JSONL export route；export 从冻结 sample snapshots、attempts、annotations 组装，不重新查询源库。
- 2026-09-16：Batch Lab 前端详情抽屉接入复制、复用原文、JSONL 下载和实验备注；query key 按 backend/source environment + experiment id 隔离。
- 2026-09-16：验证通过：
  - `pnpm --filter @miniapp/shared test -- batch-lab-contract`
  - `pnpm --filter @miniapp/backend test -- batch-lab execution-service BatchLabExecutionRepository`
  - `pnpm --filter @miniapp/batch-lab test -- client query-keys workbench`
  - `pnpm --filter @miniapp/batch-lab build`（通过；保留既有 Vite >500k chunk warning）
  - `pnpm -r typecheck`
  - `git diff --check`
