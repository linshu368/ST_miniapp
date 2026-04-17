# ST MiniApp

> 一个基于 **Telegram Mini App** 形态的 AI 角色扮演应用 —— 用户在 Telegram 中打开，浏览角色列表并进入对话。

本仓库是一个 **pnpm monorepo**，同时包含前端（Next.js）、后端（Fastify）以及两端共享的 API 契约（TypeScript 类型）。数据存储在 Supabase，角色内容由外部流水线（见 `SillyTavern/scripts/publisher`）写入 `role_data` 表后，本应用只负责读取并展示。

---

## 目录

- [技术栈](#技术栈)
- [仓库结构](#仓库结构)
- [架构总览](#架构总览)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [API 契约](#api-契约)
- [数据源（Supabase）](#数据源supabase)
- [开发规范](#开发规范)
- [部署](#部署)
- [Roadmap](#roadmap)

---

## 技术栈

| 层 | 技术 | 版本 |
| --- | --- | --- |
| 前端 | Next.js（App Router） | ^14.2 |
| 前端 | React | ^18.3 |
| 前端 | Tailwind CSS | ^3.4 |
| 前端 | TypeScript | ^5.5 |
| 后端 | Fastify | ^5.2 |
| 后端 | @fastify/cors | ^10 |
| 后端 | @supabase/supabase-js | ^2.103 |
| 后端 | dotenv | ^16.4 |
| 后端运行时 | tsx（watch 模式） | ^4.19 |
| 共享包 | zod（预留用于 schema 校验） | ^3.23 |
| 包管理 | pnpm workspace | >= 9 |
| Node | | >= 20 |

---

## 仓库结构

```
ST_miniAPP/
├── package.json                # 根脚本：dev / dev:frontend / dev:backend
├── pnpm-workspace.yaml         # 声明 packages/* 为工作区
├── tsconfig.base.json          # 所有子包共享的 TS 基础配置（ES2022 / ESNext / strict）
├── .github/
│   └── CODEOWNERS              # 子包代码归属人
└── packages/
    ├── shared/                 # @miniapp/shared —— 前后端共享的 API 类型与工具
    │   └── src/
    │       ├── api/
    │       │   ├── envelope.ts     # ApiResponse / ApiSuccessResponse / ApiErrorResponse + ok() / fail()
    │       │   ├── characters.ts   # CharacterSummary / CharacterDetail + 两个接口响应体类型
    │       │   └── health.ts       # HealthData
    │       └── index.ts            # barrel export
    │
    ├── backend/                # @miniapp/backend —— Fastify API 服务
    │   ├── .env                    # PORT / FRONTEND_URL / SUPABASE_URL / SUPABASE_KEY
    │   └── src/
    │       ├── server.ts           # 入口：buildApp + listen
    │       ├── app.ts              # Fastify 实例、CORS、/health、路由注册
    │       ├── platform/
    │       │   └── config.ts       # 读取环境变量并冻结为 const
    │       ├── infrastructure/
    │       │   └── supabase/
    │       │       └── client.ts   # Supabase 单例客户端
    │       └── features/
    │           └── character/
    │               ├── character.routes.ts     # GET /api/characters、GET /api/characters/:id
    │               └── character.usecase.ts    # Supabase 查询（role_data 表）
    │
    └── frontend/               # @miniapp/frontend —— Next.js App Router 应用
        ├── .env.local              # NEXT_PUBLIC_API_URL
        ├── next.config.mjs         # transpilePackages: ['@miniapp/shared']
        ├── tailwind.config.ts
        ├── postcss.config.mjs
        └── src/
            ├── app/
            │   ├── layout.tsx          # 全局 layout（锁定缩放，适配移动端）
            │   ├── page.tsx            # 首页：角色列表 + 底部弹出详情
            │   └── globals.css         # Tailwind 三件套
            ├── components/
            │   ├── character-card.tsx          # 角色卡片
            │   └── character-detail-sheet.tsx  # 底部弹出详情
            ├── hooks/
            │   ├── use-characters.ts       # 列表数据 hook
            │   └── use-character-detail.ts # 详情数据 hook
            └── lib/
                ├── api/
                │   ├── client.ts           # fetch 包装：自动解 envelope
                │   └── characters.ts       # fetchCharacters / fetchCharacterById
                └── mock-data.ts            # 本地假数据（调试备用）
```

---

## 架构总览

```
┌──────────────────────────┐     HTTPS / JSON      ┌──────────────────────────┐
│   Next.js (frontend)     │  ───────────────────▶ │   Fastify (backend)      │
│   App Router · RSC off   │  ◀───────────────────  │   CORS / /health / /api  │
│   Tailwind · 移动端暗色  │                       │                          │
└────────────▲─────────────┘                       └────────────▲─────────────┘
             │                                                  │
             │  import type { ... } from '@miniapp/shared'      │  supabase-js
             │  (前后端共用同一份 TS 类型与 envelope 工具)      │
             │                                                  ▼
             │                                        ┌──────────────────┐
             │                                        │   Supabase       │
             └────────────────────────────────────────┤   role_data 表   │
                                                      └──────────────────┘
```

关键设计：

- **统一响应信封**：所有接口返回 `{ success, data }` 或 `{ success, error: { code, message } }`。前端的 `apiClient` 自动拆包、抛错，业务代码只拿到 `data`。
- **类型单一来源**：`@miniapp/shared` 导出所有接口 DTO，前后端同步升级。
- **轻架构分层**（后端）：`features/<domain>/*.routes.ts` ↔ `*.usecase.ts` ↔ `infrastructure/*`，避免把 Supabase 查询直接写在路由里。
- **移动端优先**：`layout.tsx` 锁 `maximumScale=1 / userScalable=false`，全局暗色背景，为嵌入 Telegram WebView 做准备。

---

## 快速开始

### 前置要求

- Node.js **>= 20**
- pnpm **>= 9**
- 一个可用的 Supabase 项目，并按下方 [环境变量](#环境变量) 节配置好 `.env`

### 安装

```bash
# 在仓库根目录
pnpm install
```

### 本地开发（前后端并行）

```bash
# 仓库根目录
pnpm dev
```

这会并行启动：

- `@miniapp/backend` → `http://localhost:3001`（`tsx watch`，保存即重载）
- `@miniapp/frontend` → `http://localhost:3000`（`next dev`）

也可以单独启动：

```bash
pnpm dev:frontend
pnpm dev:backend
```

### 验证

```bash
curl http://localhost:3001/health
# => {"success":true,"data":{"status":"ok","timestamp":"..."}}

curl http://localhost:3001/api/characters
# => {"success":true,"data":{"characters":[...]}}
```

浏览器访问 `http://localhost:3000` 即可看到角色列表，点击卡片底部弹出详情。

### 类型检查

```bash
pnpm --filter @miniapp/backend  typecheck
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/shared   typecheck
```

---

## 环境变量

`.env` / `.env.local` 文件已在 `.gitignore` 中全局屏蔽（规则 `.env.*`），**绝不会提交进仓库**。克隆后请参照各包的 `.env.example` 复制并填写真实值。

```bash
cp packages/backend/.env.example  packages/backend/.env
cp packages/frontend/.env.example packages/frontend/.env.local
```

### Backend (`packages/backend/.env`)

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 监听端口 | `3001` |
| `FRONTEND_URL` | 允许跨域的前端地址（精确匹配） | `http://localhost:3000` |
| `NODE_ENV` | 环境 | `development` |
| `SUPABASE_URL` | Supabase 项目 URL | —（必填） |
| `SUPABASE_KEY` | Supabase API key（只读用 anon key，写操作用 service_role key） | —（必填） |

> CORS 规则（见 `src/app.ts`）：放行 `FRONTEND_URL`、所有 `*.vercel.app`、所有 `http://localhost:*`，以及无 `Origin` 的请求；其余拒绝。

### Frontend (`packages/frontend/.env.local`)

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | 后端 API 基地址 | `http://localhost:3001` |

---

## API 契约

所有接口都返回统一的 envelope：

```ts
type ApiResponse<T> =
  | { success: true;  data: T }
  | { success: false; error: { code: string; message: string } };
```

### `GET /health`

健康检查，返回：

```json
{ "success": true, "data": { "status": "ok", "timestamp": "2026-04-17T..." } }
```

### `GET /api/characters`

角色列表（按 `created_at` 倒序）。

```ts
// @miniapp/shared → GetCharactersData
{
  characters: Array<{
    id: string;
    name: string;
    description: string;
    avatar: string;
    tags: string[];
  }>;
}
```

### `GET /api/characters/:id`

> 注意：路径参数 `:id` 实际匹配的是 Supabase `role_data.role_id` 字段（由外部发布流水线生成的业务 ID），而非自增主键。

```ts
// @miniapp/shared → GetCharacterByIdData
{
  character: {
    id: string;
    name: string;
    description: string;
    avatar: string;
    tags: string[];
    first_mes: string;
    creator_notes: string;
  };
}
```

未找到时返回 `404` + `{ success: false, error: { code: 'NOT_FOUND', message: 'Character not found' } }`。

---

## 数据源（Supabase）

当前仅读取一张表：

### `role_data`

| 字段 | 用途 |
| --- | --- |
| `id` | Supabase 主键（前端作为 React key 使用） |
| `role_id` | 业务 ID，路由 `:id` 匹配此列 |
| `name` | 角色名 |
| `description` | 简介 |
| `avatar` | 头像（当前前端未使用图片，回退首字母占位） |
| `tags` | 字符串数组 |
| `first_mes` | 开场白（详情页展示） |
| `creator_notes` | 作者备注 |
| `created_at` | 排序依据 |

> 该表的数据由仓库外部的发布脚本写入，例如 `python_project/SillyTavern/scripts/publisher/step3/run_role_publisher.py`。本应用**只读**。

---

## 开发规范

1. **所有接口 DTO 必须放在 `@miniapp/shared`**，前后端只引用不重复定义。
2. **后端业务逻辑不写在路由里**：路由只做参数解析与状态码，真正的逻辑放到 `features/<domain>/*.usecase.ts`；所有第三方 SDK（Supabase 等）封装在 `infrastructure/` 下，避免被业务层直接耦合。
3. **Next.js 编译共享包**：通过 `next.config.mjs` 的 `transpilePackages: ['@miniapp/shared']` 直接消费 TS 源码，避免预构建。
4. **TS 配置统一继承 `tsconfig.base.json`**（`strict: true`、`ESNext` 模块、`bundler` 解析）。
5. **代码归属**（见 `.github/CODEOWNERS`）：
   - `packages/frontend/` → `@jason`
   - `packages/backend/`  → `@linshu`
   - `packages/shared/`   → `@jason @linshu`（改动需双方评审）

---

## 部署

目前代码中可观察到的部署约定：

- **后端**：监听 `0.0.0.0`，注释明确指向 Railway。部署时需要注入 `PORT`（Railway 自动）、`SUPABASE_URL`、`SUPABASE_KEY`、`FRONTEND_URL`。
- **前端**：CORS 默认放行任意 `*.vercel.app` 子域，包含 Preview URL —— 即**默认部署目标是 Vercel**。部署时配置 `NEXT_PUBLIC_API_URL` 指向后端地址。

建议的生产流水线：

```
GitHub push
   ├─▶ Vercel  (packages/frontend)  ← NEXT_PUBLIC_API_URL=https://<backend>
   └─▶ Railway (packages/backend)   ← SUPABASE_* / FRONTEND_URL=https://<frontend>
```

---

## Roadmap

从代码中的 TODO / 预留接口可以看出下一步计划：

- [ ] 接入 **Telegram WebApp initData** 鉴权：`packages/frontend/src/lib/api/client.ts` 已预留 `X-Init-Data` header 位置；后端需新增中间件校验 HMAC 并从 initData 还原用户信息。
- [ ] 对话页：`page.tsx` 中的 `onStartChat` 当前只打印日志，等待接入。
- [ ] 角色头像真正渲染图片（目前用首字母占位，`avatar` 字段虽已从 DB 读出但未使用）。
- [ ] 引入 `zod` 对后端入参做 schema 校验（依赖已装，尚未使用）。
- [ ] 错误处理统一化：目前 `character.usecase.ts` 中 Supabase 出错直接 `throw`，建议改为返回 `fail(code, message)` 的 envelope。
