# ST_miniapp

ST_miniapp 是围绕 Telegram MiniApp、AI 角色聊天、钱包/支付、语音、增长运营和客服能力构建的 pnpm monorepo。仓库包含面向用户的 Next.js 前端、Fastify API、内部运营 SPA、共享契约/迁移包，以及由 Frontend 和 Admin 共用的回复渲染包。客服平台已拆到独立仓库 [`linshu368/ST_cs_platform`](https://github.com/linshu368/ST_cs_platform)，本仓库只保留 Bot 消息转发和 `/api/support/*` 代理。

> 深层架构、数据流和路由清单见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；Railway 生产运维见 [`ops/railway/README.md`](ops/railway/README.md)。本文负责新成员入门、依赖关系、环境、命令和交付约定。

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
5. 配置 frontend `.env.local` 文件，使 `NEXT_PUBLIC_API_URL` 指向本地 Backend。

### 1.2 feature开发步骤

1. 所有 feature 分支从最新 origin/dev 新建，不要从 main、不要从过期的本地 dev。
2. main 是上线快照。 生产部署跟 main。不要直接往 main 推日常开发提交。
3. dev 不可落后于 main。 生产 hotfix 合进 main 之后，必须回到 dev。你拉 feature 之前先 git fetch + 确认本地 dev 已快进到 origin/dev。
4. 合入目标是 dev（PR base = dev）。不要把未发布的 feature 直接打到 main
5. 提交合并至 dev 得 PR 后根据 PR 审查文档判断 P0 P1 得问题是否有风险 是否需要修改，将 Preview 链接 打到 telegram bot 上进行测试，自测没有问题后，再通知相关人员确认是否合并进 dev （需要压缩合并，方便有问题回滚）

## 2. Workspace 与依赖关系

```text
packages/frontend    ─┐
packages/admin       ─┴──> packages/reply-renderer ──> packages/shared
packages/admin       ───┐
packages/admin-cli   ───┴──> packages/admin-client ──> packages/shared
packages/backend     ───────────────────────────────> packages/shared

```

`pnpm-workspace.yaml` 只包含 `packages/*`。三个应用包可以依赖 `@miniapp/shared`，但彼此不得直接 import；跨应用通信使用 HTTP。Shared 不依赖应用包。

| 目录                      | 包名/形态                                | 主要职责                                                                 | 默认开发端口 |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ | ------------ |
| `packages/frontend`       | `@miniapp/frontend` / Next.js 14         | Telegram MiniApp 用户界面、聊天、钱包、支付、语音、社区等                | 3000         |
| `packages/backend`        | `@miniapp/backend` / Fastify 5           | API、鉴权、生成/计费、Supabase/Prisma、支付、Telegram、客服代理          | 3001         |
| `packages/admin`          | `@miniapp/admin` / Vite React            | 运营平台网页：配置、模型、角色卡、公告、裂变                             | 3003         |
| `packages/admin-client`   | `@miniapp/admin-client` / TS 源码包      | 运营平台网页与 CLI 共用：配置注册表与校验、菜单分组、Admin RPC/HTTP 调用 | -            |
| `packages/admin-cli`      | `@miniapp/admin-cli` / Node CLI          | 生产运营平台命令行 `pnpm admin`，见 `packages/admin-cli/README.md`       | -            |
| `packages/shared`         | `@miniapp/shared` / TS 源码包            | API DTO、Zod schema、文本后处理编译/执行纯工具和 SQL migrations          | -            |
| `packages/reply-renderer` | `@miniapp/reply-renderer` / React 源码包 | Frontend/Admin 共用的安全 Markdown、受限 HTML/CSS 和可信交互渲染         | -            |

Shared 的 `main`/`types` 直接指向 `src/index.ts`，没有独立 build 产物；修改公开出口会直接影响所有消费者。

图片广场目录的 USD 标准价与统一定价参数随运营草稿保存、发布和回滚；重新打开读取保存值。改变参数不会自动改写已发布星尘价，仍需明确重算并发布，详见 `packages/admin/README.md`。

## 3. 技术栈

- **Frontend**：Next.js 14、React 18、TypeScript、TanStack React Query、Zustand、Radix UI、Tailwind CSS、Telegram SDK、Sentry。
- **Backend**：Node.js、Fastify 5、TypeScript/tsx、Prisma、Supabase JS、Pino、Vitest、Sentry、WebSocket。
- **Admin**：Vite、React 18、Ant Design 6、Refine、Supabase JS、Zod、dnd-kit、Vitest。
- **Reply Renderer**：React 18 peer dependency、Showdown、DOMPurify、隔离 Worker、Vitest/jsdom。
- **Shared/Database**：TypeScript + Zod + parse5 + css-tree + Vitest；PostgreSQL/Supabase migrations 位于 `packages/shared/migrations/`。

## 4. 安装与开发

```bash
corepack enable
pnpm install --frozen-lockfile

# 用户端与 API
pnpm dev

# 分别启动
pnpm dev:frontend
pnpm dev:backend
pnpm dev:admin
```

常用检查：

移动端页面预览使用 `pnpm preview:ui`，场景入口 `http://127.0.0.1:3121`。固定浏览器验收用 `pnpm test:ui --grep @profile`（或 `@roleplay` / `@chat` / `@image`）按组运行。首次安装、手机尺寸、报告及新增场景方法见 [移动端验收说明](packages/ui-tests/README.md)。该环境使用虚构数据，正式发布仍遵循既有质量检查。

按功能的固定验收分组（`@chat`、`@creator`、`@drama` 等）见 [移动端验收说明](packages/ui-tests/README.md)；数据库隔离验证脚本统一放在 `scripts/test-*.sh`，用法见各脚本头部注释。

```bash
pnpm typecheck
pnpm lint
pnpm lint:imports
pnpm format:check

pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/admin test
pnpm --filter @miniapp/reply-renderer test

pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin build
pnpm --filter @miniapp/reply-renderer typecheck

# 图片广场初始数据（默认只读 dry-run）
pnpm --filter @miniapp/backend image-plaza:seed -- --input <xlsx>
```

## 5. 环境变量

不要提交真实 `.env`。浏览器端 `NEXT_PUBLIC_*` 与 `VITE_*` 会进入 bundle，不能存放 secret。完整变量以各包 `.env.example`、源码读取点和部署平台为准。

### Backend 主要变量组

| 类别          | 变量                                                                                                                | 说明                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Runtime/CORS  | `NODE_ENV`, `PORT`, `FRONTEND_URL`, `ADMIN_PLATFORM_URL`                                                            | 服务环境、端口和允许来源                                                                                        |
| 数据库选择    | `DATABASE_ENV`, `TEST_*`, `PROD_*`, `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_*`                                      | 测试/生产项目、连接与 service role；`ALLOW_PROD_DATABASE` 仅紧急人工操作                                        |
| Telegram      | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `BOT_INTERNAL_SECRET`, `TELEGRAM_COMMUNITY_BOT_TOKEN`              | Bot、webhook 和内部调用鉴权                                                                                     |
| CS 服务       | `CS_SERVICE_URL`, `CS_SERVICE_SECRET`                                                                               | 独立客服服务（ST_cs_platform）地址和共享密钥；Bot 转发与 `/api/support/*` 代理使用，`CS_SERVICE_ENABLED` 已废弃 |
| LLM           | `LLM_UPSTREAM_URL`, `LLM_API_KEY`, `OPENAI_API_KEY`, `LLM_DEFAULT_MODEL`                                            | 生成上游与默认模型                                                                                              |
| Voice         | `DEEPSEEK_*`, `MINIMAX_*`                                                                                           | 语音文案与 TTS；关键 key 缺失时语音不可用                                                                       |
| Payment       | `PAYMENT_ENABLED`, `PAYMENT_RETURN_URL`, `PAYMENT_NOTIFY_URL`, `TTZF_APP_ID`, `TTZF_APP_KEY`, `TTZF_BASE_URL`       | TTZF 易支付；应用 ID/密钥也需配置到对账 Worker 与过期 Cron。关新建单不停止已配置订单的通知/查单恢复。           |
| Admin CLI     | `ADMIN_CLI_ALLOWED_EMAILS`                                                                                          | 运营平台 CLI 免密登录白名单（逗号分隔邮箱）；为空时 CLI 登录接口关闭                                            |
| Telemetry     | `SENTRY_*`, `LOG_LEVEL`, `LOG_PRETTY`                                                                               | Sentry 和日志                                                                                                   |
| Feature/asset | `DEFAULT_USER_AVATAR_URL`, `CHARACTER_STORAGE_BUCKET`, `CHAT_HISTORY_SYNC_ENABLED`, `LOBBY_RANKING_REFRESH_ENABLED` | 资源和运行开关                                                                                                  |

Venice 使用 `VENICE_API_BASE_URL` / `VENICE_API_KEY`，Surplus Intelligence 使用 `SURPLUS_API_BASE_URL` / `SURPLUS_API_KEY`；供应商凭据只配置在 Backend，不得放入前端环境变量。

Surplus Intelligence 的官方默认 API 为 `https://api.surplusintelligence.ai/v1`，现有内部 provider 标识 `surplus` 保持兼容。聊天调用明细写入 `experience.surplusintelligence_chat_history`，保存实际非正文参数及按来源过滤的响应元数据；会话正文和账务结果仍归 `chat_history`。启用前必须先执行并验证完整兼容迁移 `20261110_surplusintelligence_chat_history_compat.sql`（原文件保留不改），再部署应用、通过运营 CLI 发布模型配置，具体顺序与恢复见 [迁移说明](packages/shared/migrations/README.md)。仓库实现不代表远端迁移或真实供应商验收已完成。

开发 bypass（如 `MOCK_AUTH`、`DEV_AUTH_BYPASS`）禁止在 production 启用。

### Frontend

主要包括 `NEXT_PUBLIC_API_URL`、`NEXT_PUBLIC_DEFAULT_USER_AVATAR_URL`、`NEXT_PUBLIC_SENTRY_DSN`、`NEXT_PUBLIC_SENTRY_ENVIRONMENT`；可选 `NEXT_PUBLIC_DRAMA_STREAM_ORIGIN`（短剧 Stream 播放域名，仅用于 preconnect，本地不配不影响功能）；可选 `NEXT_PUBLIC_DRAMA_IOS_HLSJS`（设为 `true` 时，iOS 短剧播放在设备支持 `ManagedMediaSource` 时改用 hls.js 低档起播；未设置或非 `true` 默认关闭，走现有原生 HLS）。仓库当前有本地 `.env.local`，不得把其中值复制到文档或日志；新增变量应补安全的 example 模板。

### Admin

`packages/admin/.env.example` 定义：

- `VITE_ADMIN_TEST_SUPABASE_URL` / `VITE_ADMIN_TEST_SUPABASE_ANON_KEY` / `VITE_ADMIN_TEST_API_URL`
- `VITE_ADMIN_PROD_SUPABASE_URL` / `VITE_ADMIN_PROD_SUPABASE_ANON_KEY` / `VITE_ADMIN_PROD_API_URL`

anon key 是浏览器公开配置，但仍应按环境隔离；service-role 绝不能放入 Admin。

Admin Vercel Preview 在构建期固定 API 映射：普通 branch Preview 与 `dev -> main` 发布 PR 必须配置 HTTPS 的 `VITE_ADMIN_TEST_API_URL`；目标分支为 `dev` 的功能 PR 固定使用 `https://stminiapp-pr-<PR号>.up.railway.app`。构建会拒绝缺失或非 HTTPS 的稳定 TEST 映射；PR Railway workflow 同时验证后端健康和 Admin 代理的 Vercel CORS 预检。

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

| 单元     | 平台/配置                                                     | 注意事项                                                                  |
| -------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Frontend | Vercel（仓库内无包级 `vercel.json`）                          | 依赖 Vercel 项目 Root Directory/框架设置，发布前核对变量与 backend URL    |
| Admin    | Vercel，`packages/admin/vercel.json` 或根 `vercel.admin.json` | 哪份生效取决于 Root Directory，不会自动合并                               |
| Backend  | Railway / backend Docker 配置                                 | Railway IaC 与变量流程见 [`ops/railway/README.md`](ops/railway/README.md) |
| Supabase | 托管 PostgreSQL/PostgREST/Auth/Storage                        | migration 与应用部署分离，禁止随应用发布自动执行生产迁移                  |

每次部署记录目标环境、commit、变量变更、数据库前置条件、smoke test 和回滚目标。不要因为测试部署成功就自动修改生产。

## 8. 编码与架构规则

- TypeScript strict，禁止新增 `any`；外部未知数据从 `unknown` 开始校验。
- 外部 HTTP/SSE 契约先定义于 `packages/shared/src/api/*`；客户端不得消费数据库 row。
- 应用包之间不互相 import。Frontend 服务端数据走 `src/lib/api` React Query hooks；Admin 使用统一 API helper。
- Backend route 保留 `@frontend-ready` 注释；LLM 生成/计费走 `features/generation`；运行时配置走 `platform/runtime-config.ts`。
- 服务日志使用 Pino，原始错误记录 `{ err }`；只记录 allowlist 请求字段、结果摘要、耗时和链路，不记录 token/密钥/完整敏感正文。
- 设计优先复用稳定能力和最小充分实现。可靠性基于真实故障模型；重试有限且只用于安全操作，关键写入评估幂等、并发和补偿。
- 运行时代码单文件 ≤500 行、单函数 ≤120 行，`pnpm lint:complexity` 在 CI 阻断新增超标；存量超标见 `scripts/complexity-baseline.json`，改到时顺手拆小。定期复盘用 `pnpm complexity:report`。

详细规则见根 [`AGENTS.md`](AGENTS.md) 与 [`.trellis/spec/`](.trellis/spec/)。

## 9. Trellis 开发流程

非琐碎任务：创建 task → 编写/审核 PRD → 复杂任务补 design/implement/task → 配置 context → `task.py start` → 实施/检查 → spec 更新 → 提交/归档。

任务最后一次提交超过 14 天后用 `python3 .trellis/scripts/archive_stale.py --apply` 归档。归档目录写在 `.ignore` 里，AI/ripgrep 默认搜不到；查历史用 `rg -u`。功能上线状态、发布顺序等过程记录写在任务目录，不写进本 README。

规划必须回答复用调研、故障模型、高可用措施适用性、最小方案、兼容/迁移/回滚和失败路径验证。不要把“高可用”当作堆叠基础设施的理由，也不要用“简洁”省略必要安全与恢复。

## 10. Commit 与分支协作

- 参考近期历史使用 Conventional Commit：`feat:`、`fix:`、`docs:`、`chore:`、`test:`、`refactor:`。
- 一个 commit 对应一个可独立理解/回滚的变更单元；提交前运行受影响门禁。
- 不提交 `.env`、数据库导出、构建缓存、个人数据或 secret；不要 amend/push 未经用户确认的提交。
- 合并 （如 `origin/dev`）时，上游变更视为只读。冲突时保留上游行为，仅调整当前分支工作；若必须改变上游逻辑，先解释并取得确认。

## 11. 文档入口

- [系统架构](docs/ARCHITECTURE.md)
- [首 token 兜底、数据口径与人工观察](docs/first-token-fallback.md)
- [Grafana 看板说明](docs/grafana/README.md)：经营核心 `st-model-overview`，工程看板 `st-engineering-pages/roleplay/drama/backend`（首字与兜底在 roleplay）
- [短剧播放耗时排查](docs/drama-playback-timing.md) · [短剧 CDN 对照发布](ops/drama-cdn-rollout.md)
- [MiniApp 开屏性能](docs/miniapp-startup-performance.md)
- [数据库迁移目录与发布顺序](packages/shared/migrations/README.md)
- [Railway 运维](ops/railway/README.md)
- [支付上游探测与新增策略](docs/payment-availability-probe.md)
- [后端日志与可观测性](.trellis/spec/backend/app/data-reliability-and-security.md)
- [数据库域与归属](docs/ARCHITECTURE.md#51-数据库九域布局media_plaza-m1-之后)
- [Trellis 工作流](.trellis/workflow.md)
- [Admin spec](.trellis/spec/admin/app/index.md)
- [Shared spec](.trellis/spec/shared/contracts/index.md)
- [Supabase spec](.trellis/spec/database/supabase/index.md)

短剧推荐列表置顶环境清单中的 30 部剧。所有账号播放清单指定单集时使用 Cloudflare Stream，播放其他单集时使用 Supabase。配置、重试与验收见[短剧播放来源](docs/drama-stream-ab.md)。iPhone 真机操作见[点播采样工具](scripts/ios-drama-sampler/README.md)。

### VIP 混合奖励（2026-11-05）

`20261105_vip_mixed_rewards.sql` 先经测试环境再生产执行，随后发布应用，最后通过运营 CLI 发布混合签到与开卡赠礼配置。旧签到数字及旧订单继续兼容；开卡奖励使用订单两钱包快照，同事务入账且不增加实付收入。回退先恢复旧配置，保留混合发放支持处理在途订单。详见 `.trellis/tasks/11-05-vip-mixed-rewards/`。

支付接入：TTZF 易支付建单不发送可选 `param`，回调与查单不要求回传该字段；环境隔离依赖独立回调地址、应用凭据及数据库，本环境订单仍需通过签名、商户、渠道、交易号及金额校验。见 `ops/railway/README.md`。

支付上游探测采用独立 `stminiapp-payment-availability-probe` Cron，默认每半小时一次 1 元待支付建单，不保存本地订单。仅 `PAYMENT_PROBE_ENABLED=true` 开启，默认关闭；`PAYMENT_PROBE_CHANNEL` 默认支付宝，探测 IP 自动获取本机 IPv4，无需配置。策略注册位于 `features/payment/availability/strategies/index.ts`，默认复用共享飞书告警。使用与扩展见 [探测说明](docs/payment-availability-probe.md)；仓库配置不代表远端已启用。

查单响应兼容厂商返回 `pid: null` 或省略 pid，有值时仍核对应用 ID；查单请求凭据、回调 pid/签名和订单结算校验保持必需。

### 聊天回复负反馈

回复点踩通过独立鉴权接口保存到 `experience.chat_reply_feedback`，空原因可提交，固定回复/编辑版本去重并保留当轮快照。只在面板打开时读取，不进入生成、计费或角色评分链路，无运营页面。迁移顺序、权限和批量分析口径见 [聊天回复反馈](docs/chat-reply-feedback.md)。

### 幕间入口与归因（本地接入）

幕间复用短剧 API；两端进入事实、精准 CORS 来源、迁移与本地验收见 [幕间接入说明](docs/mujian-integration.md)。新增迁移与应用发布分开，未执行线上迁移或部署。
