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

> 决议（不可推翻）：对外域名绑 **Vercel**，前端作为边缘入口。ST 退场后 nginx 已无分发
> 对象，**网关收敛为「Vercel 直连 backend」**：nginx 与 st-bundle 一并退场。Railway
> 运行 backend API 和一个独立的支付对账 Cron；其中只有 backend 对外提供 HTTP 服务。

```
                 对外域名 (绑 Vercel)
                        │
                  ┌─────▼─────┐
                  │  Vercel   │  前端页面（无 rewrites）
                  │ (frontend)│  NEXT_PUBLIC_API_URL → backend 公网域名
                  └─────┬─────┘
                        │  浏览器直接发往 backend 域名的 /api/*（跨域，靠 CORS）
                  ┌─────▼──────┐
                  │  stminiapp │  唯一 Railway 服务（Fastify，监听 8080）
                  │  backend   │  FRONTEND_URL = Vercel 对外域名
                  └─────┬──────┘
                        ▼
              Supabase / OpenRouter

  Railway Cron（每 5 分钟）──▶ stminiapp-payment-cron
                              同 backend 镜像，运行一次支付对账后退出
```

前端与 backend 之间没有任何反代，因此两侧各有一个必须对齐的变量：Vercel 的
`NEXT_PUBLIC_API_URL`（build 期固化）指向 backend 公网域名，backend 的 `FRONTEND_URL`
（CORS allow-origin）指向 Vercel 对外域名。任一侧配错都表现为浏览器侧请求全挂。

## ⚠️ 网关收敛的手动收尾

`.railway/railway.ts` 的改动**不会**自动同步到 Railway（见文首说明），所以仓库里删掉
nginx / st-bundle 之后，控制台里的残留服务需要手动清：

1. 确认 Vercel 的 `NEXT_PUBLIC_API_URL` 已指向 backend 公网域名（`stminiapp` 的
   Settings → Networking 里生成/确认域名），且 backend 的 `FRONTEND_URL` 是 Vercel
   对外域名；redeploy 前端后验证 lobby / 对话链路正常。
2. 确认无流量后，删除 `nginx-pro`（及 dev 环境的 `nginx`）服务。
3. 删除 `st-bundle-pro`（及 dev 环境的 `st-bundle`）服务；卷 `st-data-pro` /
   `st-bundle-data` 里是 ST 用户目录，**要留档的先导出再删卷**。
4. GHCR 上 `st-miniapp-nginx` / `st-miniapp-st-backend` 两个 package 不再有新 tag
   产出，可按需归档或删除。

> 历史拓扑（Vercel rewrites → nginx → backend / st-bundle，含 dev/prod 的
> `-pro` 服务名对照表与各 upstream 变量取值）见 commit `c737294` 及其之前的本文件版本。

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

## 服务（控制台首次创建）

`.railway/railway.ts` 只描述 desired state，**不创建项目**。首次需在 Railway 控制台
建好 project + 该服务，服务名必须与 `.railway/railway.ts` 里 `service(...)` 第一个
参数**逐字一致**：

| 服务名（控制台 & IaC）   | GitHub source                         | 监听端口 | healthcheck | 对外                          | 卷  |
| ------------------------ | ------------------------------------- | -------- | ----------- | ----------------------------- | --- |
| `stminiapp`              | `ST_miniapp`：dev=`dev` / prod=`main` | 8080     | `/health`   | ✅ 绑 Railway 域名/自定义域名 | —   |
| `stminiapp-payment-cron` | 与 `stminiapp` 相同                   | —        | 关闭        | ❌ 不生成域名                 | —   |

创建步骤：

1. 控制台 New → Empty Service（或 Deploy from Image），命名为 `stminiapp`。
2. Service Settings → Source 连接 GitHub 仓库 `linshu368/ST_miniapp`；development 选择
   `dev`，production 选择 `main`。
3. 变量按下方「环境变量」从 `ops/env/backend.env.production.example` 填入。⚠️ `PORT`
   必须与 Railway 路由到容器的端口一致（缺失会 502）。
4. Settings → Networking 生成 Railway 域名（或自定义域名），把它配到 Vercel 的
   `NEXT_PUBLIC_API_URL`（见 `ops/env/vercel.env.production.example`）；反向把 Vercel
   对外域名配到本服务的 `FRONTEND_URL`。
5. 建好、变量填好后，可选用 IaC 对齐：development 运行 `railway config plan` /
   `railway config apply`；production 必须显式运行
   `RAILWAY_CONFIG_ENV=production railway config plan` /
   `RAILWAY_CONFIG_ENV=production railway config apply`。

### 支付对账 Cron

`stminiapp-payment-cron` 必须是独立服务；不能在 `stminiapp` 上设置 Cron Schedule，
否则 Railway 会按周期启动并终止 API deployment。

IaC 可用时，`.railway/railway.ts` 中的 `fn('stminiapp-payment-cron', ...)` 会配置该服务。
若目标环境尚不能用 IaC 管理，则在 Railway 控制台手动创建并逐项对齐：

> 应用 IaC 前必须检查 `railway config plan`。如果 plan 除创建 Cron 外还会修改
> `stminiapp` 的 source、变量、域名或 healthcheck，立即停止，改用控制台只创建 Cron；
> 禁止为了上线 Cron 顺带覆盖现有 API 服务配置。

1. New → Empty Service，命名为 `stminiapp-payment-cron`。
2. Source 连接与 `stminiapp` 相同的 GitHub 仓库和分支：development 用 `dev`，
   production 用 `main`。Build 的 Dockerfile Path 使用 `/ops/docker/Dockerfile.backend`。
3. Start Command 覆盖为 `tsx src/scripts/expire-payment-orders.ts`。
4. Cron Schedule 填 `*/5 * * * *`（UTC）。
5. 关闭 healthcheck，不生成 Railway domain，不配置 TCP proxy。
6. 以下变量全部使用 Railway reference 指向 `stminiapp`，不要复制值：
   - `PAYMENT_ENABLED`、全部 `PAYMENT_*`
   - `DATABASE_ENV`、`DATABASE_URL`、`DIRECT_URL`
   - development：全部 `TEST_DATABASE_*`、`TEST_DIRECT_*`、`TEST_SUPABASE_*`
   - production：全部 `PROD_DATABASE_*`、`PROD_DIRECT_*`、`PROD_SUPABASE_*`
7. Restart Policy 设为 `Never`。手动 Run 一次，确认日志出现
   `Reconciled before expiry: checked=… settled=…` 且 deployment 正常退出。

> Railway 内网 DNS 形如 `<service>.railway.internal`（本服务为
> `stminiapp.railway.internal:8080`）。收敛为单服务后已无跨服务调用，内网地址目前
> 没有消费方，仅在将来新增 Railway 服务时才需要。

## 环境变量

每个部署目标的变量取自对应模板（含逐项注释、是否必填、来源）：

- backend（服务 `stminiapp`）→ [`ops/env/backend.env.production.example`](../env/backend.env.production.example)
- Vercel（前端）→ [`ops/env/vercel.env.production.example`](../env/vercel.env.production.example)

⚠️ **两侧必须对齐**（配错即浏览器侧请求全挂）：backend 的 `FRONTEND_URL` = Vercel 对外
域名；Vercel 的 `NEXT_PUBLIC_API_URL` = backend 公网域名（改后需 redeploy 前端）。

密钥类变量只在控制台（或 IaC secret）注入，**不写进 `.railway/railway.ts`**，仓库内
模板只给占位与说明。

## 自动部署流程

1. development 的两个服务都连接 `dev`，production 的两个服务都连接 `main`。
2. 对应分支 push 后，Railway 分别构建 API 与 Cron；两者以同一 Git commit 为发布基准，
   不需要人工同步 GHCR tag。
3. 两个服务是独立 deployment，短时间内可能版本不一致；发布后需确认两边最新成功
   deployment 的 commit SHA 相同。
4. 回滚时在 Git 分支回滚对应 commit，两个服务会再次自动部署同一代码版本。
