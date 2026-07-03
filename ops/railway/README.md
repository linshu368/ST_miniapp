# ops/railway — Railway 生产拓扑（方案 Y）

> ## ⚠️ `.railway/railway.ts` 不会被 Railway 自动读取生效
>
> **它不像 `railway.json`。** `railway.json` / `railway.toml` 会在**每次部署时被 Railway
> 自动读取**并合并进该服务的 build/deploy 设置；而 `.railway/railway.ts` 属于 Railway 的
> **Infrastructure as Code（IaC）**，**只有在你用 Railway CLI 显式运行 `railway config plan`
> / `railway config apply` 时才生效**，普通 push / 控制台部署**不会**自动读取它。
>
> 因此：**修改 `.railway/railway.ts` 不会自动同步到 Railway。** 你必须二选一：
>
> 1. 用 CLI 显式应用：`railway link` → `railway config plan`（看 diff）→ `railway config apply`；或
> 2. 把它当作「配置文档 / 人工对照填表」，在 Railway 控制台**手动对齐**对应设置。
>
> 另注：IaC DSL 官方标注为 **experimental**；且**同一服务不能同时被 railway.json 与 IaC 管理**。
> 本仓库不放任何 railway.json，仅以本 IaC 文件描述拓扑。
>
> 依据（Railway 官方文档）：
>
> - Config as Code（railway.json，按部署自动读取）：<https://docs.railway.com/config-as-code>
> - Infrastructure as Code（`.railway/railway.ts`，需 CLI `config apply`）：<https://docs.railway.com/infrastructure-as-code>
> - IaC reference：<https://docs.railway.com/infrastructure-as-code/reference>

> 决议（不可推翻）：对外域名绑 **Vercel**，前端作为边缘入口；Vercel 通过 Next.js
> rewrites 把 ST 相关路径与 `/api/*` 转发到 Railway nginx；Railway nginx 退化为
> **仅做 ST 与 backend 的内部分发**。Railway 只跑三个服务，前端不在 Railway。

```
                 对外域名 (绑 Vercel)
                        │
                  ┌─────▼─────┐
                  │  Vercel   │  前端页面 + Next.js rewrites
                  │ (frontend)│  (ST_PUBLIC_PROXY_URL → Railway nginx)
                  └─────┬─────┘
                        │  /tavern/*、ST /api/*、/api/platform/*
                  ┌─────▼─────┐
                  │   nginx   │  唯一对外 Railway 服务（仅内部分发）
                  └──┬─────┬──┘
            /api/... │     │ /tavern/*、ST /api/*、ST 资产
              backend│     │st-bundle
          ┌──────────▼─┐ ┌─▼───────────────────────────┐
          │  backend   │ │  st-bundle                  │
          │ Fastify    │─┼─▶ ST(8000)+provision(9091)  │
          │ (3001)     │ │  +watcher(9090)  [volume]   │
          └────────────┘ └─────────────────────────────┘
            backend ──(Railway 内网, 不经 nginx)──▶ st-bundle:9091 (provision-api)
```

## ⚠️ 环境与服务名对照（dev vs production）

Railway **同一 project 下不允许两个同名 service**。本仓库的 `gallant-insight`
project 同时承载 `development` 与 `production` 两个环境，`development` 已先占用了
`nginx` / `st-bundle` 这两个名字，因此 `production` 环境的对应服务只能改名加 `-pro`
后缀。**backend 服务两个环境同名 `stminiapp`**（它在 dev 下未与其他服务重名）。

| 角色             | development 服务名 | production 服务名   | 内网 DNS（prod）                                                                | 卷（prod）                             |
| ---------------- | ------------------ | ------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| 网关 nginx       | `nginx`            | **`nginx-pro`**     | `nginx-pro.railway.internal`（对外公网：`nginx-pro-production.up.railway.app`） | —                                      |
| ST + sync-engine | `st-bundle`        | **`st-bundle-pro`** | `st-bundle-pro.railway.internal`                                                | `st-data-pro`（`/home/node/app/data`） |
| backend Fastify  | `stminiapp`        | `stminiapp`         | `stminiapp.railway.internal:8080`                                               | —                                      |

因此 **production 环境**的跨服务地址与 dev 不同，配置时按下表取值（下文
「内网服务名约定」表中的 `st-bundle.railway.internal` 在 prod 应替换为
`st-bundle-pro.railway.internal`）：

| 变量（所在服务）                 | production 取值                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `ST_BASE_URL`（stminiapp）       | `http://st-bundle-pro.railway.internal:8000`                                               |
| `ST_PROVISION_URL`（stminiapp）  | `http://st-bundle-pro.railway.internal:9091`                                               |
| `ST_UPSTREAM`（nginx-pro）       | `st-bundle-pro.railway.internal:8000`                                                      |
| `BACKEND_UPSTREAM`（nginx-pro）  | `stminiapp.railway.internal:8080`                                                          |
| `LLM_PROXY_URL`（st-bundle-pro） | `http://stminiapp.railway.internal:8080/api/platform/llm-proxy/v1`（backend 同名，无需改） |
| `PORT`（nginx-pro）              | `80`（Railway 据此路由公网域名到容器；缺失会 502）                                         |

> nginx-pro 的构建源为仓库（分支 `main`），**Root Directory 必须设为 `ops/nginx`**
> （其 Dockerfile 内 `COPY nginx.conf` 相对构建上下文；根目录留 `/` 会构建失败
> `"/nginx.conf": not found`）。st-bundle-pro / stminiapp 用仓库根 + 各自 Dockerfile
> 路径（`/ops/docker/Dockerfile.st-bundle`；stminiapp 走 Railpack）。

> `.railway/railway.ts` 里的 `service('nginx'|'st-bundle', ...)` 名字对应 **dev**
> 语义命名；prod 环境实际为 `-pro` 后缀。IaC 目前未在 prod 实际 apply（本仓库 CLI
> 版本不支持 `config apply`），prod 三服务由控制台创建 + `railway variables --set`
> 注入，故此命名差异不影响运行时。

## 配置进仓库：为什么是 `.railway/railway.ts` 而不是 `railway.json`

Railway 的 `railway.json` / `railway.toml` 是**单服务部署配置**，只能写 `build` /
`deploy` 两段（`healthcheckPath`、`startCommand`、`restartPolicyType`、`numReplicas`
等），**无法**描述多服务、镜像来源或 volume 挂载（这些在 railway.json schema 里根本
不存在，参考官方 [Config as Code reference](https://docs.railway.com/config-as-code/reference)）。

多服务 + 镜像源 + 卷的「配置进仓库」官方支持方式是 **Infrastructure as Code**：仓库根
`.railway/railway.ts`，导出 `defineRailway`，用 `service()` / `image()` / `volume()`
描述（参考 [IaC reference](https://docs.railway.com/infrastructure-as-code/reference)）。

因此本仓库的 Railway 配置在 [`.railway/railway.ts`](../../.railway/railway.ts)。

> 注：IaC DSL 官方标注为 experimental；它通过 `railway config plan` / `railway config apply`
> 生效，且**一个服务不能同时被 railway.json 与 IaC 管理**。本仓库不放任何 railway.json，
> 避免双重真相源。

## 三服务（控制台首次创建）

`.railway/railway.ts` 只描述 desired state，**不创建项目**。首次需在 Railway 控制台
建好 project + 三个服务，服务名必须与 `.railway/railway.ts` 里 `service(...)` 第一个
参数**逐字一致**（内网 DNS 依赖服务名）：

| 服务名（控制台 & IaC） | 镜像（GHCR）            | 监听端口                                     | healthcheck     | 对外                                     | 卷                    |
| ---------------------- | ----------------------- | -------------------------------------------- | --------------- | ---------------------------------------- | --------------------- |
| `nginx`                | `st-miniapp-nginx`      | 80                                           | `/nginx-health` | ✅ 绑 Railway 域名（供 Vercel rewrites） | —                     |
| `backend`              | `st-miniapp-backend`    | 3001                                         | `/health`       | ❌ 仅内网                                | —                     |
| `st-bundle`            | `st-miniapp-st-backend` | 8000 (ST) / 9091 (provision) / 9090 (health) | `/`（ST 8000）  | ❌ 仅内网                                | `/home/node/app/data` |

创建步骤（每个服务）：

1. 控制台 New → Empty Service（或 Deploy from Image），命名为上表服务名。
2. Service Settings → Source → Docker Image，填 `ghcr.io/<OWNER>/st-miniapp-<svc>:<tag>`
   （GHCR 为私有时配置 registry 凭据）。
3. 变量按下方「环境变量」从对应 `ops/env/*.env.production.example` 填入。
4. `st-bundle`：Settings → Volumes 新增卷，Mount path = `/home/node/app/data`。
5. `nginx`：Settings → Networking 生成一个 Railway 域名（或自定义二级域名），把它配到
   Vercel 的 `ST_PUBLIC_PROXY_URL`（见 `ops/env/vercel.env.production.example`）。
6. 三服务建好、变量填好后，可选用 IaC 对齐：`railway link` → `railway config plan`
   →（确认 diff 无误）`railway config apply`。镜像 tag 用环境变量注入：
   `GHCR_OWNER=<owner> IMAGE_TAG=sha-xxxxxxx railway config apply`。

## 内网服务名约定（关键）

Railway 内网 DNS 形如 `<service>.railway.internal`，仅内网可达。本拓扑约定：

| 引用方                   | 目标      | 地址                                                                             |
| ------------------------ | --------- | -------------------------------------------------------------------------------- |
| nginx upstream `backend` | stminiapp | `stminiapp.railway.internal:8080`（envsubst 注入 `BACKEND_UPSTREAM`）            |
| nginx upstream `st`      | st-bundle | `st-bundle.railway.internal:8000`（envsubst 注入 `ST_UPSTREAM`）                 |
| backend → ST             | st-bundle | `ST_BASE_URL=http://st-bundle.railway.internal:8000`                             |
| backend → provision-api  | st-bundle | `ST_PROVISION_URL=http://st-bundle.railway.internal:9091`（**不经 nginx**）      |
| st-bundle → LLM 代理     | stminiapp | `LLM_PROXY_URL=http://stminiapp.railway.internal:8080/api/platform/llm-proxy/v1` |

> ⚠️ backend 的 Railway 服务名实际为 **`stminiapp`**（监听 **8080**，非 `backend`/3001）。
> 改服务名/端口会同时影响 nginx 的 `BACKEND_UPSTREAM`/`ST_UPSTREAM` 与 backend 的
> `ST_BASE_URL`/`ST_PROVISION_URL`、st-bundle 的 `LLM_PROXY_URL`，三处需一起改。

## 环境变量

每个服务的变量取自对应模板（含逐项注释、是否必填、来源）：

- nginx → [`ops/env/nginx.env.production.example`](../env/nginx.env.production.example)
- backend → [`ops/env/backend.env.production.example`](../env/backend.env.production.example)
- st-bundle → [`ops/env/st-bundle.env.production.example`](../env/st-bundle.env.production.example)
- Vercel（前端）→ [`ops/env/vercel.env.production.example`](../env/vercel.env.production.example)

⚠️ **跨服务逐字一致密钥**（backend 与 st-bundle 必须完全相同，否则鉴权/扣费链断）：

- `ST_USER_PASSWORD_SECRET`
- `LLM_PROXY_TOKEN_SECRET`

密钥类变量只在控制台（或 IaC secret）注入，**不写进 `.railway/railway.ts`**，仓库内
模板只给占位与说明。

## 镜像 tag 更新流程

1. push 到 `dev` / `dev_stage5_*` → CI（`.github/workflows/build-and-push.yml`）构建并推送
   `st-miniapp-{backend,st-backend,nginx}` 到 GHCR，tag：`sha-<short>` 与 `<branch>-latest`。
   （**frontend 镜像默认不构建**，前端在 Vercel；仅 `staging-*` tag 才构建 frontend。）
2. 部署某 commit：用其 `sha-<short>` tag。两种方式二选一：
   - 控制台：各服务 Settings → Source → 更新 image tag → Deploy。
   - IaC：`GHCR_OWNER=<owner> IMAGE_TAG=sha-<short> railway config apply`。
3. `st-bundle` 带卷，重新部署会有短暂停机（Railway 文档约 < 2 分钟），属预期。
4. 回滚：把 tag 切回上一个已知良好的 `sha-<short>` 重新部署即可。
