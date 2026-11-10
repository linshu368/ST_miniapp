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
> 运行 backend API、一个常驻支付对账 Worker，以及一个独立的支付过期 Cron；其中只有
> backend 对外提供 HTTP 服务。

```
                 对外域名 (绑 Vercel)
                        │
                  ┌─────▼─────┐
                  │  Vercel   │  前端页面（无 rewrites）
                  │ (frontend)│  NEXT_PUBLIC_API_URL → backend 公网域名
                  └─────┬─────┘
                        │  浏览器直接发往 backend 域名的 /api/*（跨域，靠 CORS）
                  ┌─────▼──────┐
                  │  stminiapp │  唯一对外 Railway 服务（Fastify，监听 8080）
                  │  backend   │  FRONTEND_URL = Vercel 对外域名
                  └─────┬──────┘
                        ▼
              Supabase / OpenRouter

  常驻 Worker（每 30 秒一轮）─▶ stminiapp-payment-reconcile-cron（快速查单）
  Railway Cron（每 5 分钟）──▶ stminiapp-payment-cron（过期前回溯查单并判过期）
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
4. GHCR 上 `st-miniapp-nginx`、`st-miniapp-st-backend`、`st-miniapp-backend`、
   `st-miniapp-frontend` 均无现行部署消费者，仓库也不再产出新 tag；既有
   package 可按回滚保留周期归档或删除。

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

| 服务名（控制台 & IaC）             | GitHub source                         | 监听端口 | healthcheck | 对外                          | 卷  |
| ---------------------------------- | ------------------------------------- | -------- | ----------- | ----------------------------- | --- |
| `stminiapp`                        | `ST_miniapp`：dev=`dev` / prod=`main` | 8080     | `/health`   | ✅ 绑 Railway 域名/自定义域名 | —   |
| `stminiapp-payment-reconcile-cron` | 与 `stminiapp` 相同                   | —        | 关闭        | ❌ 不生成域名                 | —   |
| `stminiapp-payment-cron`           | 与 `stminiapp` 相同                   | —        | 关闭        | ❌ 不生成域名                 | —   |
| `stminiapp-vip-reminder-cron`      | dev=`dev` / prod=`main`               | —        | 关闭        | ❌ 不生成域名                 | —   |

VIP 提醒 Cron 的启动命令固定为
`./node_modules/.bin/tsx src/scripts/send-vip-expiry-reminders.ts --write`，不得依赖镜像中不存在的
全局 `tsx`。它在 development（TEST）和 production 分别运行；是否真正写入仍由目标环境的
`vip_reminders_enabled` 开关控制，IaC 不负责打开该开关。
PR 临时环境复制 development 后会立即删除该 Cron，避免多个调度器扫描同一个 TEST 库。
`railway-pr-env.yml` 还会在创建及后续 upsert 时校准 `stminiapp-payment-cron`，固定使用
`./node_modules/.bin/tsx src/scripts/expire-payment-orders.ts`；检测到旧命令时更新配置并部署，
避免复制历史快照后因镜像没有全局 `tsx` 而启动失败。
部署 Cron 本身不会绕过业务开关；首次开启 `vip_reminders_enabled` 前须先在 TEST dry-run，
确认候选规模符合预期。Production 首次启用同样先保持开关关闭、部署 Cron，再用 Production
环境执行一次 `--dry-run`，确认候选规模后才打开开关。
修改 `.railway/railway.ts` 后仍要 `railway config plan` / `apply` 才会出现在控制台。

创建步骤：

1. 控制台 New → Empty Service，命名为 `stminiapp`。
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

### 支付对账（快速 Worker + 过期 Cron）

主动建单探测独立运行于 `stminiapp-payment-availability-probe`，Start Command 为
`./node_modules/.bin/tsx src/scripts/payment-availability-probe.ts`，Cron Schedule 为
`*/30 * * * *`，Restart Policy 为 `Never`，无域名、healthcheck 或 TCP proxy。
服务复用 backend 镜像；只在该服务设置 `PAYMENT_PROBE_ENABLED=true` 才启用，未设置默认关闭。
`PAYMENT_PROBE_CHANNEL` 默认 `alipay`；探测 clientip 自动取本机非回环 IPv4，无可用地址时使用 `127.0.0.1`，无需手动配置或请求外部 IP 服务。
IaC 保留开关和渠道两个部署变量，显式引用 API 的本环境 TTZF 凭据、notify/return URL、DB/DIRECT_URL 和观测配置。
无需向探测服务配置飞书 webhook，告警仍由下面的共享 worker 投递。
PR 工作流移除复制来的探测服务，运行时也拒绝 pr-/preview；代码与 IaC 不代表生产已启用。
先部署新告警规则投递兼容，再 TEST 验证并启用；异常时关闭探测开关即可。
单轮 1 元、无本地订单、多策略扩展与上线检查见 [支付探测说明](../../docs/payment-availability-probe.md)。

2026-11-10 发布记录：已在 production 补建 `stminiapp-payment-availability-probe`，连接
`main` 分支，按上述半小时周期与 Never 重启策略部署成功；development 未创建。
本次沿用默认关闭配置 `PAYMENT_PROBE_ENABLED=false`，渠道为 `alipay`，未执行真实建单或
飞书链路验收。完成上述受控验收后，将该服务的开关设为 `true` 并应用变量变更即可启用。

共享告警 outbox 由独立常驻服务 `stminiapp-payment-alert-monitor` 投递；该服务同时生产支付告警，
也负责发送 API 服务写入的 Sentry 与 OpenRouter/Venice/Surplus 限流、额度、账户访问告警，并在同轮主动查询
Venice `GET /api/v1/billing/balance`：当 `balances.usd`（null 按 0）低于 **$10** 时发布 generation 域
P1 `venice-balance-low`（fingerprint 含 `:generation:venice:balance_low`），恢复需连续两轮不低于阈值。
Surplus Intelligence 使用 `SURPLUS_API_BASE_URL` 下的 `GET /payments/balance` 与 `SURPLUS_API_KEY`，读取
`credit_balance_usdc` 微美元整数字符串并换算为可消费 USD 余额；余额低于
**$10** 时发布 P1 `surplus-balance-low`（fingerprint 含 `:generation:surplus:balance_low`），并要求连续两轮恢复。
任一余额探针失败（超时/网络/5xx/401 或响应不合法）只把本轮标为 partial，不关闭既有余额事故，也不阻断
支付监控、另一个供应商探针与 outbox。
Start Command 为
`./node_modules/.bin/tsx src/scripts/payment-alert-monitor.ts`，Restart Policy 为 `Always`，
不设 Cron Schedule、healthcheck、域名或 TCP proxy。它以数据库 advisory lock 防止重叠，
每分钟运行 P0、每五分钟运行 P1；支付规则只读支付操作事件（规则 v3 只看平台直接信号）并通过公共 outbox 发布，
每轮同时有界投递一条到期通知。模型告警与 Venice/Surplus 余额检查不新增服务；通过 Railway 服务变量引用沿用 API 的
`VENICE_API_KEY`（**须为可调 billing 的 Admin Key**）、`SURPLUS_API_KEY`、对应 base URL、公共 outbox 与
`FEISHU_ALERT_WEBHOOK_URL`。缺失或非法
`alerting` runtime config 时通知保持关闭。这里仅描述目标运行面，不授权 Railway apply、部署、
环境变量或通知开关写入。

两个任务都必须是独立服务；不能在 `stminiapp` 上设置 Cron Schedule，否则 Railway
会按周期启动并终止 API deployment。上线前必须先对目标数据库执行
`packages/shared/migrations/100_payment_reconciliation_schedule.sql`。

**Railway cron 最短间隔是 5 分钟**（平台硬限制：GraphQL 会返回
`Minimum interval between cron executions is 5 minutes`）。因此快速对账不能靠
`* * * * *`，必须改成常驻 Worker：进程内 `while` 每 30 秒跑一轮
`runPaymentReconciliation`，用 TTZF 易支付 `GET /api/epay/api.php`（act=order）单笔查最近 7 天
未履约新订单。每轮最多 30 单、并发 3、派发预算 25 秒，每次查单限时 5 秒；按既有
`next_reconcile_at` 查询前移到队尾，避免慢单饿死后续订单。已确认支付的结算允许完成。
过期兜底继续用 `*/5 * * * *`，仅对查单确认未付且超过本地期限的单标记过期。

**主服务及支付任务使用 `TTZF_APP_ID`、`TTZF_APP_KEY`、`TTZF_BASE_URL`**（IaC 引用主服务变量）。
APP_ID 是应用 ID，不是商户号；BASE_URL 默认 `https://ttzf8.com/api`。
主服务设置 `PAYMENT_NOTIFY_URL=https://<本环境后端域名>/api/payment/notify/ttzf` 和
`PAYMENT_RETURN_URL=https://<本环境后端域名>/api/payment/return`，建单逐次携带，不需要注册 Webhook。
建单不发送可选 `param`，回调/查单不依赖它。各环境使用独立回调地址、应用凭据及数据库；
回调只能履约本环境已存在的随机 EP 订单，仍校验签名、商户、渠道、交易号与精确金额。
厂商查单响应可能返回 `pid: null` 或省略该字段，后端接受这两种情况，有值时仍核对应用 ID；
请求中的 pid/key 和签名回调中的 pid 仍必填。订单、渠道、交易号及金额校验不变。
GET 查单遵循用户明确指定的协议：key 只在服务端 HTTPS 请求中传输，禁止日志/错误/遥测输出完整地址。
生产与测试配置分开，不把真实凭据放入源码、命令行或文档。

切换发布：先在明确的 TEST 环境联调建单、已付/未付查单、通知重放、晚付、VIP/星尘到账，再配置目标环境变量、部署 API 和两个任务，最后开放新建单。
当前仅代码与本地模拟验证，不代表远端已部署或真实支付可用；必须核验真实返回的交易号格式、HTTPS payurl、金额与回跳。
仅返回 qrcode/urlscheme 时目前不交出收银台，订单保留供后续可信恢复；需供应商返回 HTTPS payurl。
故障时关闭 `PAYMENT_ENABLED`，保留 TTZF 配置和新版本回调/查单，处理完在途订单再恢复；不能切回已停用厂商。
旧 `MA_…` 订单保留历史，未结订单人工核对，不用 TTZF 自动关闭/补账。无新增迁移。
Android/iOS 真机分别验证支付宝/微信唤起、关闭/重开、Telegram 回跳；按平台观测至少 7 天 P95，无样本不得填零。
支付 clientip 在 Railway 公共 HTTP 入口读取并校验 `X-Real-IP`，本地使用 socket IP；不得向不可信网络开放绕过边缘的 TCP/私有入口。
依据：[Railway 请求头说明](https://docs.railway.com/networking/public-networking/specs-and-limits#technical-specifications)。

IaC 可用时，`.railway/railway.ts` 会配置这两个服务。若目标环境尚不能用 IaC 管理，则在
Railway 控制台手动创建并逐项对齐：

> 应用 IaC 前必须检查 `railway config plan`。如果 plan 除这个对账 Worker / 过期 Cron
> 外还会修改 `stminiapp` 的 source、变量、域名或 healthcheck，立即停止，改用控制台
> **只改** `stminiapp-payment-reconcile-cron`；禁止为了对账调度顺带覆盖现有 API 服务配置。

1. New → Empty Service，分别命名为 `stminiapp-payment-reconcile-cron` 和
   `stminiapp-payment-cron`。
2. Source 连接与 `stminiapp` 相同的 GitHub 仓库和分支：development 用 `dev`，
   production 用 `main`。Build 的 Dockerfile Path 使用 `/ops/docker/Dockerfile.backend`。
3. 快速查单服务（常驻 Worker）：
   - Start Command：`./node_modules/.bin/tsx src/scripts/reconcile-payment-orders.ts`
   - **清空 Cron Schedule**（不要填 `* * * * *`，平台会拒绝）
   - Restart Policy：`Always`（或 `On Failure`）
   - 进程保持 Online，日志约每 30 秒一轮 `Payment reconciliation: checked=…`。
     缺少 TTZF 配置时跳过；关闭 `PAYMENT_ENABLED` 后继续恢复已有订单。SIGTERM/SIGINT 停止派发并中止在途查询。
   - 队列积压和供应商响应会影响恢复延迟，不能承诺每单 30 秒内到账。
4. 过期服务（一次性 Cron）保持不变：Start Command
   `./node_modules/.bin/tsx src/scripts/expire-payment-orders.ts`，Cron Schedule `*/5 * * * *`，
   Restart Policy `Never`。它运行同样的有限并发查单补账，仅确认未付的超时订单可标记 expired，部分查询失败不影响其他订单恢复。
5. 两个服务都关闭 healthcheck，不生成 Railway domain，不配置 TCP proxy。不要给
   Worker 加会打 `/health` 的 HTTP 探活（镜像 Dockerfile 的 HEALTHCHECK 针对 API；
   本服务没有 HTTP 端口，Railway 侧探活必须关掉，否则会把常驻循环判死）。
6. 以下变量全部使用 Railway reference 指向 `stminiapp`，不要复制值：
   - `PAYMENT_ENABLED`、全部 `PAYMENT_*`
   - `DATABASE_ENV`、`DATABASE_URL`、`DIRECT_URL`
   - development：全部 `TEST_DATABASE_*`、`TEST_DIRECT_*`、`TEST_SUPABASE_*`
   - production：全部 `PROD_DATABASE_*`、`PROD_DIRECT_*`、`PROD_SUPABASE_*`

把已有的快速 Cron 改成 Worker 时，顺序是：

1. 先部署含常驻循环的代码（可暂时保留 `*/5` schedule：下一次触发后进程不再退出，
   后续 cron tick 会被跳过）。
2. 再清空 Cron Schedule，并把 Restart Policy 改为 `Always`，然后 Restart / Redeploy
   一次，确认服务保持 Online。
3. 不要先清空 schedule 却仍用 `Never`：旧一次性脚本退出后服务会停掉。

上线顺序与验收：

1. 先在 test、production 分别执行
   `packages/shared/migrations/100_payment_reconciliation_schedule.sql`，再部署包含快速对账
   repository 的代码；顺序反过来会因缺少调度列导致快速任务失败。
   `103_payment_settled_by.sql`（入账来源，回调监控用）同理必须先于代码执行：它把入账函数换成
   三参签名，迁移先跑不影响旧代码，反过来则四条入账路径一起失败。历史设计见
   `git show 7541a54^:docs/payment-missing-credits-remediation.md` §3.1。
2. 用生产测试账号创建并支付最低金额订单，支付后不返回 MiniApp，也不打开订单详情。
3. Worker 应持续 Online；Railway 日志约每 30 秒一轮，并在订单 `created_at` 后约 60–90 秒
   出现同一 `orderId` 的 `payment.query.paid source=cron` 和
   `payment.settle.completed source=cron`。
4. 数据库中该订单应为 `status=completed, credits_added=true`，且 `wallet_ledger` 对
   `reference_type=payment_order, reference_id=<orderId>` 只有一行。
5. 若需紧急回滚，只停用 `stminiapp-payment-reconcile-cron`；保留 migration 100 的列和
   原 `stminiapp-payment-cron`，支付仍会按 5 分钟过期兜底运行。

> Railway 内网 DNS 形如 `<service>.railway.internal`（本服务为
> `stminiapp.railway.internal:8080`）。收敛为单服务后已无跨服务调用，内网地址目前
> 没有消费方，仅在将来新增 Railway 服务时才需要。

## 环境变量

每个部署目标的变量取自对应模板（含逐项注释、是否必填、来源）：

- backend（服务 `stminiapp`）→ [`ops/env/backend.env.production.example`](../env/backend.env.production.example)
- Vercel（前端）→ [`ops/env/vercel.env.production.example`](../env/vercel.env.production.example)

若运营模型目录启用 Venice，必须在 `stminiapp` 的对应 Railway 环境单独配置
`VENICE_API_KEY`；可选的 `VENICE_API_BASE_URL` 默认是 `https://api.venice.ai/api/v1`。
若启用 Surplus Intelligence，则同一环境必须配置 `SURPLUS_API_KEY` 与 `SURPLUS_API_BASE_URL`；余额监控要求该 base
实现官方文档中的 `GET /payments/balance`。IaC 只把这些变量从 `stminiapp` 引用到 `stminiapp-payment-alert-monitor`，
不会把真实密钥写入仓库。
密钥只属于 backend，不得放入 Vercel/Admin 浏览器变量。先配置密钥并 redeploy backend，
确认 `/api/platform/model-providers/venice/models` 可读取目录后，再发布含 Venice 模型的目录；
回滚时先把目录发布回 OpenRouter 模型，再移除 Venice 密钥。

⚠️ **两侧必须对齐**（配错即浏览器侧请求全挂）：backend 的 `FRONTEND_URL` = Vercel 对外
域名；Vercel 的 `NEXT_PUBLIC_API_URL` = backend 公网域名（改后需 redeploy 前端）。

密钥类变量只在控制台（或 IaC secret）注入，**不写进 `.railway/railway.ts`**，仓库内
模板只给占位与说明。

## ⚠️ `PROD_DATABASE_URL` 连接池配置（2026-10 事故记录）

这个值**只存在于 Railway 控制台**，不受版本控制，改错了也不会报错、不会出现在任何
代码 diff 里——2026-10 期间曾被悄悄改成直连 5432 + `connection_limit=1`（整个
`stminiapp` 服务任意时刻只能有 1 个请求在碰数据库），导致反复出现"大规模卡顿/堵塞"，
查不到是谁、什么时候改的，因为它根本不在 git 历史里。

**已验证可用的正确值**（见 `ops/env/backend.env.production.example` 同名变量注释）：

```
postgresql://...@<host>:6543/<db>?pgbouncer=true&connection_limit=10&pool_timeout=10
```

- 端口必须是 `6543`（Supavisor transaction-mode pooler），不是 `5432`（直连，session
  模式、不支持多路复用）。
- `pgbouncer=true`：告诉 Prisma 这是经过 pooler 的连接，调整协议行为。
- `connection_limit=10`：Prisma 自己进程内维护的连接数上限；缺省值偏大，会和
  Supavisor 共享池抢位，在生产库 `max_connections=60`（曾观测到已用 51）下很容易
  把池榨干。
- `pool_timeout=10`（秒）：排队等连接超过这个时间就报错而不是无限挂起；没有这个参数，
  池耗尽时请求会一直卡住、前端表现为"无限转圈"而不是报错。

改这个值之前，先用 `railway variables --kv | grep '^PROD_DATABASE_URL='` 确认当前值，
改完同样方式核对，并把变更和理由记在这里（哪怕只是一行），避免下一次又是"查不到是谁
改的、什么时候改的"。**不要在终端里直接打印完整 URL**（含密码）；只替换 query string
部分可以用脚本做正则替换，不经手输出密码本身。

## 自动部署流程

1. development 与 production 的四个服务分别连接 `dev` 与 `main`。
2. 对应分支 push 后，Railway 分别构建 API、快速对账 Worker、支付过期 Cron 与 VIP 提醒
   Cron；四者以同一 Git commit 为发布基准，不经过镜像仓库交接。
3. 四个服务是独立 deployment，短时间内可能版本不一致；发布后需确认四边最新成功
   deployment 的 commit SHA 相同。
4. 回滚时在 Git 分支回滚对应 commit，三个服务会再次自动部署同一代码版本。
