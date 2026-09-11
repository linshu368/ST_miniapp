# ST_miniapp

ST_miniapp 是围绕 Telegram MiniApp、AI 角色聊天、钱包/支付、语音、增长运营和客服能力构建的 pnpm monorepo。仓库包含面向用户的 Next.js 前端、Fastify API、两个内部运营 SPA，以及共享契约/迁移包。

> 深层架构、数据流和路由清单见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；生产运维入口见 [`ops/README.md`](ops/README.md)。本文负责新成员入门、依赖关系、环境、命令和交付约定。

## 0. 运行环境

| 依赖         | 要求                                              |
| ------------ | ------------------------------------------------- |
| Node.js      | `>=22`（根 `package.json` 和 backend 的权威要求） |
| pnpm         | `>=9`，仓库锁定 `pnpm@9.15.9`                     |
| Supabase CLI | 本地 Supabase、链接测试项目和手工 SQL 操作需要    |
| Docker       | 可选，用于本地依赖或部署镜像验证                  |

当前存在配置差异：`.nvmrc` 和部分 Dockerfile 仍使用 Node 20，而根工程要求 Node 22。开发/CI 以 Node 22 为准；调整容器版本前需单独验证，不要假设完全一致。

## 1. 开发配置

### 1.1 初始配置

0. 拉取git仓库创建个人分支 参考 1.2 要求
1. 第一次 pnpm install 会装 husky。之后 git commit 会跑 Prettier；git push 若改了 frontend，会做一次 不阻断 的 lint 提醒。
2. prisma generate 必须做一次。CI 也会跑；漏了的话 backend 启动会找不到 @prisma/client 生成物。
3. 不要在本地对共享测试库执行 Prisma migrate / 乱跑 packages/shared/migrations/\*.sql。迁移由 GitHub Actions「Database Migration」手动触发，见 packages/shared/migrations/README.md
4. copy backend env.example文件 根据railway配置本地env配置，DEV_AUTH_BYPASS强制为1不然本地浏览器不适配
5. 配置frontend env.local文件 配置NEXT_PUBLIC_API_URL 指向本地服务地址，NEXT_PUBLIC_USE_MOCK强制为0

### 1.2 feature开发步骤

1. 所有 feature 分支从最新 origin/dev 新建，不要从 main、不要从过期的本地 dev。
2. main 是上线快照。 生产部署跟 main。不要直接往 main 推日常开发提交。
3. dev 不可落后于 main。 生产 hotfix 合进 main 之后，必须回到 dev。你拉 feature 之前先 git fetch + 确认本地 dev 已快进到 origin/dev。
4. 合入目标是 dev（PR base = dev）。不要把未发布的 feature 直接打到 main
5. 提交合并至 dev 得 PR 后根据 PR 审查文档判断 P0 P1 得问题是否有风险 是否需要修改，将 Preview 链接 打到 telegram bot 上进行测试，自测没有问题后，再通知相关人员确认是否合并进 dev （需要压缩合并，方便有问题回滚）

## 2. Workspace 与依赖关系

```text
packages/frontend ─┐
packages/backend  ─┼──> packages/shared
packages/admin    ─┤
packages/cs-platform┘

```

`pnpm-workspace.yaml` 只包含 `packages/*`。四个应用包可以依赖 `@miniapp/shared`，但彼此不得直接 import；跨应用通信使用 HTTP。Shared 不依赖应用包。

| 目录                   | 包名/形态                           | 主要职责                                                    | 默认开发端口 |
| ---------------------- | ----------------------------------- | ----------------------------------------------------------- | ------------ |
| `packages/frontend`    | `@miniapp/frontend` / Next.js 14    | Telegram MiniApp 用户界面、聊天、钱包、支付、语音、社区等   | 3000         |
| `packages/backend`     | `@miniapp/backend` / Fastify 5      | API、鉴权、生成/计费、Supabase/Prisma、支付、Telegram、客服 | 3001         |
| `packages/admin`       | `@miniapp/admin` / Vite React       | 配置、模型、角色卡、公告、裂变和运营赠送                    | 3003         |
| `packages/cs-platform` | `@miniapp/cs-platform` / Vite React | Telegram 回访与 MiniApp 客服工作台                          | 3002         |
| `packages/shared`      | `@miniapp/shared` / TS 源码包       | API DTO、Zod schema、常量、纯工具和 SQL migrations          | -            |

Shared 的 `main`/`types` 直接指向 `src/index.ts`，没有独立 build 产物；修改公开出口会直接影响所有消费者。

## 3. 技术栈

- **Frontend**：Next.js 14、React 18、TypeScript、TanStack React Query、Zustand、React Hook Form、Zod、Radix UI、Tailwind CSS、Telegram SDK、Sentry。
- **Backend**：Node.js、Fastify 5、TypeScript/tsx、Prisma、Supabase JS、Pino、Vitest、Sentry、WebSocket。
- **Admin**：Vite、React 18、Ant Design 6、Refine、Supabase JS、Zod、dnd-kit、Vitest。
- **CS Platform**：Vite、React 18、TanStack React Query、原生 CSS；当前无自动测试脚本。
- **Shared/Database**：TypeScript + Zod + Vitest；PostgreSQL/Supabase migrations 位于 `packages/shared/migrations/`。

## 4. 安装与开发

```bash
corepack enable
pnpm install --frozen-lockfile

# 用户端与 API（根 dev/dev:all 当前都只启动这两个包）
pnpm dev

# 分别启动
pnpm dev:frontend
pnpm dev:backend
pnpm dev:admin
pnpm dev:cs-platform
```

注意：`pnpm dev:all` 当前与 `pnpm dev` 相同，并不会启动 Admin 或 CS Platform。

常用检查：

```bash
pnpm typecheck
pnpm lint
pnpm lint:imports
pnpm format:check

pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/admin test

pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin build
pnpm --filter @miniapp/cs-platform build
```

CS Platform 当前没有 `test` script；变更需至少 typecheck/build 并记录人工回归。

## 5. 环境变量

不要提交真实 `.env`。浏览器端 `NEXT_PUBLIC_*` 与 `VITE_*` 会进入 bundle，不能存放 secret。完整变量以各包 `.env.example`、源码读取点和部署平台为准。

### Backend 主要变量组

| 类别            | 变量                                                                                                                                                                    | 说明                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Runtime/CORS    | `NODE_ENV`, `PORT`, `FRONTEND_URL`, `CS_PLATFORM_URL`, `ADMIN_PLATFORM_URL`                                                                                             | 服务环境、端口和允许来源                                                 |
| 数据库选择      | `DATABASE_ENV`, `TEST_*`, `PROD_*`, `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_*`                                                                                          | 测试/生产项目、连接与 service role；`ALLOW_PROD_DATABASE` 仅紧急人工操作 |
| Telegram        | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `BOT_INTERNAL_SECRET`, `TELEGRAM_COMMUNITY_BOT_TOKEN`                                                                  | Bot、webhook 和内部调用鉴权                                              |
| CS              | `CS_ADMIN_TOKEN`, `CS_TELEGRAM_WEBHOOK_SECRET`                                                                                                                          | CS 请求头和 webhook 鉴权                                                 |
| LLM             | `LLM_UPSTREAM_URL`, `LLM_API_KEY`, `OPENAI_API_KEY`, `LLM_DEFAULT_MODEL`                                                                                                | 生成上游与默认模型                                                       |
| Voice           | `DEEPSEEK_*`, `MINIMAX_*`                                                                                                                                               | 语音文案与 TTS；关键 key 缺失时语音不可用                                |
| Payment         | `PAYMENT_ENABLED`, `PAYMENT_BASE_URL`, `PAYMENT_MERCHANT_ID`, `PAYMENT_MERCHANT_PRIVATE_KEY`, `PAYMENT_PLATFORM_PUBLIC_KEY`, `PAYMENT_NOTIFY_URL`, `PAYMENT_RETURN_URL` | 支付开关、商户和签名/回调                                                |
| Cache/Telemetry | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `SENTRY_*`, `LOG_LEVEL`, `LOG_PRETTY`                                                                             | Redis、Sentry 和日志                                                     |
| Feature/asset   | `DEFAULT_USER_AVATAR_URL`, `CHARACTER_STORAGE_BUCKET`, `CHAT_HISTORY_SYNC_ENABLED`, `LOBBY_RANKING_REFRESH_ENABLED`                                                     | 资源和运行开关                                                           |

开发 bypass（如 `MOCK_AUTH`、`DEV_AUTH_BYPASS`）禁止在 production 启用。

### Frontend

主要包括 `NEXT_PUBLIC_API_URL`、`NEXT_PUBLIC_USE_MOCK`、`NEXT_PUBLIC_DEFAULT_USER_AVATAR_URL`、`NEXT_PUBLIC_SENTRY_DSN`、`NEXT_PUBLIC_SENTRY_ENVIRONMENT`。仓库当前有本地 `.env.local`，不得把其中值复制到文档或日志；新增变量应补安全的 example 模板。

### Admin

`packages/admin/.env.example` 定义：

- `VITE_ADMIN_TEST_SUPABASE_URL` / `VITE_ADMIN_TEST_SUPABASE_ANON_KEY` / `VITE_ADMIN_TEST_API_URL`
- `VITE_ADMIN_PROD_SUPABASE_URL` / `VITE_ADMIN_PROD_SUPABASE_ANON_KEY` / `VITE_ADMIN_PROD_API_URL`

anon key 是浏览器公开配置，但仍应按环境隔离；service-role 绝不能放入 Admin。

### CS Platform

`VITE_API_URL`、`VITE_CS_TEST_API_URL`、`VITE_CS_PROD_API_URL` 控制回访默认 API 和 MiniApp 客服环境。当前没有 `.env.example`，部署时必须显式核对，后续新增/修改变量应同步补模板。

## 6. Supabase 与数据库迁移

```bash
pnpm supabase:start
pnpm supabase:status
pnpm supabase:stop
pnpm supabase:link:test
```

- `packages/shared/migrations/` 是唯一 SQL migration 来源；不要复制到 `supabase/migrations/`。
- `supabase/config.toml` 的 migration schema path 当前不会自动重放 shared migrations，因此本地 reset/push 不代表项目迁移链已完整执行。
- 远端 migration 默认通过 [`.github/workflows/db-migrate.yml`](.github/workflows/db-migrate.yml) 的手工 `workflow_dispatch` 单文件执行；保留项目 ref 校验、production 明文确认和环境并发锁。先测试后生产，每一步记录前后结构、RLS/grants、关键读写、锁/容量和回滚。
- 2026-09-10 起新 migration 使用 `YYYYMMDD_描述.sql`；workflow 以 `psql --file` 执行，并在 `supabase_migrations.repo_migrations` 中按 filename/checksum 查重和记账。历史三位编号文件已冻结且可能重号，不得按编号推断环境状态。
- 测试库与生产库不保证同构。数据库结构参考必须标注环境、时间和证据，不能拿 migration 当实库快照。
- 详细规则见 [Supabase spec](.trellis/spec/database/supabase/index.md)。

## 7. 部署拓扑

| 单元        | 平台/配置                                                     | 注意事项                                                                  |
| ----------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Frontend    | Vercel（仓库内无包级 `vercel.json`）                          | 依赖 Vercel 项目 Root Directory/框架设置，发布前核对变量与 backend URL    |
| Admin       | Vercel，`packages/admin/vercel.json` 或根 `vercel.admin.json` | 哪份生效取决于 Root Directory，不会自动合并                               |
| CS Platform | Vercel，`packages/cs-platform/vercel.json`                    | 静态 SPA rewrite；Preview 不应默认写生产                                  |
| Backend     | Railway / backend Docker 配置                                 | Railway IaC 与变量流程见 [`ops/railway/README.md`](ops/railway/README.md) |
| Supabase    | 托管 PostgreSQL/PostgREST/Auth/Storage                        | migration 与应用部署分离，禁止随应用发布自动执行生产迁移                  |

每次部署记录目标环境、commit、变量变更、数据库前置条件、smoke test 和回滚目标。不要因为测试部署成功就自动修改生产。

## 8. 编码与架构规则

- TypeScript strict，禁止新增 `any`；外部未知数据从 `unknown` 开始校验。
- 外部 HTTP/SSE 契约先定义于 `packages/shared/src/api/*`；客户端不得消费数据库 row。
- 应用包之间不互相 import。Frontend 服务端数据走 `src/lib/api` React Query hooks；Admin/CS 使用各自统一 API helper。
- Backend route 保留 `@frontend-ready` 注释；LLM 生成/计费走 `features/generation`；运行时配置走 `platform/runtime-config.ts`。
- 服务日志使用 Pino，原始错误记录 `{ err }`；只记录 allowlist 请求字段、结果摘要、耗时和链路，不记录 token/密钥/完整敏感正文。
- 设计优先复用稳定能力和最小充分实现。可靠性基于真实故障模型；重试有限且只用于安全操作，关键写入评估幂等、并发和补偿。

详细规则见根 [`AGENTS.md`](AGENTS.md) 与 [`.trellis/spec/`](.trellis/spec/)。

## 9. Trellis 开发流程

非琐碎任务：创建 task → 编写/审核 PRD → 复杂任务补 design/implement/task → 配置 context → `task.py start` → 实施/检查 → spec 更新 → 提交/归档。

规划必须回答复用调研、故障模型、高可用措施适用性、最小方案、兼容/迁移/回滚和失败路径验证。不要把“高可用”当作堆叠基础设施的理由，也不要用“简洁”省略必要安全与恢复。

## 10. Commit 与分支协作

- 参考近期历史使用 Conventional Commit：`feat:`、`fix:`、`docs:`、`chore:`、`test:`、`refactor:`。
- 一个 commit 对应一个可独立理解/回滚的变更单元；提交前运行受影响门禁。
- 不提交 `.env`、数据库导出、构建缓存、个人数据或 secret；不要 amend/push 未经用户确认的提交。
- 合并 （如 `origin/dev`）时，上游变更视为只读。冲突时保留上游行为，仅调整当前分支工作；若必须改变上游逻辑，先解释并取得确认。

## 11. 文档入口

- [系统架构](docs/ARCHITECTURE.md)
- [运维总览](ops/README.md)
- [日志系统](docs/log_system.md)
- [数据库域与归属](docs/ARCHITECTURE.md#51-数据库八域布局099-之后test-与生产一致)
- [Trellis 工作流](.trellis/workflow.md)
- [Admin spec](.trellis/spec/admin/app/index.md)
- [CS Platform spec](.trellis/spec/cs-platform/app/index.md)
- [Shared spec](.trellis/spec/shared/contracts/index.md)
- [Supabase spec](.trellis/spec/database/supabase/index.md)
