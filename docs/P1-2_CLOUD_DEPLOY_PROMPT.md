# P1-2 云部署 — Agent 任务提示词

> 本文件是交给独立 Agent 窗口执行 P1-2 云部署的完整上下文。
> 生成时间：2026-06-26。

---

## 一、项目概况

### 1.1 项目是什么

ST_miniAPP 是一个 **Telegram MiniApp**，核心功能是把 SillyTavern（开源 AI 角色扮演前端，下称 ST）嵌入 iframe，外包一层平台壳（Next.js 前端 + Fastify 后端），实现：

- Telegram 身份登录 → 角色大厅 → 点角色卡进对话
- 对话走平台 LLM 代理网关（backend `llm-proxy`），代理转发至 OpenRouter，**按模型档位扣费**（标准 10 / 高级 15）
- 历史聊天列表、切换、新建、删除、重命名
- 模型切换（标准 gemini-2.5-flash / 高级 claude-sonnet-4）
- 钱包余额、签到
- 角色卡 PNG 由运营上传到 Supabase Storage，provisioner 首登时下发到 ST 文件系统

### 1.2 项目根路径

```
/Users/qj/python_project/ST_miniAPP
```

### 1.3 当前分支与状态

- 分支：`dev_character_card_management`
- **P0 全部完成**（本地一键编排 / 端到端冒烟验收 / LLM endpoint 固化 / vendor 零改红线修复）
- **P1-1 完成**（角色卡 PNG 改从 Supabase Storage 下载 + 运营 import 脚本 `scripts/import-character.ts`）
- 工作区基本干净（仅有 import 脚本增量改动和几个废弃文档删除）

---

## 二、架构（5 进程 → 云端 5 单元）

### 2.1 本地 5 进程

由根脚本 `pnpm dev:all`（concurrently）并发拉起：

| 前缀    | 进程                      | 端口        | 技术                | 云端目标                                  |
| ------- | ------------------------- | ----------- | ------------------- | ----------------------------------------- |
| `st`    | SillyTavern 原生          | 8000        | Node.js `server.js` | Railway 服务                              |
| `prov`  | sync-engine provision-api | 9091        | tsx（Fastify）      | Railway 服务（与 watcher 同镜像不同入口） |
| `watch` | sync-engine watcher       | health 9090 | tsx                 | Railway 服务（同上）                      |
| `be`    | backend                   | 3001        | Fastify + Prisma    | Railway 服务                              |
| `fe`    | frontend                  | 3000        | Next.js             | **Vercel**                                |

### 2.2 monorepo 包结构

```
packages/
  frontend/        @miniapp/frontend      — Next.js 14，入口 http://localhost:3000
  backend/         @miniapp/backend       — Fastify API 服务，端口 3001
  sync-engine/     @miniapp/sync-engine   — provisioner + watcher，端口 9091/9090
  st-extension/    @miniapp/st-extension  — ST 内嵌扩展（build → entry.global.js → 拷入 vendor ST 扩展目录）
  bridge-protocol/ @miniapp/bridge-protocol — iframe 桥接协议类型定义
  shared/          @miniapp/shared        — 共享类型 + SQL migrations (001–022)
  db-types/        @miniapp/db-types      — Supabase 数据库类型生成
vendor/
  sillytavern/     — ST 原生代码（vendor 只读，所有修补通过 st-extension 注入）
```

workspace 配置：`pnpm-workspace.yaml` → `packages: ['packages/*']`

### 2.3 关键依赖关系

```
frontend ──iframe──► ST (通过同源代理或 nginx)
frontend ──API──► backend (/api/*)
backend ──反代──► ST (/api/chats/*, /api/users/*)
backend ──HTTP──► sync-engine provision-api (:9091, 触发 provision)
sync-engine ──文件系统──► ST data/ 目录（写 settings/secrets/characters/presets）
sync-engine ──Supabase──► DB + Storage（读用户配置 + 下载角色卡 PNG）
backend ──Supabase──► DB（钱包/计费/角色列表）
backend ──OpenRouter──► LLM API（代理转发 + SSE 流式）
```

### 2.4 核心同源约束（最重要的部署约束）

ST 被嵌入 Next.js 页面的 iframe 中。**iframe 必须与主页面同源**，否则：

- 浏览器阻止跨域 iframe 通信
- ST 的 `X-Frame-Options` 阻止嵌入

**本地实现方式**：Next.js `rewrites()`（见 `packages/frontend/next.config.mjs`）：

```javascript
// 仅当 ST_LOCAL_URL 存在时启用（开发模式）
// 生产环境 ST_LOCAL_URL 不设 → rewrites 返回空 → 由 nginx 接管路由
fallback: [
  { source: '/tavern', destination: `${stUrl}/` },
  { source: '/tavern/', destination: `${stUrl}/` },
  { source: '/:path*', destination: `${stUrl}/:path*` },
];
```

**生产必须由 nginx 1:1 复刻这套路径映射**（详见第三节）。

---

## 三、P1-2 部署方案（ACTION_PLAN 既定）

### 3.1 目标平台

- **frontend** → Vercel（Next.js 原生支持）
- **backend / ST / sync-engine / nginx** → Railway（4 个服务）

### 3.2 单域名 nginx 路由规则

一个 nginx 反代服务，绑定对外唯一域名，按路径分发到后端各服务：

```
对外域名（假设 miniapp.example.com）
  │
  ├── /                              → Vercel (frontend)
  ├── /tavern                        → ST 服务（根路径 /）  ← 关键：同源代理
  ├── /tavern/                       → ST 服务（根路径 /）
  ├── /tavern/[uuid]                 → Vercel (frontend)    ← Next.js 动态路由页面
  ├── /scripts/*, /css/*, /img/*     → ST 服务              ← ST 静态资源
  ├── /api/platform/*                → backend 服务         ← 平台业务 API
  ├── /api/* (其余)                  → ST 服务              ← ST 原生 API
  └── 其他静态资源 /:path*           → ST 服务              ← fallback
```

**路由判定的关键细节**：

1. `/tavern/[uuid]` 形如 `/tavern/11111111-1111-4111-8111-000000000002`，是 Next.js 页面路由（对话页），必须打到 Vercel
2. `/tavern` 和 `/tavern/`（无 UUID）是 ST 入口（iframe src），必须打到 ST
3. ST 的静态资源（`/scripts/`、`/css/`、`/img/`、`/favicon.ico` 等）必须打到 ST
4. `/api/platform/*` 是 backend 路由前缀
5. 其余 `/api/*` 是 ST 原生 API

**注意**：ST 的 `<base href="/">` 使得所有相对路径以域名根 `/` 解析。`tabs-base-guard` 补丁（st-extension §2）在 iframe 挂载在 `/tavern` 子路径时修复了 jQuery UI Tabs 把本地锚点误判为远程 URL 的问题。nginx 的路径映射必须保持 ST 的资源在根路径 `/scripts/*`、`/css/*` 可达，否则 ST 加载会崩。

### 3.3 需要创建的 Dockerfiles

#### 3.3.1 ST 自定义镜像

基于 `vendor/sillytavern/Dockerfile`（stock），额外需要：

- 构建 st-extension（`pnpm --filter @miniapp/st-extension build` → 产物 `dist/entry.global.js` + `manifest.json`）
- 将产物拷贝到 ST 扩展目录 `public/scripts/extensions/third-party/miniapp-bridge/`
- 注入自定义 `config.yaml`（`enableUserAccounts: true`、`listen: true`、`whitelistMode: false`、`port: 8000`）

现有 st-extension 的 postbuild 脚本（`packages/st-extension/scripts/postbuild.ts`）已负责拷贝产物到 vendor 扩展目录；Docker 构建时可复用这个流程。

#### 3.3.2 backend 镜像

Fastify 服务，依赖 Prisma。启动命令：`npx prisma generate && tsx src/server.ts`（见 package.json `start` 脚本）。

#### 3.3.3 sync-engine 镜像

一个镜像两个入口：

- provision-api：`tsx src/provision-api/run.ts`（端口 9091）
- watcher：`tsx src/watcher/run.ts`（health 端口 9090）

依赖 ST 文件系统（`ST_DATA_PATH`），在 Railway 上需要 **persistent volume** 挂载到 ST 的 `data/` 目录，让 sync-engine 和 ST 共享文件系统。

#### 3.3.4 nginx 镜像

标准 nginx:alpine，挂载自定义 `nginx.conf`。

### 3.4 生产环境变量

#### frontend（Vercel 环境变量）

```
NEXT_PUBLIC_API_URL=https://miniapp.example.com   # 指向 nginx 反代
NEXT_PUBLIC_USE_MOCK_INIT_DATA=0                   # 关闭 mock
# ST_LOCAL_URL 不设 → rewrites 返回空 → 路由由 nginx 处理
```

#### backend（Railway 环境变量）

```
NODE_ENV=production
DATABASE_ENV=production
PROD_DATABASE_URL=...                              # 生产 Supabase 连接池
PROD_DIRECT_URL=...                                # 生产 Supabase 直连
PROD_SUPABASE_URL=...
PROD_SUPABASE_PROJECT_REF=...
PROD_SUPABASE_SERVICE_ROLE_KEY=...
TELEGRAM_BOT_TOKEN=...                             # 真实 bot token
MOCK_AUTH=0                                        # 关闭 mock
DEV_AUTH_BYPASS=0
LLM_UPSTREAM_URL=https://openrouter.ai/api/v1
LLM_API_KEY=...
LLM_DEFAULT_MODEL=google/gemini-2.5-flash
LLM_PROXY_SECRET=...                               # 代理网关鉴权
ST_BASE_URL=http://st-service:8000                  # Railway 内网地址
ST_USER_PASSWORD_SECRET=...                         # 必须与 sync-engine 一致
ST_PROVISION_URL=http://sync-engine-service:9091    # Railway 内网地址
FRONTEND_URL=https://miniapp.example.com
```

#### sync-engine（Railway 环境变量）

```
DATABASE_ENV=production
PROD_SUPABASE_PROJECT_REF=...
PROD_SUPABASE_URL=...
PROD_SUPABASE_SERVICE_ROLE_KEY=...
ST_DATA_PATH=/data                                  # persistent volume 挂载点
ST_BASE_URL=http://st-service:8000                   # Railway 内网地址
ST_ADMIN_USERNAME=admin
ST_ADMIN_PASSWORD=...
ST_USER_PASSWORD_SECRET=...                          # 必须与 backend 一致
LLM_PROXY_URL=https://miniapp.example.com/api/platform/llm-proxy/v1
CHARACTER_STORAGE_BUCKET=character-assets
PROVISION_API_PORT=9091
HEALTH_PORT=9090
```

#### ST（Railway 环境变量）

ST 通过 `config.yaml` 配置，不依赖太多 env。关键是 Docker 构建时注入正确的 `config.yaml`。

### 3.5 Supabase 生产库准备

生产 Supabase 项目需应用全部 migrations：

```
packages/shared/migrations/001_users_add_st_fields.sql
...（共 22 个，001–022）
packages/shared/migrations/022_characters_raw_card_beijing_time.sql
```

加上 Prisma migrations：

```
packages/backend/prisma/migrations/
  0_baseline/
  20260422102132_add_miniapp_tables/
  20260422111917_align_characters_with_tavern_spec/
  20260422114408_character_soft_reference/
  20260623113000_phase0_drop_sessions_character_flags/
  20260626150000_character_field_cleanup_fallback_config/
```

还需要 seed 数据（角色卡记录 + 预设 + 初始配置）。

### 3.6 共享文件系统约束

**ST 和 sync-engine 必须共享同一个 `data/` 目录**。sync-engine 的 provisioner 将用户的 settings、secrets、角色卡 PNG、presets 写入 `data/<user_handle>/` 下的子目录；ST 启动时读取这些文件。

Railway 方案：

- 创建一个 persistent volume
- 挂载到 ST 服务的 `/home/node/app/data`
- 同时挂载到 sync-engine 服务的 `ST_DATA_PATH`
- 或者将 ST 和 sync-engine 打包为同一个 Railway 服务（multi-process），共享本地文件系统

### 3.7 TG WebView 联调

最终需要在 TG Bot 设置中配置 WebApp URL 指向 nginx 的对外域名。`MOCK_AUTH` 关闭后，frontend 会从 Telegram WebApp SDK 获取真实 `initData`，backend 用 `TELEGRAM_BOT_TOKEN` 验签。

---

## 四、必读附件清单

执行 P1-2 前，Agent 必须读取以下文件以获取完整上下文：

| 优先级   | 文件路径                                         | 内容                                               |
| -------- | ------------------------------------------------ | -------------------------------------------------- |
| **必读** | `docs/MVP_ACTION_PLAN.md`                        | 总体进度、P1-2 定义、执行顺序                      |
| **必读** | `docs/st-extension-patches.md`                   | 6 个 vendor 兼容补丁的根因和修复方式，理解同源约束 |
| **必读** | `docs/QUICKSTART.md`                             | 本地 5 进程编排、env 配置、冒烟清单                |
| **必读** | `packages/frontend/next.config.mjs`              | Next.js rewrite 规则（nginx 必须复刻）             |
| **必读** | `vendor/sillytavern/Dockerfile`                  | ST stock Dockerfile（自定义镜像的基础）            |
| **必读** | `vendor/sillytavern/docker/docker-entrypoint.sh` | ST 容器入口脚本                                    |
| 参考     | `packages/backend/.env.example`                  | backend 全量 env 模板                              |
| 参考     | `packages/sync-engine/.env.example`              | sync-engine 全量 env 模板                          |
| 参考     | `packages/frontend/.env.local`                   | frontend env（当前为本地 dev 配置）                |
| 参考     | `packages/backend/package.json`                  | backend 启动脚本 `start`                           |
| 参考     | `packages/sync-engine/package.json`              | sync-engine 入口脚本                               |
| 参考     | `packages/st-extension/scripts/postbuild.ts`     | 扩展产物拷贝逻辑                                   |
| 参考     | `vendor/sillytavern/config.yaml`                 | ST 运行时配置（多用户模式等）                      |
| 参考     | `docs/ARCHITECTURE.md`                           | 架构设计文档                                       |

---

## 五、执行步骤与验收目标

### 5.1 执行步骤（建议顺序）

1. **创建 `ops/docker/` 目录**，编写以下 Dockerfiles：
   - `Dockerfile.st` — ST 自定义镜像（含 st-extension 产物 + 生产 config.yaml）
   - `Dockerfile.backend` — backend 服务镜像
   - `Dockerfile.sync-engine` — sync-engine 镜像（双入口）
   - `Dockerfile.nginx` — nginx 反代镜像

2. **创建 `ops/nginx/nginx.conf`** — 单域名路由配置（严格复刻 §3.2 路由规则）

3. **创建 `ops/docker-compose.yml`**（可选）— 本地验证 4 服务 Docker 编排

4. **编写生产 env 模板** — `ops/env/` 下各服务的 `.env.production.example`

5. **验证 Docker 本地构建** — 每个镜像能 `docker build` 成功

6. **文档更新** — 更新 `docs/MVP_ACTION_PLAN.md` 中 P1-2 的进度

### 5.2 验收目标

| #   | 验收项               | 标准                                                                                                                                                 |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ST 自定义镜像构建    | `docker build -f ops/docker/Dockerfile.st .` 成功；容器内 `/home/node/app/public/scripts/extensions/third-party/miniapp-bridge/entry.global.js` 存在 |
| 2   | backend 镜像构建     | `docker build -f ops/docker/Dockerfile.backend .` 成功；`prisma generate` 在构建期完成                                                               |
| 3   | sync-engine 镜像构建 | `docker build` 成功；分别以 provision-api 和 watcher 入口启动不报错                                                                                  |
| 4   | nginx 配置正确性     | `nginx -t` 通过；路由规则覆盖 §3.2 全部路径                                                                                                          |
| 5   | nginx 同源代理       | `/tavern` → ST 根路径；`/scripts/*` `/css/*` → ST；`/api/platform/*` → backend；`/tavern/[uuid]` → Vercel                                            |
| 6   | env 模板完整         | 每个服务的生产 env 模板包含所有必需变量，带注释说明                                                                                                  |

### 5.3 不在本轮范围

- 实际 Vercel / Railway 部署（需要账号权限 + 域名）
- 生产 Supabase 迁移执行（需要 DBA 操作）
- 真实 TG WebView 联调（需要 bot 配置）
- SSL 证书配置（Railway 自带）

---

## 六、注意事项与陷阱

1. **同源是生命线**：nginx 必须让 ST 的资源（`/scripts/*`、`/css/*`）和 ST 入口（`/tavern`）与前端页面在同一域名下可达。如果这条断了，iframe 直接崩。

2. **`<base href="/">`**：ST 的 `index.html` 含 `<base href="/">`，所有相对路径以根解析。nginx 必须把 `/scripts/*`、`/css/*` 等 ST 静态资源直接代理到 ST 服务根路径，不能加路径前缀。

3. **`/tavern/[uuid]` vs `/tavern/`**：nginx 必须区分 `/tavern/` 后面跟 UUID（→ Vercel）和不跟 UUID（→ ST）。UUID 格式：`[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`。

4. **文件系统共享**：ST 和 sync-engine 必须看到同一份 `data/` 目录。这是最难在 Railway 上实现的部分——可能需要把 ST + sync-engine 合并为一个多进程服务。

5. **`ST_USER_PASSWORD_SECRET` 一致性**：backend 和 sync-engine 用同一个密钥派生用户密码，不一致会导致 bridge 登录 ST 失败。

6. **`LLM_PROXY_URL` 的可达性**：sync-engine provision 时会将此 URL 写入用户的 `settings.json`（`oai_settings.custom_url`）。在容器化环境中，这个 URL 必须是 **ST iframe 内（即浏览器端）可达的地址**，即对外域名 `https://miniapp.example.com/api/platform/llm-proxy/v1`，而不是 Railway 内网地址。

7. **config.yaml**：生产 ST 容器的 `config.yaml` 必须设置 `enableUserAccounts: true`、`listen: true`（接受外部连接）、`whitelistMode: false`（关闭 IP 白名单）。
