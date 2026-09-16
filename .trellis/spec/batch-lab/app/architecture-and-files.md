# Batch Lab Architecture And Files

## 包边界

`packages/batch-lab` 是 Vite React SPA，依赖 `@miniapp/shared` 的契约类型和 schema。它不 import 其他应用包；与 backend 的协作只通过 `/api/batch-lab/*` HTTP API。

```
packages/batch-lab  ->  packages/shared
packages/backend    ->  packages/shared
packages/shared     ->  migrations and DTOs
```

## 主要文件

| 路径                                                                              | 职责                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/batch-lab/src/App.tsx`                                                  | 内部工作台 UI：样本、processor、实验、详情、复用、导出 |
| `packages/batch-lab/src/api/client.ts`                                            | 浏览器 HTTP client、schema parse 和下载入口            |
| `packages/batch-lab/src/api/query-keys.ts`                                        | React Query key 工厂                                   |
| `packages/batch-lab/src/lib/workbench.ts`                                         | 表单解析、processor config、进度与 diff helper         |
| `packages/backend/src/routes/batch-lab.ts`                                        | Batch Lab HTTP 边界和 `@frontend-ready` 标注           |
| `packages/backend/src/features/batch-lab/`                                        | 样本、processor、execution orchestration               |
| `packages/backend/src/infrastructure/repositories/BatchLabExecutionRepository.ts` | `batch_lab` schema 持久化、lease、copy/reuse/export    |
| `packages/shared/src/api/batch-lab.ts`                                            | 所有浏览器可见 DTO 和运行时 schema                     |
| `packages/shared/migrations/110_batch_lab_samples.sql`                            | 历史样本冻结基础迁移，已冻结，不改名                   |
| `packages/shared/migrations/20260916_batch_lab_execution.sql`                     | 实验与 attempt 状态机                                  |
| `packages/shared/migrations/20260916_batch_lab_history_export.sql`                | copy/reuse lineage、annotation 和 JSONL 导出支撑       |

## UI 设计边界

工作台首屏就是可操作控制台，不做营销式 landing。界面应保持扫描效率：列表、抽屉、状态徽标、表单和下载操作要紧凑且可重复使用。新控件优先复用现有 React Query + CSS pattern，不引入额外 UI framework。

## 状态来源

服务端事实以 backend 响应和 `batch_lab` schema 为准。前端本地状态只保存当前表单、抽屉、选中项和临时输入；刷新后可从 API 恢复的状态不得另建浏览器持久化副本。
