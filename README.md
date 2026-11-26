# ST_miniapp

2026-11-25 聊天详情与恢复拆分（本地候选）：聊天首屏取最近 3 轮，向上查看时才翻旧页。详情不再等待流式恢复，既有后台任务收口并通过原详情轮询更新。见[读取和恢复说明](docs/chat-history-first-entry.md#2026-11-25-详情与同步恢复拆分)。

2026-11-25 聊天入口优化（本地候选）：有界路由预热和loading、当前会话历史就绪后放行次要请求、复用账号/会话角色缓存、同visit导航分段。私有历史策略和服务端恢复保持；本次未发布，按用户要求不做本地UI测试，见[缓存与验收说明](docs/chat-history-first-entry.md#2026-11-25-聊天路由与客户端缓存本地候选)。11-23基础优化已在本轮线上c046f213观测到，旧未部署标注属于当时记录。

2026-11-24 OneXModel 生产排障：目录在缺少调用 Key 分支返回500。按用户要求，服务端变量统一为 `ONEXM_*`，同步 registry、runtime、环境示例与 Railway IaC，保留既有启动入口；生产变量须同步改名并部署对应代码后验收。详见[接入说明](docs/relay-providers.md)。

2026-11-24 Packy / OneXModel 文本平台接入（本地候选）：复用既有 provider registry、目录、生成与调用台账，补齐 Admin/CLI、原生额度与有界费用补查。最新聊天目录各 7 个；Packy `deepseek-v4-flash`、OneX `gemini-3.8-flash` 均通过真实流式调用。已修正 TEST 两份 SQL 和图片型号误入聊天目录的问题，未执行远端迁移/部署，见[接入说明](docs/relay-providers.md)。

2026-11-23 聊天扫描与余额保护（本地候选）：stale streaming 部分索引；开轮事务原子预留、统一扣款及直接钱包写保护；余额不足永久失败实扣0、充值不追扣，统一402提示并取消普通失败重试。未执行远端迁移/部署，2秒查询目标待TEST和生产实测。见[运行与发布说明](docs/chat-sync-wallet-safety.md)。

2026-11-23 聊天交互补齐（本地候选）：模型/偏好点击即加载，未保存修改可继续按原配置发送；仅实际保存期间暂缓发送。语音读取失败只提供读取重试，避免误发生成。保持精简历史接口，无新增后端接口或迁移，本地UI按用户要求不启动。见[运行说明](docs/chat-history-first-entry.md)。

2026-11-23 聊天历史优先优化（本地候选）：详情必需读取并行，首屏最近10轮，保留已读分页；Backend 8秒与Frontend逻辑GET 10秒截止；补充Railway固定错误分类和跨24小时stale扫描。保留GET同步恢复，未部署、真实P95与恢复容量待验证；本轮按用户要求不启动本地UI，见[实施说明](docs/chat-history-first-entry.md)。

2026-11-20 剧情记忆压缩稳定性（本地候选）：补齐真实输出字数、提示目标、实际校验线、硬上限、token/结束原因和逐块进度；超长立即精简已有档案、有限递减目标，任务按需逐条领取以避免等待租约过期。失败保留旧记忆，未修改 UI、生产配置或执行迁移。字段、验证与发布观察见[压缩运行说明](docs/story-memory-compression.md)。

2026-11-19 移动端第二轮优化（本地候选）：聊天详情区分离页取消与真实依赖失败；角色编辑减少列表依赖并兼容旧WebView UUID，草稿恢复后才记就绪；影像feed按用途调度，视频分块复用源数据并等待停止收尾；冷启动设置同步移入已有后台chunk。无新增迁移，线上P95尚待发布观察，见[实施与验证说明](docs/mobile-performance-round2.md)。

2026-11-18 视频提示词5000字修复（本地候选）：输入与API共用5000上限，图片仍2000；消息content前向迁移须先TEST再production，不能只发应用。历史长快照不截断；执行与恢复见[视频运行手册](docs/video-plaza-stream.md#视频提示词5000字)。

2026-11-18 影像广场优化（本地候选，未迁移/部署）：本站点赞优先、零赞按模型内相对热度轮转，支持图片视频混排和单类型筛选，最新按分享时间。瀑布流固定两列并向短列追加；补齐Sentry/Grafana首帧、seek、卡顿和失败终态。派生排名迁移须先TEST，发布与窗口口径见[运行说明](docs/media-plaza-feed-ranking.md)。

2026-11-17 广场 Stream TEST 验证：13 条资产映射已通过 workflow 执行；`pr-566` Backend 已补齐受保护的短剧签名/Cloudflare 管理配置，12 个已发布视频的详情、刷新取址、封面及 HLS 分片验证通过。新生成受理遗漏的视频钱包类型已在 TEST 修复，分账/权限回读通过；三次实际任务随后进入 Venice queue，但上游返回402，供应商余额仍待处理。修复脚本为 `20261117_media_plaza_video_wallet_entry_guard.sql`，仓库账本尚未登记。执行顺序和验证边界见 [运行手册](docs/video-plaza-stream.md)。

2026-11-16 内容链优化（本地候选）：会话页只读已有公开角色摘要，缺失详情走 normal 并按用户/会话保留1分钟内存缓存；分组只读依赖超时返回既有503，标签summary最多等待250ms；自动推荐预算1.5秒、手动操作5秒。无新增私人持久缓存或数据库迁移。本轮按用户要求不启动本地UI，详情及发布门禁见 [实施说明](.trellis/tasks/11-12-overnight-page-performance/content-path-optimization-2026-11-16.md)。

2026-11-16 MiniApp 冷启动专项（本地候选）：根入口按 landing cookie 内部 rewrite，直接返回已有会话或大厅静态框架；保存 Telegram 启动参数后再规范地址，减少一次文档跳转。可见会话第一页使用预留 critical 槽。研究、验证和发布复测见 [专项说明](.trellis/tasks/11-12-overnight-page-performance/cold-start-optimization-2026-11-16.md)。

2026-11-16 日志完整性补全（本地未部署）：补齐捕获异常、warn 告警、数据库 cause、对账每轮上下文和大厅 Next.js 代理链路，并扩展 DB/HTTP/调度静态门禁。Backend 由 Railway 捕获，代理摘要在 Next.js 服务端 stdout；缓存、业务契约和默认关闭告警保持兼容，详见 [运行说明](docs/backend-observability-runtime.md)。

日志实现、告警规则和 SDK 候选入口现已集中在 [日志模块目录](packages/backend/src/platform/observability/README.md)。后续只改目录内 `alert-rules.json` 管理模块/状态码等规则，执行 `pnpm --filter @miniapp/backend logging:validate` 后随应用发布；LOG_ALERT_RULES 环境变量已停止读取。总开关默认关闭、通知 secret 仍独立部署。

Railway 可读性补充（本地未部署）：首行新增中文模块、请求/任务场景、真实结果与安全错误说明；探测策略和余额预检结果显式记录。展示名称集中修改日志目录的 `labels.zh-CN.ts`，英文事件码与链路查询保留。按用户要求，本轮不运行本地 UI/浏览器验收，示例与边界见模块说明。

2026-11-14 合并审计补齐媒体/影像任务、后台实体与独立数据库客户端的日志接入；字段语义、模块查询及安全边界见 [运行说明](docs/backend-observability-runtime.md)，验证结果见 [任务记录](.trellis/tasks/11-12-backend-observability/verification.md)。本地实现尚未部署。

本地日志整改候选（2026-11-14，未部署）：Railway 捕获 Pino stdout；补充用户、业务模块、角色/创作、短剧/单集及会话 ID，与 trace/request 关联。字段来源、查询示例、错误契约兼容和默认关闭的直接日志告警见 [运行说明](docs/backend-observability-runtime.md)。无需新增日志存储。

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

# 视频种子先做 HEAD 体积估算并锁定报告；旧 seed 命令始终只读，不再支持 --apply
pnpm --filter @miniapp/backend video-plaza:estimate-size -- --input <原表xlsx> --report video-seed-size-report.json
pnpm --filter @miniapp/backend video-plaza:seed -- --input <原表xlsx> --translations <翻译包video.xlsx> --report <报告> --confirm-size <报告SHA256>

# 广场视频改为Stream：TEST全部13条及未来生成视频，按独立步骤迁移
pnpm --filter @miniapp/backend video-plaza:stream-migrate --phase preflight --directory <仓库外恢复目录>
# upload / verify / sql / cleanup 的参数、门禁与执行顺序见 docs/video-plaza-stream.md

```

TEST 视频种子 SQL 只能通过 GitHub Actions `Database Migration` 选择 `environment=test` 单文件执行。工作流会向该次 `psql` 会话注入 TEST project ref 与 Storage 已核验标记；执行脚本会拒绝把 `_seed_test_` 文件用于 production，也会拒绝缺少这些确认值的直接执行。

广场视频生产兼容候选使用`20261118_media_plaza_video_production_base.sql`→`20261118_media_plaza_video_production_config.sql`替代早期两份video基础/config迁移；已通过隔离验证，未远端执行。标签/参考图/Stream、应用与4987条素材的顺序见[生产上线清单](docs/video-plaza-production-release.md)，不重跑旧钱包/配置白名单。

## 5. 环境变量

不要提交真实 `.env`。浏览器端 `NEXT_PUBLIC_*` 与 `VITE_*` 会进入 bundle，不能存放 secret。完整变量以各包 `.env.example`、源码读取点和部署平台为准。

### Backend 主要变量组

| 类别          | 变量                                                                                                                | 说明                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Runtime/CORS  | `NODE_ENV`, `PORT`, `FRONTEND_URL`, `ADMIN_PLATFORM_URL`, `FRONTEND_ALLOWED_ORIGINS`                                | 服务环境、端口和精确允许来源；额外来源逗号分隔，不接受路径或通配符                                              |
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

视频创作使用 `VIDEO_PLAZA_WORKER_ENABLED`、`VIDEO_PLAZA_*`，复用短剧 `DRAMA_STREAM_HOST/KEY_ID/PRIVATE_KEY` 与同账户管理凭证。新交付不依赖FFmpeg，FFmpeg仅供离线素材工具。Stream迁移、配置及恢复见[操作说明](docs/video-plaza-stream.md)，本地实现不代表TEST数据库或生产已切换。

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

支付自动对账（2026-11-19 本地候选）：创建超过 8 小时的订单不再自动查单；窗口内到期后累计 3 次明确待支付也停查，失败不计次数。两个任务共用 `billing.payment_reconcile_jobs`，逐单可重试上游失败为 warn，每轮输出数值汇总；资金/配置/数据库故障仍为 error。验签回调与用户主动查单继续恢复晚付订单。先单独验证并执行 `20261119_payment_reconcile_stop_policy.sql`，再部署两个任务；源码完成不代表生产生效。发布与恢复见 [迁移说明](packages/shared/migrations/README.md)。
