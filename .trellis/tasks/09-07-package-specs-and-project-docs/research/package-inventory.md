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

## 可追溯来源矩阵

| 结论类别                     | 已检索路径                                                                                                        | 输出位置                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| workspace/脚本/版本          | `package.json`、`pnpm-workspace.yaml`、`.nvmrc`、`tsconfig.base.json`、各包 `package.json`                        | 根 README 运行环境、命令、依赖图                                |
| Admin 文件/组件              | `packages/admin/{src,public}/**`、`.env.example`、Vite/TS/Vercel/README 配置                                      | Admin `architecture-and-files.md`、`features-and-components.md` |
| Admin 数据/环境              | `src/lib/{adminApi,announcementsApi,inviteAdminApi,outreachCreditsApi,environment,configSchemas}.ts` 及相关 tests | Admin data/UI/test specs                                        |
| CS 文件/业务流               | `packages/cs-platform/src/{App,api,constants,styles}.ts*`、全部 `components/*.tsx`、包配置                        | CS architecture/features specs                                  |
| CS backend consumer          | `packages/backend/src/routes/cs-platform.ts`、shared `api/{cs-platform,support}.ts`、migrations `024_*`/`094_*`   | CS API/auth spec 与风险记录                                     |
| Shared 出口                  | `packages/shared/src/index.ts`、`package.json`、四个应用包 workspace dependencies                                 | Shared architecture spec                                        |
| Shared API producer/consumer | `packages/shared/src/api/*.ts`，全仓 `@miniapp/shared` imports、backend routes、客户端 helpers                    | Shared api-contracts spec                                       |
| Shared 工具/测试             | `src/{config,logging,st-bridge,telemetry}/**`、顶层纯工具、`src/__tests__/*`                                      | Shared schema/util/test specs                                   |
| 数据库迁移                   | `packages/shared/migrations/*.sql`、`supabase/config.toml`/`seed.sql`                                             | Database migration/schema/security specs                        |
| Schema 历史与运维            | `docs/schema*`、`ops/schema-split/**`、`.github/workflows/db-migrate.yml`                                         | Database evidence/MCP/migration specs                           |
| 部署                         | `ops/**`、`docker-compose.yml`、各 Vercel 配置、backend Docker/Railway 文件、`botlink/Procfile`                   | README 部署拓扑与包部署 specs                                   |
| 环境变量                     | 已提交 `.env.example` 与 `process.env`/`import.meta.env` 读取点；未读取真实值                                     | README 变量分组与各包环境规范                                   |

## Shared 契约 consumer 矩阵

| 契约域                                   | 主要 producer                           | 主要 consumer                                |
| ---------------------------------------- | --------------------------------------- | -------------------------------------------- |
| characters/conversations/models/settings | Backend routes/features                 | Frontend API hooks；部分 Admin 配置/角色运营 |
| wallet/payment/voice                     | Backend wallet/payment/generation/voice | Frontend 钱包、支付、聊天和语音页面          |
| growth/invite/community                  | Backend growth/invite/community routes  | Frontend profile/community；Admin 裂变运营   |
| cs-platform                              | Backend `/api/cs/*`                     | CS Telegram 回访工作台                       |
| support                                  | Backend CS support routes               | CS MiniApp 客服工作台                        |
| health/envelope                          | Backend routes                          | 多客户端基础请求层                           |

具体符号仍以当前源码搜索为准；矩阵表达边界，不替代改动时逐符号 consumer 核验。
