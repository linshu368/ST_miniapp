# 云部署必做改动清单（给人看）

> 配套分析详情：`docs/CLOUD_DEPLOY_CALIBRATION.md`。
> 本清单只列**需要动手的事**（✅ 已对齐 / ⚪ 本地保留 的不列）。每项标注级别、动哪个文件、为什么。
> 全部留待你确认后另起任务执行——本文件本身不是执行记录。

---

## 0. 必须先拍板（不定则下面全部无法开工）

- [ ] **定方案 X 还是 Y。**
  - 基准任务书写的是 **方案 X**：nginx 单域名，`/`→Vercel（nginx 反代 Vercel）。
  - 但仓库文档 `docs/P1-2_CLOUD_DEPLOY_PROMPT.md` 推荐 **方案 Y**：对外域名直接绑 Vercel，Vercel 把 ST 路径 rewrite 到 Railway，nginx 退化为只分发 ST。
  - 现有产物（`docker-compose.yml` + `nginx.conf` 里 `/`→frontend 容器）两者都不是，是"本地全栈仿真"。
  - 影响：选 X 要在 nginx 里反代 Vercel（DNS/SNI/Host/anti-abuse 一堆坑，CDN 加速半失效）；选 Y 要改前端 `next.config.mjs` 生产 rewrites，nginx 极简。**建议优先评估 Y。**

- [ ] **确认 Railway 配置是否要进仓库**（`railway.json`/`toml`），还是纯控制台管理。影响下面 G-4/G-9 要不要"补文件"。

- [ ] **确认对外域名绑在哪**：Vercel(走 Y) 还是 Railway nginx(走 X)。

---

## 1. 🔥 阻塞上线（不做无法上线）

- [ ] **改 nginx 上游为 Railway 内网地址**
      文件：`ops/nginx/nginx.conf`（第 85–88 行 upstream）。现在是 `frontend:3000 / backend:3001 / st-backend:8000/9091` 这种 compose 主机名，要换成 Railway 内网服务名形态。

- [ ] **落实 `/` 的生产归属（按 X/Y 二选一）**
      文件：`ops/nginx/nginx.conf`（第 213–215 行 `location /`）和/或 `packages/frontend/next.config.mjs`。
  - 选 X：把 `/` 从"打到 frontend 容器"改成"反代 Vercel"，并补 `resolver` / `proxy_ssl_server_name on` / `Host` 头 / `X-Forwarded-Host` 等整套指令（现在完全没有）。
  - 选 Y：nginx 退化为只分发 ST（`/` 不再由 nginx 承载）；在 `next.config.mjs` 加生产 `rewrites().beforeFiles` 把 ST 路径转发到 Railway。

---

## 2. ⚠️ 上线前必做（可最后做，但不能跳）

- [ ] **产出分服务生产 env 模板**（目前只有本地用的 `.env.compose.example`）
      建议新建 `ops/env/*.env.production.example`，区分 Vercel 变量 / Railway 各服务变量 / 内网地址，并写明跨服务必须一致的密钥。

- [ ] **补齐 LLM 计费相关 env**
      `.env.compose.example` 和生产模板里 backend 段缺 `LLM_API_KEY` / `LLM_UPSTREAM_URL` / `LLM_PROXY_TOKEN_SECRET`；sync-engine 段缺 `LLM_PROXY_TOKEN_SECRET`。
      并确保 **backend 与 st-bundle 两服务的 `LLM_PROXY_TOKEN_SECRET` 和 `ST_USER_PASSWORD_SECRET` 逐字一致**（建议用 Railway 项目级共享变量）。

- [ ] **生产 Railway 注入 `PROVISION_API_BIND_HOST=0.0.0.0`**
      否则独立的 backend 服务跨服务调不到 st-bundle 容器里的 provision-api（源码默认 `127.0.0.1`）。

- [ ] **收口 nginx `/provision-api/` 暴露**
      文件：`ops/nginx/nginx.conf`（第 182–184 行）。无鉴权服务别走公网网关——生产删除该 location 或加网段白名单，backend 走内网直连。

- [ ] **Railway 服务接线 + 文档化**
      哪个服务拉哪个 GHCR 镜像 tag、st-bundle 绑 volume、服务间内网 DNS。控制台操作，至少把映射写进文档。

- [ ] **生产 Supabase 迁移**
      按序应用 `packages/shared/migrations/` 001–022 + `packages/backend/prisma/migrations/` + seed。
      **应用完务必执行 `NOTIFY pgrst, 'reload schema';`**，否则计费 RPC 静默失败（已踩过这个坑）。

- [ ] **Storage `character-assets` bucket**
      目标环境创建 bucket、验证 service role 下载权限，运营用 `scripts/import-character.ts` 把角色卡 PNG 以 `platform_<uuid>.png` 上传。

---

## 3. 🔴 清理/降级（避免误导，穿插做）

- [ ] **frontend 容器/镜像标注为"仅本地"**
      `ops/docker/Dockerfile.frontend` 及 `build-and-push.yml` 里 frontend 镜像：生产前端在 Vercel，不进 Railway。不必删（本地全栈仿真有用），但要在文档/编排里写清"生产不部署此镜像"，别让人以为前端要上 Railway。

---

## 4. 🧹 文档/注释纠错（小，证据确凿）

- [ ] `packages/backend/.env.example:49` 把过时的 `LLM_PROXY_SECRET` 改为 `LLM_PROXY_TOKEN_SECRET`（代码实际用后者）。
- [ ] `packages/sync-engine/src/provision-api/server.ts:8` 注释"仅绑定 127.0.0.1，外部不可直连"已过时（第 21 行已支持 env 覆盖），更新注释。
- [ ] `docs/QUICKSTART.md:19` 删除/更新过时的 `ST_PLATFORM_ASSETS_PATH`（provisioner 已纯 Storage）。

---

## 5. 💤 上线后补（不阻塞）

- [ ] TLS/对外域名绑定 + BotFather `/setdomain` 白名单（Railway/Vercel 边缘自带 TLS，平台侧操作）。

---

## 验收（怎么判断回到正轨）

1. `ghcr.io/<owner>/st-miniapp-{backend,st-backend,nginx}` 三镜像都是 amd64+arm64。
2. Railway 上 backend、st-bundle（绑 volume）独立且 healthy；前端在 Vercel；Railway 里没有 frontend 容器。
3. 对外域名上路由分发正确，`/provision-api/` 公网打不通。
4. 浏览器里 ST iframe 与主页同源，bridge 握手 ready。
5. 两服务共享密钥逐字一致；provision 与 LLM 计费都通。
6. 生产库迁移+seed+reload schema 完成，扣费不报 schema cache 缺失。
7. 端到端跑通 6 项 MVP，后端日志出现 `deduction success`。
8. 对话逐字流式可见、长回复不断流。
