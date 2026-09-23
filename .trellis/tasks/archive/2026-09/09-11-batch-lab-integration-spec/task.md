# Task Breakdown

## 依赖

- 其余六个 Batch Lab 子任务均完成并提供证据

## Tasks

| ID  | Status | Task                                   | Files / Scope               | Depends On | Verification                                  |
| --- | ------ | -------------------------------------- | --------------------------- | ---------- | --------------------------------------------- |
| T0  | Done   | 人工评审并确认依赖/环境/安全门禁       | task artifacts + target env | -          | 2026-09-17 继续执行授权；六个前置子任务已归档 |
| T1  | Done   | 冻结 shared 契约、状态、错误与容量限制 | shared contracts/tests      | T0         | shared/backend/batch-lab tests 与 typecheck   |
| T2  | Done   | 实现持久边界、事务/幂等与 repository   | backend/database            | T1         | repository/route/migration payload 验证       |
| T3  | Done   | 实现跨子任务集成与知识收口核心能力     | owned application files     | T2         | Batch Lab spec、README、ARCHITECTURE          |
| T4  | Done   | 覆盖失败、恢复、安全与容量             | tests/runbooks              | T3         | 故障/容量/发布恢复矩阵记录到 spec             |
| T5  | Done   | 完成消费者检查、Spec payload和集成交接 | spec/docs/module updates    | T4         | `module_knowledge.py check` 通过              |

## 父 PRD 验收矩阵

| PRD 项                                                      | Owner                                                      | 子任务/证据                                                                                   | 当前结论                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| S1-S4 样本 SQL、预览、冻结、不可变、零条/重复/不足/缺失处理 | data-samples / integration                                 | `09-11-batch-lab-data-samples`、`.trellis/spec/batch-lab/app/samples-experiments-and-jobs.md` | 已实现并记录；真实目标环境只读 LOGIN/secret 需人工授权验证                 |
| C1-C3 A/B 完整组合、复制隔离、配置冻结、确认页差异          | backend-execution / frontend-workbench                     | `09-11-batch-lab-backend-execution`、`09-11-batch-lab-frontend-workbench`                     | 已实现；历史配置通过冻结 variants 与 copy draft 追溯                       |
| G1-G5 单/多轮、调用数、上下文、失败阻塞、刷新恢复、启动幂等 | backend-execution / history-export                         | `execution-service.ts`、`BatchLabExecutionRepository` tests、Batch Lab workbench              | 已实现；常驻 worker drain 属发布阶段人工演练                               |
| P1-P4 后处理不可变、错误分类、原文保留、复用原文零生成      | postprocessing / history-export                            | `postprocessing-service.ts`、reuse-display route、JSONL contract                              | 已实现；复用原文记录 lineage 且 generation attempts 为 0                   |
| D1/R1 结果详情、配置差异、全部样本/轮次/来源浏览            | frontend-workbench / history-export                        | `packages/batch-lab/src/App.tsx`、experiment detail API                                       | 已实现；Playwright 未安装，人工浏览器渲染仅以本地 200 smoke 替代           |
| E1/E2 JSONL 可解析、完整、失败项与复用来源准确              | history-export / shared                                    | `BATCH_LAB_JSONL_SCHEMA_VERSION`、export route、shared tests                                  | 已实现；导出仅读 `batch_lab` 冻结事实                                      |
| 独立 Vercel SPA、API base、SPA rewrite、Backend CORS        | foundation / integration                                   | `packages/batch-lab/vercel.json`、README、ARCHITECTURE、Batch Lab spec                        | 已收口；Preview 需配置 `VITE_BATCH_LAB_API_URL` 与 backend `BATCH_LAB_URL` |
| `batch_lab` 域、迁移、来源只读、平台写入隔离                | data-samples / postprocessing / execution / history-export | `20260920_batch_lab_samples.sql`、`20260916_*` migrations、module facts                       | 已实现；production 执行仍需手工 migration workflow 与 post-apply 记录      |
| Spec/module facts、README、ARCHITECTURE                     | integration                                                | `.trellis/spec/batch-lab/app/*`、`module-updates.json`、README、ARCHITECTURE                  | 本任务完成                                                                 |

## 发布与恢复收口

- 发布顺序：migration test -> backend feature-off -> CI -> Batch Lab Vercel SPA -> CORS/API base -> worker/feature-on。
- 停止条件：来源写入、真实会话污染、重复扣费、secret 泄漏、worker 无法停止、JSONL 丢事实。
- 回滚策略：优先关闭入口/停止 worker/回退应用；已执行数据库迁移不改历史，用 forward-fix 或关闭 feature。
- 目标环境事项：Vercel Preview、真实来源 LOGIN/secret、生产 migration 与 worker 常驻调度均需要人工授权执行并记录，离线测试不能替代生产事实。

## 完成定义

- [x] 父 PRD每项有自动或可重复人工证据且无未归属缺口
- [x] 普通会话/计费/所有shared consumers回归通过
- [x] 停止条件、worker drain、应用回滚和数据库 forward-fix 演练完成为可重复 runbook；目标环境执行需人工授权
- [x] Vercel静态部署、CI test/build、Preview API base/CORS和SPA rewrite记录完成
- [x] 来源只读连接写入负测路径记录完成，环境业务数据零写入边界固定
- [x] Batch Lab新 spec、既有module facts、modules-index、README/ARCHITECTURE与实现一致
- [x] 验证命令、失败路径、发布/回滚和 Spec/module payload完整。
- [x] 本任务归档后可归档父任务。

## Execution Log

- 2026-09-11：完成详细规划；保持 planning，T0等待人工评审。
- 2026-09-17：确认六个前置子任务已归档；新增 `.trellis/spec/batch-lab/app/` 全套规范，更新 README 与 ARCHITECTURE。
- 2026-09-17：生成并校验 `module-updates.json`，`python .\.trellis\scripts\module_knowledge.py check .trellis\tasks\09-11-batch-lab-integration-spec` 通过。
- 2026-09-17：验证通过：`pnpm --filter @miniapp/shared test -- batch-lab-contract`、`pnpm --filter @miniapp/backend test -- batch-lab execution-service BatchLabExecutionRepository`、`pnpm --filter @miniapp/batch-lab test -- client query-keys workbench`、`pnpm --filter @miniapp/batch-lab build`、`pnpm -r typecheck`、`git diff --check`。
- 2026-09-17：已知失败：`pnpm lint:migrations` 仅因历史已冻结 `20260920_batch_lab_samples.sql` 三位编号失败；`pnpm lint:imports` 因仓库 ESLint 命令 `--rule '{}'` 解析为字符串失败。
