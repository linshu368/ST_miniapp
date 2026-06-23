# 前端联调 dev 后端 —— 环境配置约定

面向 PM 和开发双方的共同约定。一次性配齐后，PM 可在本地和 Vercel Preview 上独立联调 dev 后端，不需要每次打扰开发。

---

## 一、环境与职责划分

| 环境                        | 前端                                    | 后端             | 数据库               |
| --------------------------- | --------------------------------------- | ---------------- | -------------------- |
| 本地（PM）                  | `localhost:3000`（`pnpm dev:frontend`） | dev 后端固定 URL | Supabase `test` 分支 |
| Vercel Preview（PM 分支）   | 分支自动生成的 preview URL              | dev 后端固定 URL | Supabase `test` 分支 |
| Vercel Production（`main`） | 线上域名                                | prod 后端 URL    | Supabase `main` 主库 |

核心原则：**PM 分支的前端（不管本地还是 preview）都接 dev 后端，永远不碰 prod 数据。**

当前 Supabase 分支约定：

| 用途 | Supabase branch | project ref            |
| ---- | --------------- | ---------------------- |
| 生产 | `main`          | `wbtsfzozlmurljvglhpn` |
| 测试 | `testdb`        | `zoqelpfhurwehlvypryl` |

后端和 sync-engine 都必须配置 `DATABASE_ENV`，并分别准备 `TEST_*` / `PROD_*` 数据库变量组。启动时会按当前环境自动选择对应变量组：`DATABASE_ENV=test` 或 `development` 使用 `zoqelpfhurwehlvypryl`；`DATABASE_ENV=production` 使用 `wbtsfzozlmurljvglhpn`。如果实际解析出的 project ref 与目标环境不一致，服务会在启动阶段失败。非 production 环境默认禁止连接生产 project ref，除非临时人工操作显式设置 `ALLOW_PROD_DATABASE=1`。

---

## 二、开发侧：一次性配置

### 1. 稳定的 dev 后端公网 URL

Railway 上 dev service 的固定域名（不是临时预览域名），PM 填进 `NEXT_PUBLIC_API_URL`。

**当前固定 URL**：`https://stminiapp-development.up.railway.app`

### 2. CORS 白名单加入本地源

dev 后端 CORS 允许：

- `http://localhost:3000`
- （可选）本机局域网 IP，真机调试用，例如 `http://192.168.x.x:3000`
- Vercel preview 域名通配（例如 `*.vercel.app` 或项目对应的 preview 域名规则）

### 3. dev 环境常驻的 initData 验签 bypass

加一个环境变量开关，**仅 dev 环境生效，prod 永远不设**：

```
DEV_AUTH_BYPASS=1
```

鉴权中间件逻辑建议：

```
if (NODE_ENV !== 'production' && DEV_AUTH_BYPASS === '1') {
  // 收到 mock initData（hash=mock_hash 或其他约定标识）时：
  //   - 跳过 hash 验签
  //   - 按 initData 里的 user.id 映射到对应测试用户
}
```

**双重保险**：同时判断 `NODE_ENV !== 'production'` 和 `DEV_AUTH_BYPASS === '1'`，代码层面确保不可能在 prod 生效。

### 4. 给每个 PM 分配独立测试用户

为避免多个 PM 并行调试时数据互相覆盖，为每个 PM 分配一个专属 `telegram_id`，在 dev 数据库里建好对应测试用户。PM 各自在本地 `.env.local` 的 `NEXT_PUBLIC_MOCK_TELEGRAM_ID` 里填自己的 id。

**已分配的测试 telegram_id**：

| telegram_id | 用途            |
| ----------- | --------------- |
| `999000001` | PM-1            |
| `999000002` | PM-2            |
| `999000003` | 机动 / 开发联调 |

### 交付物（已完成）

1. ✅ dev 后端固定 URL：`https://stminiapp-development.up.railway.app`
2. ✅ 测试 `telegram_id`：`999000001` / `999000002` / `999000003`
3. ✅ CORS 和 `DEV_AUTH_BYPASS` 已在 Railway dev 环境生效

---

## 三、PM 侧：本地配置

`packages/frontend/.env.local`（本地文件，不入 git）：

```
NEXT_PUBLIC_USE_MOCK_INIT_DATA=1
NEXT_PUBLIC_API_URL=https://stminiapp-development.up.railway.app
NEXT_PUBLIC_MOCK_USER_ID=999000001
```

把 `NEXT_PUBLIC_MOCK_USER_ID` 换成开发分配给你的那个 id（见第二节的分配表）。`NEXT_PUBLIC_USE_MOCK_INIT_DATA=1` 只用于本地没有 Telegram 容器时生成 `X-Init-Data`，需要后端同时开启 `MOCK_AUTH=1` 或 `DEV_AUTH_BYPASS=1` 才能通过鉴权。

### 不再使用业务 mock

前端业务请求统一走真实后端，不再保留 `NEXT_PUBLIC_USE_MOCK`、`mock-registry.ts`、`mock-registry.config.ts` 或 `src/lib/mock-data/`。

新增功能的协作规则改为：

1. 先定义 shared 契约。
2. 后端实现真实 route，并在 `app.ts` 注册。
3. 前端在 `src/lib/api/` 写 React Query hook，直接请求真实 API。
4. 本地开发如果没有 Telegram 环境，只使用 `NEXT_PUBLIC_USE_MOCK_INIT_DATA` + 后端鉴权 bypass 解决身份问题，不用业务 mock 数据。

---

## 四、Vercel Preview / Production 环境变量

在 Vercel Project Settings → Environment Variables 里，按三档分别配：

| 变量                             | Production（`main`） | Preview（所有 PM 分支） | Development（本地，不用配 Vercel） |
| -------------------------------- | -------------------- | ----------------------- | ---------------------------------- |
| `NEXT_PUBLIC_API_URL`            | prod 后端 URL        | dev 后端 URL            | —                                  |
| `NEXT_PUBLIC_USE_MOCK_INIT_DATA` | 不设                 | 不设                    | —                                  |

Preview 环境不设 `NEXT_PUBLIC_USE_MOCK_INIT_DATA`：在 Telegram 测试 Bot 里打开 preview URL 时，Telegram 客户端会注入**真实 initData**，正常走 dev 后端验签即可，不经过 bypass。

### 新功能分支的特殊情况

如果某个分支的后端还没实现，该分支的 preview 接 dev 也拿不到数据。现在不再用业务 mock 兜底，应把 shared 契约、后端实现和前端消费放在同一组变更里完成，或在页面上展示真实错误/空状态。

---

## 五、自查：我现在接的是哪个环境？

启动 `pnpm dev:frontend` 后在浏览器 DevTools → Network 里看请求 URL：

- 没有 API 请求 → 当前页面还没触发数据查询，或代码没有接真实 API
- `http://localhost:3001/...` → `API_URL` 未填或填错，打了不存在的本地后端
- `https://<dev 后端域名>/...` → 正确接上 dev 后端
- `https://<prod 域名>/...` → **警告，立即检查 `.env.local` 是否填错**
