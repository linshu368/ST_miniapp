# Batch Lab App Spec

Batch Lab 是独立的内部调试 SPA，用于在冻结样本上批量比较对话生成方案、后处理规则和展示结果。它只通过 HTTP 调用 backend，不直接连接数据库、不持有 service-role key，也不与 `frontend`、`admin`、`cs-platform` 互相 import。

## 文档入口

- [architecture-and-files.md](architecture-and-files.md)：包结构、文件边界和依赖方向。
- [api-and-environments.md](api-and-environments.md)：API base、CORS、环境变量和只读来源约束。
- [samples-experiments-and-jobs.md](samples-experiments-and-jobs.md)：样本 preview/freeze、实验状态机、worker 与故障恢复。
- [postprocessing-results-and-export.md](postprocessing-results-and-export.md)：后处理、结果复用、备注和 JSONL 导出。
- [testing-deployment-and-recovery.md](testing-deployment-and-recovery.md)：验证矩阵、容量边界、发布顺序和回滚。

## 核心约束

- Batch Lab 是内部工具，不是用户端或运营后台能力；V1 不包含生产样本合规、脱敏、审批或自动启用流程。
- 所有对外 DTO 必须先定义在 `packages/shared/src/api/batch-lab.ts`，再由 backend route 和 Batch Lab client 使用。
- 浏览器端只消费 `VITE_BATCH_LAB_API_URL` 指向的 backend HTTP API；不能读取数据库 row 类型、连接串、service-role key 或 provider secret。
- 来源读取由 backend 的 Batch Lab repository 控制，只能 preview/freeze 到 `batch_lab.sample_snapshots`；执行、复用和导出阶段不能回写 `experience` 真实会话域。
- 所有生成调用必须通过 `packages/backend/src/features/generation/` 的内部 research policy 入口，不得另起上游转发、扣费或落库通道。
- 迁移仍位于 `packages/shared/migrations/`，并通过手动 workflow 单文件执行；新迁移使用 `YYYYMMDD_*.sql`，历史三位编号迁移不改名。
