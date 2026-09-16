# Batch Lab API And Environments

## API Base

Batch Lab 使用 `VITE_BATCH_LAB_API_URL` 配置 backend base URL。本地默认可指向 `http://127.0.0.1:3001`；Vercel Preview 必须显式配置到对应 Railway/preview backend，不能默认写生产。

Backend CORS 通过 `BATCH_LAB_URL` allowlist Batch Lab SPA origin。Vercel 域名变化时需要同时更新 frontend build-time 变量和 backend runtime 变量并重新部署。

## HTTP 契约

所有响应和请求体形状来自 `packages/shared/src/api/batch-lab.ts`。新增 route 前先补 shared schema，再补 backend route/client consumer typecheck。

核心 route：

- `GET /api/batch-lab/sample-preview`
- `POST /api/batch-lab/sample-sets`
- `GET /api/batch-lab/processors`
- `POST /api/batch-lab/processors/preview`
- `POST /api/batch-lab/processors`
- `GET /api/batch-lab/experiments`
- `POST /api/batch-lab/experiments`
- `POST /api/batch-lab/experiments/:id/start`
- `POST /api/batch-lab/worker/run-once`
- `GET /api/batch-lab/experiments/:id`
- `POST /api/batch-lab/experiments/:id/copy`
- `POST /api/batch-lab/experiments/:id/reuse-display`
- `PUT /api/batch-lab/experiments/:id/annotations`
- `GET /api/batch-lab/experiments/:id/export.jsonl`

## 环境隔离

- `DATABASE_ENV` 决定 backend 使用 test/prod 来源；Batch Lab UI 只能显示当前 source environment，不自行切库。
- 来源只读连接用于 preview/freeze，不允许 INSERT/UPDATE/DELETE/TRUNCATE/DDL。负测必须验证只读角色写入失败。
- `batch_lab` schema 是调试事实域；copy、reuse、annotation、export 只写或读该域。
- V1 不提供生产自动启用、样本脱敏审批或合规工作流；相关流程必须另建任务。

## 日志与安全

Route 日志只记录 allowlist 字段、内部 id、状态、耗时和摘要。不记录 SQL 敏感值、完整 prompt、完整输出、token、secret、service-role key 或 initData。
