# 包与全局研究清单

## Admin

已盘点根配置、环境模板、Vite/Vercel、入口、全局样式、全部 `components/*`、`lib/*` 与测试。其核心边界是运营 UI → `src/lib` → Supabase/backend；功能包括配置发布/回滚、模型、回复档位、角色卡、公告、裂变和赠送。完整文件职责已写入 `.trellis/spec/admin/app/architecture-and-files.md`。

## CS Platform

已盘点 22 个受控文件。两条业务流为 Telegram 回访和 MiniApp 客服；统一网络入口为 `src/api.ts`，服务器状态由 React Query 管理。当前无测试脚本和 `.env.example`，已作为事实/缺口记录，而非声称已覆盖。

## Shared

已盘点 20 个 `src/api/*.ts`、根出口、database config、st-bridge、logging/telemetry、纯工具及 8 个测试。四个应用包均依赖 shared，shared 不依赖应用包。`migrations/` 是 SQL 唯一来源，不属于 TS 根出口。

## 全局与部署

- workspace 仅 `packages/*`；botlink 独立。
- 根要求 Node >=22/pnpm >=9，但 `.nvmrc`/部分容器仍为 Node 20，已在 README 标记差异。
- 根 `dev`/`dev:all` 只启 frontend + backend。
- Frontend/Admin/CS 目标为 Vercel，Backend 为 Railway，Supabase migration 与部署解耦。
- 环境变量仅从 example/读取点提取名称和用途，未读取或复制真实值。

## 数据库限制

当前执行环境没有可调用的 Supabase MCP，因此不能生成测试库表字段实况。已在 `test-database-reference.md` 明确 Blocked，并规定解阻、采集、对账和脱敏流程。
