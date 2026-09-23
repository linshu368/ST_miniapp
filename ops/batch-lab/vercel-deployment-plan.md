# Batch Lab 部署到 Vercel 配置方案

> 适用范围：`packages/batch-lab` 静态 SPA 部署到 Vercel，浏览器跨域调用 Railway Fastify Backend。
> 方案状态：配置与操作方案，不包含真实域名、数据库 URI、service-role 或模型密钥。
> 推荐策略：先部署 test/development 环境并完成验收；production 保持关闭，单独审批后再开放。

## 1. 目标拓扑

```text
内部使用者
  -> Vercel Batch Lab SPA
       VITE_BATCH_LAB_API_URL=https://<backend-domain>
  -> Railway Backend /api/batch-lab/*
       BATCH_LAB_URL=https://<batch-lab-domain>
  -> Supabase batch_lab schema（平台事实域）
  -> Supabase source DB（专用只读账号，仅 3 张来源表）
  -> LLM provider（BATCH_LAB_MODEL_KEY 仅在 Backend）
```

Batch Lab Vercel 项目只托管静态页面，不连接数据库、不执行 worker、不保存模型密钥。样本 SQL、freeze、实验状态机和 worker 继续由 Backend 处理。

## 2. 环境规划

建议建立一个独立 Vercel Project，例如 `st-batch-lab`，不要复用 Frontend、Admin 或 CS Platform 的 Vercel Project。

| Vercel 环境 | Git 来源        | Backend 目标                                                        | 数据来源   | 建议状态             |
| ----------- | --------------- | ------------------------------------------------------------------- | ---------- | -------------------- |
| Preview     | PR / 非生产分支 | 对应 Railway PR Backend；无法一一对应时使用固定 development Backend | test       | 内部验证             |
| Production  | `main`          | Railway production Backend                                          | production | 默认关闭，审批后开放 |

### 2.1 推荐的第一阶段

第一阶段只开放 test：

- Vercel Batch Lab 使用固定的内部测试域名，例如 `https://<batch-lab-test-domain>`。
- `VITE_BATCH_LAB_API_URL` 指向 Railway development Backend。
- Backend 使用 `DATABASE_ENV=test`、`BATCH_LAB_SAMPLE_SOURCE_ENV=test`。
- Backend 的 `BATCH_LAB_URL` 精确填写上述 Vercel origin。
- 不配置 production source，不开启 `BATCH_LAB_ALLOW_PRODUCTION_SOURCE`。

### 2.2 Preview URL 限制

Backend 当前只有一个 `BATCH_LAB_URL`，CORS 采用精确 origin 匹配。Vercel 每个 deployment 的随机 Preview URL 无法自动全部通过 Backend CORS。

可选方案：

1. **推荐：固定测试域名或稳定 branch domain**。Backend 只 allowlist 该稳定 origin。
2. 每个 PR 创建 Railway PR Backend，并把该次 Vercel Preview 的精确 origin 注入对应 Backend；适合完整临时环境自动化，但运维复杂。
3. 扩展 Backend 支持受控的 Batch Lab origin allowlist；需另立开发任务，不能用宽泛 `*.vercel.app` 替代鉴权。

在当前代码不改动的前提下，方案 1 最稳妥。

## 3. Vercel Project 配置

### 3.1 Import Project

在 Vercel 控制台执行：

1. Add New → Project。
2. 选择本仓库。
3. Project Name：建议 `st-batch-lab`。
4. Framework Preset：`Other`。
5. **Root Directory：`packages/batch-lab`**。
6. 保持读取包内 [`vercel.json`](../../packages/batch-lab/vercel.json)。

推荐使用包目录作为 Root Directory，原因是当前配置文件位于 `packages/batch-lab/vercel.json`，且其 `outputDirectory` 为相对包目录的 `dist`。如果把 Root Directory 设为仓库根，Vercel 不应被假定会自动读取子目录里的 `vercel.json`，输出目录也要改成 `packages/batch-lab/dist`；不要混用两种口径。

### 3.2 生效配置

当前包内配置：

```json
{
  "framework": null,
  "installCommand": "pnpm install",
  "buildCommand": "pnpm --filter @miniapp/batch-lab build",
  "outputDirectory": "dist",
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

配置含义：

- 从 pnpm workspace 安装依赖。
- 只构建 `@miniapp/batch-lab`。
- 发布 Vite 的 `dist`。
- 所有前端路由回退到 `index.html`，刷新 SPA 路径不返回 404。

### 3.3 Node.js 与 pnpm

- Node.js：选择 `22.x`，与根 `package.json` 的 `node >=22` 一致。
- pnpm：仓库通过 `packageManager: pnpm@9.15.9` 锁定版本。
- Install Command：使用配置中的 `pnpm install`。
- 不要改用 npm/yarn，也不要只复制 `packages/batch-lab` 脱离 workspace 构建，因为它依赖 `@miniapp/shared`。

### 3.4 Git 部署设置

- Production Branch：`main`。
- Preview：PR 自动部署可以保留，但只有其 API base 和 Backend CORS origin 对齐时才可用。
- 若第一阶段只需要固定 test 环境，可将稳定测试域名绑定到 development/指定分支 deployment，并避免把随机 Preview URL 当正式入口。

## 4. Vercel 环境变量

Batch Lab 浏览器端当前只需要一个变量：

```dotenv
VITE_BATCH_LAB_API_URL=https://<railway-backend-domain>
```

配置规则：

- 值必须是 Backend 公网 origin，包含 `https://`，末尾不需要 `/`。
- Preview 必须指向 development/PR Backend，禁止默认指向 production Backend。
- Production 只在 production Batch Lab 已审批开放时指向 production Backend。
- `VITE_*` 在构建时进入浏览器 bundle；改值后必须 Redeploy。
- 变量不是 secret，但必须避免环境误连。

### 4.1 禁止配置到 Vercel 的变量

以下变量不得出现在 Batch Lab Vercel Project：

- `SUPABASE_SERVICE_ROLE_KEY`
- `DATABASE_URL` / `DIRECT_URL`
- `BATCH_LAB_SOURCE_DATABASE_URL`
- `BATCH_LAB_MODEL_KEY`
- `LLM_API_KEY` / `OPENAI_API_KEY`
- 任何 PostgreSQL 密码、provider token 或私钥

Batch Lab 当前不直连 Supabase，因此也不需要 Supabase URL 或 publishable/anon key。

## 5. Backend 配套配置

Vercel 页面部署成功不代表 Batch Lab 可用。Backend 必须同时满足 feature、CORS、数据库和模型配置。

### 5.1 Test/development Backend

以下是变量名称和安全占位，真实值只写 Railway Variables：

```dotenv
# 开关与 CORS
BATCH_LAB_ENABLED=true
BATCH_LAB_URL=https://<batch-lab-test-domain>

# 来源环境
BATCH_LAB_SAMPLE_SOURCE_ENV=test
BATCH_LAB_SOURCE_DATABASE_URL=<secret-read-only-postgres-uri>
BATCH_LAB_SOURCE_CONNECT_TIMEOUT_MS=3000
BATCH_LAB_SOURCE_MAX_CONNECTIONS=2

# 实验模型调用
BATCH_LAB_MODEL_KEY=<secret-provider-key>
```

同时 Backend 自身必须正确指向 test Supabase：

- `DATABASE_ENV=test`
- 对应 `TEST_DATABASE_*`、`TEST_DIRECT_*`、`TEST_SUPABASE_*` 变量组完整且 project ref 正确。
- `BATCH_LAB_SOURCE_DATABASE_URL` 的用户必须是 `batch_lab_source_login`，不能是 `postgres` 或 `service_role`。
- 非本地环境连接必须启用 TLS：默认使用 `sslmode=require`；仅在证书链无法由运行时验证且风险已明确接受时，才使用 `sslmode=no-verify`。后者仍加密传输，但不验证数据库服务端证书身份。

### 5.2 Production Backend

只有完成 production 专项审批和验证后才配置：

```dotenv
BATCH_LAB_ENABLED=true
BATCH_LAB_URL=https://<batch-lab-production-domain>
BATCH_LAB_SAMPLE_SOURCE_ENV=production
BATCH_LAB_ALLOW_PRODUCTION_SOURCE=true
BATCH_LAB_SOURCE_DATABASE_URL=<secret-production-read-only-postgres-uri>
BATCH_LAB_SOURCE_CONNECT_TIMEOUT_MS=3000
BATCH_LAB_SOURCE_MAX_CONNECTIONS=2
BATCH_LAB_MODEL_KEY=<secret-provider-key>
```

此外必须满足：

- Backend 的 `DATABASE_ENV=production`。
- source URI project ref 与 production ref 一致。
- 使用 production 的专用 `batch_lab_source_login`，并完成真实连接负测。
- `BATCH_LAB_ALLOW_PRODUCTION_SOURCE=true` 只能在明确批准后开启。

### 5.3 CORS 双向对齐

两侧必须精确对应：

| 配置位置         | 变量                     | 值                           |
| ---------------- | ------------------------ | ---------------------------- |
| Vercel Batch Lab | `VITE_BATCH_LAB_API_URL` | Backend 公网 origin          |
| Railway Backend  | `BATCH_LAB_URL`          | Batch Lab Vercel 对外 origin |

常见错误：

- `BATCH_LAB_URL` 带路径，如 `/batch-lab`；应只填 origin。
- Vercel 使用新的自定义域名，但 Railway 仍保留旧 `vercel.app` origin。
- Preview 指向 production Backend，而 production Backend allowlist 的是 production Batch Lab origin。
- 只修改变量但没有重新部署 Vite，旧 API base 仍固化在 bundle 中。

## 6. 数据库前置条件

部署 SPA 前，目标环境必须完成 Batch Lab migrations 与 PostgREST 暴露验证。`packages/shared/migrations/` 是唯一 migration 来源，不得通过 Vercel 自动执行 migration。

至少核对：

1. `batch_lab` schema、表、RPC 和后续补丁 migration 已按账本应用。
2. PostgREST 暴露列表包含 `batch_lab`，且原有 schema 未被误删。
3. service-role 使用 `Accept-Profile: batch_lab` 可访问所需表和 RPC。
4. `anon` / `authenticated` 对 `batch_lab` 仍被拒绝。
5. `batch_lab_source_login` 已由人工启用 LOGIN，并只可读取 3 张来源表。
6. 写入、DDL、有副作用函数、序列调用均被拒绝。
7. statement timeout 为 5 秒，lock timeout 为 500ms。
8. 运行以下 Backend 安全验证：

```bash
pnpm --dir packages/backend batch-lab:verify-source
```

详细数据库操作顺序见 [`ops/batch-lab/README.md`](./README.md)。任一权限负测失败时，保持 `BATCH_LAB_ENABLED=false`。

## 7. 部署顺序

### 7.1 Test 首次部署

1. 确认 test migrations、PostgREST schema 暴露和 source role 权限已验证。
2. 在 Railway development Backend 注入 Batch Lab 变量，但先保持 `BATCH_LAB_ENABLED=false`。
3. 部署 Backend，检查 `/health` 正常，且无 source secret 输出到日志。
4. 创建 Vercel Project，Root Directory 设为 `packages/batch-lab`。
5. 配置 Preview/目标环境的 `VITE_BATCH_LAB_API_URL`。
6. 部署 Vercel，记录最终稳定 origin。
7. 将该 origin 写入 Railway Backend 的 `BATCH_LAB_URL` 并重新部署。
8. 在 Railway 开启 `BATCH_LAB_ENABLED=true`，重新部署 Backend。
9. 访问 Vercel 页面，确认环境 banner 显示 test，能力为可用。
10. 完成第 8 节 smoke test 后再把链接交给内部使用者。

### 7.2 后续发布

- Batch Lab 代码变更：Vercel 自动构建；若 shared contract 或 Backend 同时变化，先部署兼容 Backend，再发布 SPA。
- API base 变化：先保证新 Backend 可用并配置新 CORS，再修改 Vercel 变量和 redeploy。
- Vercel 域名变化：先在 Backend 增加/切换允许 origin，再切页面入口；当前只有单个 `BATCH_LAB_URL`，切换窗口需人工协调。
- 数据库 migration：先 test 单文件执行和验证，再部署依赖新 shape 的 Backend/SPA。

## 8. 验收清单

### 8.1 构建检查

本地或 CI 执行：

```bash
pnpm --filter @miniapp/batch-lab test
pnpm --filter @miniapp/batch-lab build
pnpm --filter @miniapp/backend typecheck
```

Vercel deployment log 应满足：

- 使用 Node 22 和 pnpm 9。
- `@miniapp/shared` 可正常解析。
- 输出目录为 `packages/batch-lab/dist` 对应的项目相对 `dist`。
- 未出现缺少 `VITE_BATCH_LAB_API_URL` 的运行时配置错误。

### 8.2 浏览器 smoke test

1. 打开根路径，页面正常加载。
2. 刷新任意 SPA 路径仍返回 `index.html`，不出现 Vercel 404。
3. `/api/batch-lab/context` 返回 200。
4. banner 中 Backend environment/source environment 符合目标环境。
5. SQL template、sample set、processor、experiment 列表可读取。
6. 完成一次 test SQL preview 和 freeze。
7. 创建并启动最小 A/B 实验。
8. 单条执行 worker，确认成功或可解释失败。
9. 测试 stop、软删除、annotation 和 JSONL 下载。
10. 刷新页面后实验状态可从 Backend 恢复。

### 8.3 安全负测

1. 从非 allowlist 浏览器 origin 调 Backend，应被 CORS 拒绝读取。
2. `anon/authenticated` 直接查询 `batch_lab` 应 permission denied。
3. source role 执行 INSERT/UPDATE/DELETE/DDL 应失败。
4. Vercel 构建产物和浏览器 Network 中不得出现数据库 URI、service-role 或模型 key。
5. Railway 日志不得输出完整 SQL 参数、prompt、raw output 或 secret。

> 注意：CORS 不是身份鉴权。当前 Batch Lab route 未形成完整的专用登录/token 边界；Vercel Deployment Protection 只能保护页面入口，不能阻止攻击者直接调用公网 Backend。正式开放 production 前，应另行补齐 Backend 内部身份鉴权、授权和 worker 限流。

## 9. Vercel 访问保护

由于 Batch Lab 是内部工具，建议开启 Vercel Deployment Protection：

- Preview：启用 Vercel Authentication 或团队访问保护。
- Production：若账号套餐支持，同样启用 Authentication；否则使用受控内部域名与上层访问控制。
- 不要把页面链接视为 secret，也不要仅依赖“域名不公开”。

Vercel 保护只覆盖 SPA。Backend 仍需自己的认证，不能把 `BATCH_LAB_URL` CORS allowlist 当成访问控制。

## 10. 监控与故障判断

| 现象                         | 优先检查                                                                 |
| ---------------------------- | ------------------------------------------------------------------------ |
| 首屏“无法确认运行环境”       | `VITE_BATCH_LAB_API_URL`、Backend `/context`、feature flag、source probe |
| 浏览器 CORS error            | Railway `BATCH_LAB_URL` 是否精确匹配当前页面 origin                      |
| `/context` 503 disabled      | `BATCH_LAB_ENABLED` 未开启                                               |
| `/context` 503 configuration | source URL、角色、project ref、TLS 或 migration 未就绪                   |
| preview 超时                 | source role timeout、SQL 复杂度、连接池和 Railway 日志                   |
| worker 配置错误              | `BATCH_LAB_MODEL_KEY`、targeted worker migration、provider URL           |
| 页面部署后仍请求旧 Backend   | Vite build-time 变量未触发 Redeploy                                      |
| 刷新页面 404                 | `vercel.json` rewrite 未生效或 Root Directory 配错                       |

排障时只记录 request ID、内部 ID、状态、耗时和错误类别，不复制数据库 URI、token、完整 SQL 参数或业务正文。

## 11. 回滚方案

### 11.1 应用回滚

1. 立即在 Railway 设置 `BATCH_LAB_ENABLED=false` 并重新部署/重启 Backend。
2. Vercel 回滚到上一成功 deployment，或临时关闭 Production Deployment。
3. 不删除 `batch_lab` 数据，不自动回滚已执行 migration。
4. 确认 worker 不再领取新 attempt；已领取任务按 lease 和现有状态机收口。

### 11.2 凭据泄漏

若怀疑 source URI 泄漏：

1. 立即将 `batch_lab_source_login` 改为 `NOLOGIN`。
2. 关闭 `BATCH_LAB_ENABLED`。
3. 轮换 source 密码并更新 Railway secret。
4. 重跑全部正/负权限测试后再恢复。

若怀疑 `BATCH_LAB_MODEL_KEY` 泄漏，立即在 provider 撤销/轮换，并检查异常调用量；不要只修改 Vercel 配置，因为该 key 不应存在于 Vercel。

## 12. 停止上线条件

出现以下任一情况，不得开放或继续使用：

- 页面指向了错误环境或 production Backend。
- Backend CORS 使用宽泛 origin，或当前 Vercel origin 未精确匹配。
- source role 不是 `batch_lab_source_login`。
- source 写入/DDL 负测未全部失败。
- `anon/authenticated` 可以读取 `batch_lab`。
- service-role、数据库 URI或模型 key 出现在浏览器 bundle/Network。
- worker 出现重复领取、无法 stop、无限重试或模型请求失控。
- production 尚未补内部身份鉴权和访问控制。
- migration、PostgREST 暴露或 targeted worker RPC 状态不确定。

## 13. 最终推荐配置摘要

### Vercel

```text
Project: st-batch-lab
Root Directory: packages/batch-lab
Framework: Other
Node.js: 22.x
Config: packages/batch-lab/vercel.json
Public env: VITE_BATCH_LAB_API_URL=https://<backend-origin>
Protection: Vercel Authentication（内部访问）
```

### Railway Backend（test）

```text
BATCH_LAB_ENABLED=true
BATCH_LAB_URL=https://<stable-batch-lab-test-origin>
BATCH_LAB_SAMPLE_SOURCE_ENV=test
BATCH_LAB_SOURCE_DATABASE_URL=<secret, read-only role>
BATCH_LAB_SOURCE_CONNECT_TIMEOUT_MS=3000
BATCH_LAB_SOURCE_MAX_CONNECTIONS=2
BATCH_LAB_MODEL_KEY=<secret>
```

正式 production 上线前，除替换为 production 环境外，还必须显式配置 `BATCH_LAB_ALLOW_PRODUCTION_SOURCE=true`，并完成 production 权限负测、内部身份鉴权和发布审批。
