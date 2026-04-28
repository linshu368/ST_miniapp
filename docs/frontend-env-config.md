# 前端联调 dev 后端 —— 环境配置约定

面向 PM 和开发双方的共同约定。一次性配齐后，PM 可在本地和 Vercel Preview 上独立联调 dev 后端，不需要每次打扰开发。

---

## 一、环境与职责划分

| 环境                        | 前端                                    | 后端             | 数据库 |
| --------------------------- | --------------------------------------- | ---------------- | ------ |
| 本地（PM）                  | `localhost:3000`（`pnpm dev:frontend`） | dev 后端固定 URL | dev    |
| Vercel Preview（PM 分支）   | 分支自动生成的 preview URL              | dev 后端固定 URL | dev    |
| Vercel Production（`main`） | 线上域名                                | prod 后端 URL    | prod   |

核心原则：**PM 分支的前端（不管本地还是 preview）都接 dev 后端，永远不碰 prod 数据。**

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
NEXT_PUBLIC_USE_MOCK=0
NEXT_PUBLIC_USE_MOCK_INIT_DATA=1
NEXT_PUBLIC_API_URL=https://stminiapp-development.up.railway.app
NEXT_PUBLIC_MOCK_TELEGRAM_ID=999000001
```

把 `NEXT_PUBLIC_MOCK_TELEGRAM_ID` 换成开发分配给你的那个 id（见第二节的分配表）。mock initData 的 user 字段由 `src/lib/telegram/auth.ts` 读此环境变量自动拼装，不用手改代码。

### `NEXT_PUBLIC_USE_MOCK` 什么时候开

`NEXT_PUBLIC_USE_MOCK=0` 是默认状态。按**模块粒度**走 mock / 真后端的判定由 `src/lib/api/mock-registry.ts` 决定——该文件由 Claude Code 在 PM bootstrap 阶段自动重算，规则见根 `CLAUDE.md` 的 Step 2c。

`USE_MOCK=1` 仅作为**全局应急强制开关**：想让所有模块都回到 mock（例如 dev 后端整个挂了、或专门测边界场景）时临时设置。

### Mock-Registry 自动同步机制（PM 专属）

- **真相源**：本地 committed 的 `packages/backend/src/` 代码——不看 dev 环境实际跑的什么版本
- **自动触发**：每次启动 Claude Code 新会话，bootstrap 的 Step 2c 会：
  1. 读 `mock-registry.config.ts` 取模块定义
  2. 扫 `packages/backend/src/app.ts` + `routes/*.ts` 提取已注册路由**以及每条路由紧邻上方的 `@frontend-ready` 注释**
  3. 按算法（`forceMockReason` 非空 > 缺 endpoints > 任一 endpoint 的 `@frontend-ready` 为 false / 缺失 > 同组成员 MOCK）计算每个模块状态
  4. 覆写 `mock-registry.ts`
  5. 在 bootstrap 回复里报告 diff（或「无变更」）
- **`@frontend-ready` 注释是后端 → 前端的状态单向通道**：开发在每条路由注册上方写 `// @frontend-ready: true` 或 `// @frontend-ready: false — <原因>`，handler 从半成品变完工时在**同一个 PR** 里改 `false → true`。PM 下次 bootstrap 自动感知并切换 mock / 真后端，**不需要开发和 PM 之间任何前置沟通**。
- **PM 加新功能的协作流程**：
  1. 改 `mock-registry.config.ts`（加 `MockModule` 成员和 `MODULE_CONFIG` 条目，填预期 endpoints，**不填 `forceMockReason`**）
  2. 写 `src/lib/mock-data/<module>.ts`（**id 字面量必须从 `packages/shared/src/dev-fixtures.ts` 引常量**，不得硬编码）
  3. 写 `src/lib/api/<module>.ts`（用 `shouldUseMock('<module>')` 分叉）
  4. 后端未实现时 → PM bootstrap 自动把新模块标为 MOCK（endpoints 在后端不存在，或 `@frontend-ready` 为 false / 缺失）
  5. 后端实现完 + 注释写 `@frontend-ready: true` + merge 到 `dev` 后，PM 下次 bootstrap 自动切到真后端
- **不执行同步的角色**：开发角色的 bootstrap 不执行 Step 2c。mock 层归 PM 管

### PM 禁区（开发前务必牢记）

完整版在根 `CLAUDE.md` 的「PM 禁区（强制）」，这里列最容易出错的三条：

- ❌ **跳过 bootstrap 直接开写**（包括"我只改一个文案"这种自认为的小改动）。正确动作：每次起新会话，等 Step 3 的 Mock-Registry Sync Diff 看完再动手
- ❌ **在 `src/lib/mock-data/` 里硬编码 character_id / session_id 字面量**。必须从 `packages/shared/src/dev-fixtures.ts` 引常量。这是 mock 与真后端 id 空间保持一致的关键
- ❌ **手改 `src/lib/api/mock-registry.ts`**（自动生成，下次 bootstrap 被覆盖）
- ⚠️ **`forceMockReason` 默认不用**——已由 `@frontend-ready` 机制取代。极个别临时 override 场景可用（用完立即清空）

---

## 四、Vercel Preview / Production 环境变量

在 Vercel Project Settings → Environment Variables 里，按三档分别配：

| 变量                             | Production（`main`） | Preview（所有 PM 分支） | Development（本地，不用配 Vercel） |
| -------------------------------- | -------------------- | ----------------------- | ---------------------------------- |
| `NEXT_PUBLIC_API_URL`            | prod 后端 URL        | dev 后端 URL            | —                                  |
| `NEXT_PUBLIC_USE_MOCK`           | `0`                  | `0`（默认）             | —                                  |
| `NEXT_PUBLIC_USE_MOCK_INIT_DATA` | 不设                 | 不设                    | —                                  |

Preview 环境不设 `USE_MOCK_INIT_DATA`：在 Telegram 测试 Bot 里打开 preview URL 时，Telegram 客户端会注入**真实 initData**，正常走 dev 后端验签即可，不经过 bypass。

### 新功能分支的特殊情况

如果某个分支的后端还没实现，该分支的 preview 接 dev 也拿不到数据。两种选择：

- **推荐**：shared 契约草案 + 后端实现 + 前端消费在同一 PR 内完成，合并后 preview 自然接通
- **临时**：在 Vercel Dashboard 为该分支把 `NEXT_PUBLIC_USE_MOCK` 覆盖为 `1`，preview 展示 UI + mock 形态；PR 描述注明「当前 preview 走 mock，后端实现中」

---

## 五、自查：我现在接的是哪个环境？

启动 `pnpm dev:frontend` 后在浏览器 DevTools → Network 里看请求 URL：

- 没有 API 请求 → `USE_MOCK=1`（全局）或该模块在 `mock-registry.ts` 的 `MOCK_MODULES` 里，走 mock
- 某些模块请求走 dev 域名、某些模块没请求 → 按模块粒度 mock / 真混合，属于正常情况（查 `mock-registry.ts` 顶部「逐模块解析」确认）
- `http://localhost:3001/...` → `API_URL` 未填或填错，打了不存在的本地后端
- `https://<dev 后端域名>/...` → 正确接上 dev 后端
- `https://<prod 域名>/...` → **警告，立即检查 `.env.local` 是否填错**
