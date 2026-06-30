# 云部署路径校准分析（结论记录 · 供大模型读取）

> 生成时间：2026-06-29。性质：**只读分析结论快照**，非执行记录。所有"必做改动"留待人类确认后另起任务。
> 基准（不可质疑）：frontend→Vercel；backend / ST native / sync-engine(provision-api+watcher) / nginx→Railway；
> 生产单域名 nginx 分发（`/`→Vercel、`/tavern/*`+ST `/api/*`→ST、`/api/platform/*`→backend）；镜像 GHCR multi-arch（amd64 Railway / arm64 本地）。
> 锁定约束：① ST 状态回流 Supabase 6 个月内补完（当前过渡形态，勿在 ST volume 完美管理上过投）；② 内测 500–1000 人；③ 必须 PaaS（VPS/Fly.io/K8s 已出局，勿提替代）。
> 人类可读的"必做改动清单"见 `docs/CLOUD_DEPLOY_TODO.md`。

---

## 0. 一句话现状

仓库已具备一套**可单机 `docker compose up` 的完整容器化全栈**（4 镜像 + nginx 单域名网关 + s6 三进程 + GHCR multi-arch 推送）。它在结构上等价于"**方案 X（nginx 单域名入口）的本地自托管版**"，但 **frontend 被容器化、nginx `/` 兜底打到 `frontend:3000` 容器**，而非基准要求的 Vercel。真正的"Vercel+Railway 生产特化层"（nginx 上游指向真实地址、分服务生产 env、Railway 接线）尚未产出。

**根级待决项（阻塞一切方向）**：基准写的是方案 X（`/`→Vercel 反代），但 `docs/P1-2_CLOUD_DEPLOY_PROMPT.md` 全文推荐方案 Y（Vercel 边缘入口 + Railway 内部 nginx 仅分发 ST）；已实现产物两者都不完全是。**必须人类先定 X 还是 Y**，后续 nginx/前端改动方向由此分叉。

---

## 1. 分析方法与证据基准

- 直接扫描仓库文件内容（非依赖里程碑/阶段编号）。
- 标记法：`✅ 完全对齐` / `🟡 需调整` / `🔴 需移除或降级` / `⚪ 本地保留`。
- 缺口分级：`🔥 阻塞上线` / `⚠️ 上线前必做` / `💤 上线后补`。
- 关键源码事实均带 `文件:行` 证据。

---

## 2. 部署产出物全景表（含对齐标记）

| 路径                                                       | 类型               | 设计意图                                                                                                   | 标记                                |
| ---------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `docker-compose.yml`                                       | compose            | M4 本地/staging 全栈（4 服务，nginx 唯一暴露 8080:80，volume→`/home/node/app/data`）                       | ⚪                                  |
| `.dockerignore`（根）                                      | dockerignore       | st-bundle 构建上下文收缩（保留 vendor/shared/bridge-protocol）                                             | ✅                                  |
| `.env.compose.example`                                     | env 模板           | compose 占位 env（按服务分组）                                                                             | 🟡                                  |
| `ops/docker/Dockerfile.st-bundle`                          | Dockerfile         | ST+provision-api+watcher 单容器，node:20-bookworm-slim+s6 v3，ARG TARGETARCH，volume `/home/node/app/data` | ✅                                  |
| `ops/docker/Dockerfile.backend`                            | Dockerfile         | Fastify 单进程，prod-only+构建期 prisma generate+tsx+tini，$PORT 可配                                      | ✅                                  |
| `ops/docker/Dockerfile.frontend`                           | Dockerfile         | Next standalone 自托管容器（node:20-alpine）                                                               | 🔴（生产）/⚪（本地）               |
| `ops/docker/Dockerfile.{backend,frontend}.dockerignore`    | dockerignore       | 各镜像专属忽略                                                                                             | ✅ / 🔴 随 frontend                 |
| `ops/nginx/nginx.conf`                                     | nginx              | 单域名网关，方案 X 附录 A 单层枚举；upstream 用 compose 主机名；`/`→frontend 容器                          | 🟡                                  |
| `ops/nginx/Dockerfile`                                     | Dockerfile         | nginx:1.27-alpine + COPY conf                                                                              | 🟡（镜像 ✅，conf 待改）            |
| `ops/nginx/README.md`                                      | 文档               | 路由真相表 + provision-api 暴露安全说明                                                                    | ✅                                  |
| `ops/sillytavern/config.production.yaml`                   | 配置               | 生产 ST config（6 项覆盖，无密钥）                                                                         | ✅                                  |
| `ops/s6/{st,provision-api,watcher}/*`                      | script/编排        | s6-rc.d 三 longrun + dependencies.d/st + readiness 等 ST:8000                                              | ✅                                  |
| `ops/README.md`                                            | 文档               | 镜像构建/运行 + backend env 全表（含 `LLM_PROXY_TOKEN_SECRET`）+ 体积分析                                  | ✅                                  |
| `ops/git/*`                                                | script（非部署）   | AI diff review 工具                                                                                        | ⚪                                  |
| `.github/workflows/build-and-push.yml`                     | workflow           | GHCR multi-arch 推 4 镜像 + verify-multiarch；tag sha-/branch-latest；GITHUB_TOKEN                         | ✅（3 Railway 镜像）/ frontend 🔴⚪ |
| `.github/workflows/ci.yml`                                 | workflow           | 质量门 + backend amd64 docker build（cacheonly）                                                           | ✅                                  |
| `.github/workflows/db-migrate.yml`                         | workflow           | 手动 Supabase 迁移（test/prod，prod 需确认词+ref 校验）                                                    | ✅                                  |
| `.github/workflows/pr-review.yml`                          | workflow（非部署） | AI 代码评审                                                                                                | ⚪                                  |
| `scripts/m5-push.sh`                                       | script             | 本地等价 GHCR 推送（凭证仅来自 env）                                                                       | ✅                                  |
| `scripts/m4-smoke.sh`                                      | script             | 经 nginx:8080 跑 4 条路由烟雾                                                                              | ⚪                                  |
| `scripts/import-character.ts` + `scripts/.env.{prod,test}` | script+env         | 角色卡上传 Storage（P1-1）；env 含真实 key，git-ignored                                                    | ⚪                                  |
| `packages/backend/.env.example`                            | env 模板           | backend 本地 env（test/prod 隔离）                                                                         | 🟡（变量名过时，见 §5 D-1）         |
| `packages/sync-engine/.env.example`                        | env 模板           | 含 PROVISION_API_BIND_HOST 容器说明 + LLM_PROXY_URL 内网说明                                               | ✅                                  |
| `packages/frontend/next.config.mjs`                        | 构建配置           | standalone + outputFileTracingRoot；rewrites 仅 ST_LOCAL_URL 存在时启用                                    | 🟡（取决于 X/Y）                    |
| `vendor/sillytavern/Dockerfile` + `docker/*`               | Dockerfile/compose | ST 原生 stock（node:lts-alpine3.23）                                                                       | ⚪                                  |
| `docs/P1-2_CLOUD_DEPLOY_PROMPT.md`                         | 文档               | 部署规划全文（事实表+方案 X/Y+各产出要点）                                                                 | ✅（推荐 Y，与基准 X 分叉）         |
| `docs/m5-registry.md`                                      | 文档               | GHCR 命名空间/tag/`build:`→`image:` 切换                                                                   | ✅                                  |
| `docs/known-issues.md`                                     | 文档               | KI-001 占位 cred 噪声                                                                                      | ✅                                  |
| `docs/QUICKSTART.md`                                       | 文档               | 仍引用过时 `ST_PLATFORM_ASSETS_PATH`                                                                       | 🟡                                  |

---

## 3. 偏离判断（🟡/🔴 详情，含证据）

### 🟡-1 nginx upstream 与 `/` 兜底目标

- 偏离：上游用 docker 主机名；`/` 打到自托管 frontend 容器。
- 证据：`ops/nginx/nginx.conf:85-88`（`upstream frontend{server frontend:3000;}` 等）、`:213-215`（`location / { proxy_pass http://frontend; }`）。
- 方向：上游改 Railway 内网形态；`/` 归属按 X/Y 决策（X→反代 Vercel；Y→nginx 退化仅 ST、`/` 不经它）。

### 🟡-2 nginx `/provision-api/` 公网暴露

- 偏离：无鉴权 provision-api 经公网网关暴露；基准 backend→provision-api 走内网直连。
- 证据：`ops/nginx/nginx.conf:182-184`；`ops/nginx/README.md` 安全说明自陈风险。
- 方向：生产删除或加网段白名单；backend 走 Railway 内网直连。

### 🟡-3 `.env.compose.example` 仅本地、缺 LLM 计费变量

- 偏离：无分服务生产模板；backend 段缺 `LLM_API_KEY`/`LLM_UPSTREAM_URL`/`LLM_PROXY_TOKEN_SECRET`；sync-engine 段缺 `LLM_PROXY_TOKEN_SECRET`。
- 方向：补 LLM 变量；产出分服务生产 env 模板。

### 🟡-4 `next.config.mjs` 生产 rewrites 缺位（仅方案 Y 需要）

- 证据：`packages/frontend/next.config.mjs:27-41`（rewrites 仅 `ST_LOCAL_URL` 存在时启用）。
- 方向：选 Y→新增基于生产变量（占位 `ST_PUBLIC_PROXY_URL`）的 `beforeFiles`；选 X→保持不动。

### 🟡-5 `docs/QUICKSTART.md` 过时变量

- 证据：`docs/QUICKSTART.md:19` 引用已废弃 `ST_PLATFORM_ASSETS_PATH`（provisioner 已纯 Storage）。

### 🔴-1 frontend 容器化（生产冗余）

- 偏离：基准 frontend→Vercel，生产不需要 Next standalone 容器，也不需把 `st-miniapp-frontend` 推 GHCR 给 Railway。
- 证据：`ops/docker/Dockerfile.frontend`；`.github/workflows/build-and-push.yml:50-54`（矩阵含 frontend）；`docker-compose.yml:54-72`。
- 方向：降级为"仅本地/staging"，生产编排不含。不删除（本地全栈仿真有用），但文档需标明生产不部署。

### 跨方案定性（核心）

`docker-compose.yml`+`nginx.conf`（`/`→frontend 容器）是自洽本地全栈，但既非基准方案 X（`/`→Vercel 反代）也非文档推荐方案 Y（Vercel 入口）。生产特化必须二选一并据此改 nginx/前端。

---

## 4. 缺口清单（原计划要素 vs 现状）

| ID   | 缺口                                                                                                                 | 证据/现状                                                                                                                                 | 级别                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| G-1  | 生产 nginx `/`→Vercel 反代实现（方案 X 核心）：缺 `resolver`/`proxy_ssl_server_name`/Host 透传/`X-Forwarded-Host` 等 | `nginx.conf` 全文无相关指令；`P1-2 §3.2ter` 列出坑位                                                                                      | 🔥（X）；走 Y 则等价于"前端生产 rewrites 缺位"，同样 🔥 |
| G-2  | 分服务生产 env 模板（Vercel/Railway/内网/跨服务一致密钥）`ops/env/*.env.production.example`                          | `ops/env` 不存在；仅 `.env.compose.example`                                                                                               | ⚠️                                                      |
| G-3  | nginx 上游指向 Railway 真实内网地址形态                                                                              | `nginx.conf:85-88` 仍 compose 主机名                                                                                                      | 🔥（与 G-1 同批）                                       |
| G-4  | Railway 服务↔镜像↔volume↔内网 DNS 接线                                                                               | 无 `railway.json`/`toml`（控制台管理，缺失可接受但需文档化）。**不确定是否要纳入仓库，需人类确认**                                        | ⚠️                                                      |
| G-5  | 生产 Supabase：001–022 SQL + Prisma migrations + seed + `NOTIFY pgrst,'reload schema'`                               | `db-migrate.yml` 可跑 SQL；seed/reload 手动；`P1-2 §3.5` 强调 reload 否则计费 RPC 静默失败                                                | ⚠️                                                      |
| G-6  | Storage `character-assets` bucket 创建 + 角色卡 PNG（`platform_<uuid>.png`）上传                                     | `import-character.ts`+`scripts/.env.*` 就位，目标环境 bucket/权限/上传待运营                                                              | ⚠️                                                      |
| G-7  | LLM 计费变量进生产 env，且 `LLM_PROXY_TOKEN_SECRET`、`ST_USER_PASSWORD_SECRET` 跨 backend/sync-engine 逐字一致       | 代码用 `LLM_PROXY_TOKEN_SECRET`（`backend/src/lib/llm-token.ts:15`、`sync-engine/src/lib/config.ts:43`、`provisioner/writer.ts:178-180`） | ⚠️                                                      |
| G-8  | TLS/对外域名绑定 + BotFather `/setdomain`                                                                            | nginx 仅 80 无 SSL（TLS 留给边缘，符合预期）；域名绑定/setdomain 未落地。**域名绑 Vercel(Y) 还是 Railway nginx(X) 由决策定，需人类确认**  | 💤                                                      |
| G-9  | 镜像拉取端接线（构建→GHCR ✅；Railway 拉取缺）                                                                       | 同 G-4                                                                                                                                    | ⚠️                                                      |
| G-10 | provision-api 跨服务可达                                                                                             | **已解决**：`server.ts:21 BIND_HOST = process.env.PROVISION_API_BIND_HOST ?? '127.0.0.1'`，compose 注 0.0.0.0；生产 Railway 须同样注入    | ✅（提醒生产设 0.0.0.0）                                |

---

## 5. 代码 vs 模板/注释不一致（证据确凿，随清理批修）

- **D-1**：`packages/backend/.env.example:49` 写 `LLM_PROXY_SECRET=`，代码用 `LLM_PROXY_TOKEN_SECRET`（`backend/src/lib/llm-token.ts:15`、`sync-engine/src/lib/config.ts:43`、`provisioner/writer.ts:178-180`）。模板误导。
- **D-2**：`packages/sync-engine/src/provision-api/server.ts:8` 注释仍称"仅绑定 127.0.0.1，外部不可直连"，但 `:21` 已支持 `PROVISION_API_BIND_HOST` 覆盖。注释过时。

---

## 6. 风险点（调整时连锁，供后续任务规避）

- **R-1（方案 X 专属，最高）**：nginx 反代 Vercel 涉及 DNS 动态解析/SNI/Host/`X-Forwarded-Host`/anti-abuse + CDN 加速半失效——`P1-2 §3.2ter` 据此推荐 Y。坚持 X 需接受此复杂度。
- **R-2 `/api/*` 三方共享**：frontend route handler(`/api/init-st-session`)+backend+ST 共用，靠精确/UUID 正则/前缀消歧（`nginx.conf:104-177`）。改路由或换 Y（host 分离）要整体改，不能改一半。
- **R-3 同源生命线**：ST iframe `src='/tavern/'`（`packages/frontend/src/components/bridge/st-iframe.tsx:7`）须与主页同源，否则 bridge postMessage 断。
- **R-4 CORS 仅生产精确匹配**：`packages/backend/src/app.ts:36-50`，`.vercel.app` 通配仅非 production 放行；生产仅放行 `config.frontendUrl` 精确值。Y（跨域调 backend）须把 `FRONTEND_URL` 设真实对外域名；X（同域相对调用）不触发 CORS。
- **R-5 SSE 关缓冲**：两段 SSE（`/api/platform/llm-proxy/*`@backend、`/api/backends/chat-completions/*`@ST）所经反代层须 `proxy_buffering off`+长超时（现 `nginx.conf` 已配），改方案勿丢。
- **R-6 provision-api 生产绑定**：生产 Railway 须注入 `PROVISION_API_BIND_HOST=0.0.0.0`。
- **R-7 占位 cred 噪声（非阻断）**：KI-001 `Invalid schema: st_infra`，真凭证后消失，验收勿误判回归。

---

## 7. 验收标准（"回到 Vercel+Railway 正轨"的可观测标志）

1. 镜像：`docker buildx imagetools inspect ghcr.io/<owner>/st-miniapp-{backend,st-backend,nginx}:<tag>` 三镜像含 amd64+arm64。
2. 拓扑：Railway 上 backend、st-bundle（绑 volume）独立且 healthy；frontend 在 Vercel；Railway 编排不含 frontend 容器。
3. 路由（按 X/Y）：`/`→前端；`/tavern/`→ST 根、ST 静态/原生 `/api/*`→ST；`/api/platform/llm-proxy/*`→backend；`/tavern/<uuid>`/`/profile/*`/`/create`/`/api/init-st-session`/`/_next/*`→前端；`/provision-api/` 公网不可达。
4. 同源：ST iframe 与主页同源，bridge 两段握手 ready + 2.5s ping/pong mirror 正常。
5. env/密钥：backend 与 st-bundle 的 `ST_USER_PASSWORD_SECRET`、`LLM_PROXY_TOKEN_SECRET` 逐字一致；`PROVISION_API_BIND_HOST=0.0.0.0`；`LLM_PROXY_URL` 内网可达。
6. DB：生产 Supabase 已应用 001–022 + Prisma migrations + seed，且执行 `NOTIFY pgrst,'reload schema'`；计费 RPC 不报 schema cache 缺失。
7. 端到端：TG（或 mock）入口跑通 6 项 MVP，backend 日志出现 `deduction success`。
8. SSE：逐字流式可见、长回复不在 60s 断流。

---

## 8. 红线（后续任务勿越界）

- 勿改 `vendor/sillytavern/`（架构铁律：只读、锁 commit）。
- 勿提 Fly.io/VPS/K8s 替代方案。
- 勿重新讨论"为何选 Vercel+Railway"。
- 勿把 ST 状态回流 Supabase 的实现拉进部署范围。
- 无文件证据不臆测产出物存在/不存在。
