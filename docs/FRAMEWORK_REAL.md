# FRAMEWORK_REAL — ST_miniAPP 真实框架文档

> **文档性质**：基于仓库现状（2026-06-19 扫描）与设计稿 `项目框架草稿.md` 的对照梳理。  
> **阶段定位**：阶段一已部分落地；阶段二目标为 iframe 集成 + 平台化（对话、切角色、切模型等级、侧边栏历史）。  
> **约束**：本文不修改代码；偏差处给出推荐与理由，最终决策由你拍板。  
> **外部依赖**：ST 源码位于仓库外 `SillyTavern-latest`，尚未 vendoring 进本仓库（用户确认）。

---

## §A. 真实架构总览（基于现状 + 阶段二演进方向）

### A.1 当前可运行拓扑（阶段一实际）

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  用户 (Telegram WebView)                                                 │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  packages/frontend (Next.js 14, :3000)                            │  │
│  │  ├─ 大厅 / 自研聊天 UI / 个人中心 / 支付页（mock 为主）              │  │
│  │  ├─ lib/api/* → HTTP → backend                                    │  │
│  │  └─ ❌ 无 ST iframe、无 lib/bridge/、无 postMessage                 │  │
│  └────────────────────────────┬──────────────────────────────────────┘  │
└───────────────────────────────┼──────────────────────────────────────────┘
                                │ HTTPS (NEXT_PUBLIC_API_URL → :3001)
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  packages/backend (Fastify 5, :3001)                                     │
│  ├─ 鉴权桥 POST /api/bridge/st-session (TG InitData → ST cookie)        │
│  ├─ ST 反向代理 /api/bridge/st/* → ST_BASE_URL (默认 :8000)              │
│  ├─ 业务 REST /api/characters, /api/sessions/* (Prisma + 自研 LLM SSE)  │
│  ├─ Prisma → DATABASE_URL (postgres, miniapp + public schema)           │
│  └─ Supabase service_role → users.st_handle / st_initialized_at         │
└───────────────┬──────────────────────────────┬─────────────────────────┘
                │ HTTP (ST_PROVISION_URL)         │ 需外部 ST 进程
                ▼                                 ▼
┌───────────────────────────────┐    ┌────────────────────────────────────┐
│  packages/sync-engine         │    │  SillyTavern-latest（仓库外）       │
│  ├─ bridge-api (:9091)        │───►│  默认 ST_BASE_URL :8000            │
│  ├─ provisioner (CLI/HTTP)    │写入│  ❌ 未 vendoring                   │
│  ├─ watcher (chokidar)        │◄───│  ❌ 无 st-extension 注入            │
│  └─ health (:9090)            │    └────────────────────────────────────┘
└───────────────┬───────────────┘
                │ supabase-js (service_role)
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Supabase (PostgreSQL)                                                   │
│  ├─ public.*     遗留 bot/支付表 + users (st_handle, st_initialized_at)  │
│  ├─ miniapp.*    角色卡池、runtime_config、miniapp_user_settings 等平台业务 │
│  ├─ st_platform.* / st_users.* / st_infra.*  同步层（SQL 迁移已编写）    │
│  └─ ❌ 无 db-types 生成物；❌ 无 Storage 集成代码（迁移层有设计意图）     │
└──────────────────────────────────────────────────────────────────────────┘

根 pnpm dev：仅并行 frontend + backend（package.json L7）
❌ 无 nginx、无 turbo、无 vendor/sillytavern、无 CI typecheck 流水线
```

### A.2 阶段二目标拓扑（设计方向，**大部分尚未编码**）

阶段二核心变化：frontend 持久挂载 ST iframe（经 backend 鉴权桥 + 反向代理），通过 **Bridge Protocol**（postMessage）调用 ST 原生能力；侧边栏历史等 UI 由平台壳承载，对话主体在 iframe 内。

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  frontend                                                                │
│  ├─ 平台壳 UI（大厅、侧边栏、模型等级切换控件）                           │
│  ├─ 持久 ST iframe (src=/api/bridge/st/...)  ← 阶段二新增               │
│  ├─ lib/bridge/ bridge-client  ← 阶段二新增                              │
│  └─ HTTP → backend（鉴权、角色卡元数据、provision 状态查询等）            │
└────────────────────────────┬────────────────────────────────────────────┘
                             │ postMessage (miniapp-bridge channel)
                             ▼
                    [ ST iframe 内 st-extension IIFE ]  ← 阶段二新增
                             │
┌────────────────────────────┴────────────────────────────────────────────┐
│  backend + sync-engine + vendor/sillytavern（待 vendoring）              │
│  鉴权桥 / ST 代理 / provision-api / watcher / LLM 代理（后两者待建）      │
└─────────────────────────────────────────────────────────────────────────┘
```

**阶段二 MVP 功能与通道映射（目标，非现状）**

| MVP 功能            | 预期通道                                       | 现状                                                     |
| ------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| 对话（ST 原生生成） | iframe 内 ST UI + Bridge 事件同步状态          | ❌ 自研 `MessageList` + backend SSE LLM                  |
| 切换角色            | Bridge action `selectCharacter` 等             | ❌ 无 Bridge                                             |
| 切换模型等级        | Bridge action `setModelTier` 或 settings patch | ⚠️ backend 有 `ModelTier` 但仅服务自研聊天               |
| 侧边栏历史聊天      | Bridge mirror state + ST 事件 / 或 HTTP 查镜像 | 读 `st_users.user_st_chats`，不再依赖自研 `app_sessions` |

参考：`docs/主题 4 _Bridge Protocol 与 bridge-client _ st-extension 规约.md` §6.1 mirror state 最小集；§3 三段握手。

### A.3 架构纪律（设计目标 vs 现状）

| 纪律                              | 设计稿                                    | 现状                                       |
| --------------------------------- | ----------------------------------------- | ------------------------------------------ |
| 跨进程通信走契约层包              | bridge-protocol / api-contract / db-types | ⚠️ 契约落在 `@miniapp/shared`              |
| 应用包互不 import                 | 强制                                      | ✅ 四包无交叉 import                       |
| DB 类型不进前端                   | db-types 仅服务端                         | ✅ frontend 无 Prisma/db-types             |
| Bridge 不走业务组件直 postMessage | bridge-client 统一入口                    | ❌ bridge-client 不存在                    |
| 环境变量 zod 校验                 | 各进程 env.ts                             | ⚠️ sync-engine 有；backend/frontend 部分有 |

---

## §B. 真实包清单（对照 `项目框架草稿.md` §B）

### B.1 运行时进程清单

| #   | 运行时                    | 实现包                          | 现状入口                                        | 端口/形态                   | 对照设计稿                               |
| --- | ------------------------- | ------------------------------- | ----------------------------------------------- | --------------------------- | ---------------------------------------- |
| 1   | 平台前端                  | `packages/frontend`             | `next dev --port 3000`                          | dev :3000                   | ⚠️ 设计稿写 :3001                        |
| 2   | miniapp 后端              | `packages/backend`              | `tsx watch src/server.ts`                       | 默认 :3001 (`PORT`)         | ⚠️ 设计稿写 :3000                        |
| 3   | sync-engine HTTP          | `packages/sync-engine`          | `pnpm bridge-api` → `tsx src/bridge-api/run.ts` | `BRIDGE_API_PORT` 默认 9091 | ⚠️ 设计稿名 `start:provision`、端口 3002 |
| 4   | sync-engine watcher       | `packages/sync-engine`          | `pnpm watch` → `tsx src/watcher/run.ts`         | 无对外业务端口；health 9090 | ✅ 职责一致                              |
| 5   | sync-engine CLI provision | `packages/sync-engine`          | `pnpm provision --user-id=...`                  | 一次性 CLI                  | 🆕 设计稿未单列 CLI                      |
| 6   | sync-engine health        | `packages/sync-engine`          | watcher 内嵌启动                                | `HEALTH_PORT` 默认 9090     | 🆕 设计稿未写                            |
| 7   | ST 服务                   | **仓库外** `SillyTavern-latest` | 未集成                                          | 默认 :8000                  | ❌ 无 `vendor/sillytavern`               |
| 8   | Nginx                     | `ops/nginx`                     | 不存在                                          | —                           | ❌                                       |
| —   | Supabase                  | 托管                            | 经 env 连接                                     | —                           | ✅                                       |

根脚本仅编排 frontend + backend：

```7:7:ST_miniAPP/package.json
    "dev": "pnpm run --parallel dev:frontend dev:backend",
```

sync-engine 脚本（注意命名与 design 差异）：

```6:10:ST_miniAPP/packages/sync-engine/package.json
    "registry": "tsx src/registry/index.ts",
    "provision": "tsx src/provisioner/run.ts",
    "watch": "tsx src/watcher/run.ts",
    "bridge-api": "tsx src/bridge-api/run.ts",
```

### B.2 包清单（实际 4 包 + 设计目标 8 包）

| 包                        | 现状                                | 设计稿                                 | 标记                         |
| ------------------------- | ----------------------------------- | -------------------------------------- | ---------------------------- |
| `@miniapp/frontend`       | Next.js 14 应用                     | 同                                     | ✅ 存在；⚠️ 缺 bridge/iframe |
| `@miniapp/backend`        | Fastify 5 应用                      | 同                                     | ✅ 存在；⚠️ 结构与设计不同   |
| `@miniapp/sync-engine`    | 双进程 + CLI + health               | 同                                     | ✅ 核心已落地                |
| `@miniapp/shared`         | API envelope + 部分契约 + st handle | 部分 shared 职责 + **兼 api-contract** | ⚠️ 职责合并                  |
| `bridge-protocol`         | 不存在                              | 纯 postMessage 契约 ESM                | ❌ 阶段二待建                |
| `api-contract`            | 不存在（合入 shared）               | REST Zod 契约                          | ❌ / ⚠️                      |
| `db-types`                | 不存在（Prisma schema 代替）        | Supabase 生成类型                      | ❌                           |
| `st-extension`            | 不存在                              | IIFE 注入 ST                           | ❌ 阶段二待建                |
| `vendor/sillytavern`      | 不存在                              | vendored ST                            | ❌ 待 vendoring              |
| `ops/nginx`, `ops/docker` | 不存在（仅 `ops/git/`）             | 部署基础设施                           | ❌                           |
| `platform-assets/`        | **仍存在**                          | 决议砍掉                               | ⚠️ 与设计冲突                |

### B.3 跨包依赖（package.json 实际）

```text
frontend  → @miniapp/shared
backend   → @miniapp/shared, @prisma/client, @supabase/supabase-js, fastify
sync-engine → @supabase/supabase-js, chokidar, zod, pino（无 @miniapp/shared）
shared    → zod
```

与设计稿差异：

- ⚠️ `sync-engine` 未依赖 `shared` / `db-types`（自包含类型与 Supabase 客户端）
- ⚠️ `backend` 用 **Prisma** 而非 `db-types` 作为 DB 类型源
- ❌ 无 `bridge-protocol` 供 frontend / st-extension 共享

---

## §C. 真实目录结构（对照 §C）

### C.1 仓库根（实际）

```text
ST_miniAPP/
├── .github/workflows/          pr-review.yml only（无 ci.yml / deploy）
├── .husky/
├── docs/                       11 个 md（含本文件、决议、阶段一文档）
├── ops/git/                    代码审查脚本（非 nginx/docker）
├── packages/
│   ├── backend/
│   ├── frontend/
│   ├── shared/                 含 migrations/（Supabase SQL）
│   └── sync-engine/
├── platform-assets/characters/ ⚠️ 决议要求删除，仍存在
├── node_modules/
├── package.json                pnpm workspace 根
├── pnpm-workspace.yaml         packages/*
├── pnpm-lock.yaml
├── tsconfig.base.json
└── ❌ 无 vendor/, turbo.json, .env.example, pnpm-workspace 外的 ADR 目录
```

### C.2 packages/backend（实际）

```text
packages/backend/
├── prisma/
│   ├── schema.prisma           miniapp + public 多 schema
│   ├── migrations/             4 个 Prisma 迁移
│   └── seed.ts
├── src/
│   ├── server.ts               入口
│   ├── app.ts                  Fastify 组装
│   ├── platform/config.ts      环境变量（无 zod）
│   ├── routes/
│   │   ├── bridge.ts           鉴权桥
│   │   ├── characters.ts
│   │   └── sessions.ts         含自研 SSE 聊天
│   ├── middleware/
│   │   ├── auth.ts
│   │   └── stProxy.ts          ST 反向代理
│   ├── services/RuntimeConfigService.ts
│   ├── ai/                     自研 LLM 通道（PipelineChannel）
│   ├── infrastructure/redis/   Upstash 配置存储
│   ├── lib/                    db, supabase, user
│   └── scripts/seed-config.ts
└── test/
```

阶段二预计新增（设计稿，**未存在**）：`routes/llm-proxy/`, `routes/provision-status/`, `env.ts`（zod）, `services/provision-client.ts`

### C.3 packages/frontend（实际）

```text
packages/frontend/src/
├── app/
│   ├── layout.tsx              无 iframe Provider
│   ├── (main)/                 大厅、个人中心、支付、创建页
│   └── chat/[sessionId]/       自研聊天页（非 ST iframe）
├── components/                 ui, characters, chat, payment, nav
├── lib/
│   ├── api/                    React Query + mock-registry
│   ├── telegram/
│   ├── markdown/               自研消息渲染
│   └── mock-data/
├── stores/                     ui, theme, user-profile（无 st-mirror）
└── ❌ 无 lib/bridge/
```

`frontend/CLAUDE.md` 已描述阶段二 iframe 规则，但源码未实现（见 §D.5）。

### C.4 packages/sync-engine（实际）

```text
packages/sync-engine/src/
├── bridge-api/                 HTTP :9091（provision 触发）
├── provisioner/                下行物化
├── watcher/                    上行 chokidar
├── queue/                      任务队列（含 metrics）
├── registry/                   rules 加载与校验
├── health/                     :9090 健康检查
└── lib/                        config(zod), supabase, st-fs, logger
```

与设计稿路径差异：设计写 `provision/run.ts` + `watcher/run.ts`；实际为 `provisioner/run.ts`、`bridge-api/run.ts`。

### C.5 packages/shared（实际）

```text
packages/shared/
├── src/
│   ├── api/                    envelope, characters, chat, health, payment
│   ├── st-bridge/handle.ts     deriveStHandle（非 postMessage 协议）
│   └── dev-fixtures.ts
├── migrations/                 001–013 Supabase SQL
└── scripts/                    （存在，未在本次扫描中逐项确认）
```

### C.6 阶段二待新增目录（设计目标，当前不存在）

| 路径                                       | 用途                                      |
| ------------------------------------------ | ----------------------------------------- |
| `vendor/sillytavern/`                      | vendored ST（从 SillyTavern-latest 拷贝） |
| `packages/bridge-protocol/`                | postMessage 契约                          |
| `packages/st-extension/`                   | IIFE + tsup                               |
| `packages/frontend/src/lib/bridge/`        | bridge-client                             |
| `packages/frontend/src/components/bridge/` | iframe 宿主                               |
| `ops/nginx/`, `ops/docker/`                | 统一部署入口                              |

---

## §D. 各包真实状态（现状 / 差异 / 建议）

### D.1 `@miniapp/shared`

**现状**

- 导出 API 信封 `ok()` / `fail()` 及 characters、chat、health、payment 类型（`src/index.ts` L1–12）
- `st-bridge/handle.ts`：TG ID ↔ ST handle 派生（`deriveStHandle`），供鉴权桥与 sync-engine 共用
- `migrations/`：13 个 Supabase SQL 文件，定义 `st_platform` / `st_users` / `st_infra` 同步层
- 无 IO、无运行时副作用（符合 shared 定位）

**差异**

| 项                                   | 标记 | 说明                                                 |
| ------------------------------------ | ---- | ---------------------------------------------------- |
| 兼 api-contract 职责                 | ⚠️   | 设计稿要求独立 `api-contract` 且禁止 import db-types |
| 含 payment 契约但 backend 无支付路由 | 🆕   | `api/payment.ts` + frontend 支付页，backend 未实现   |
| migrations 放在 shared 而非 ops/seed | 🆕   | 合理扩展，但与设计目录不同                           |
| 无 bridge-protocol 内容              | ❌   | postMessage 契约尚未抽离                             |

**建议**

- **api-contract**：**阶段二再拆** — 当前契约量小，拆包增加迁移成本；待 Bridge actions 稳定后再拆（理由：减少阶段二并行改动面）
- **migrations 位置**：**保留现状** — 与 sync-engine 同仓库、版本对齐方便；在文档中正式标注为「Supabase schema 源码」
- **bridge-protocol**：**立即补**（阶段二编码前）— postMessage 是架构主轴，不宜继续堆在 shared

---

### D.2 `@miniapp/backend`

**现状**

- **框架**：Fastify 5（`package.json` L17），入口 `src/server.ts`
- **鉴权桥**：`POST /api/bridge/st-session`，TG InitData → Prisma user → Supabase `st_handle` → 调 sync-engine provision → ST login → 返回 `st_url` + cookie（`routes/bridge.ts`）
- **ST 代理**：`ALL /api/bridge/st/*` 透明转发（`middleware/stProxy.ts` L11–14 注释已预留 iframe 路径）
- **业务 API**：角色卡只读；sessions CRUD + **自研 SSE 聊天**（调 `ChannelRegistry` LLM，非 ST）
- **数据**：Prisma 主路径 + Supabase service_role 写 `users.st_handle`（`lib/user.ts` L6–13 注释）
- **配置**：`platform/config.ts` 读 env，**无 zod fail-fast**

**差异**

| 项                                      | 标记 |
| --------------------------------------- | ---- |
| 无 `llm-proxy`、`provision-status` 路由 | ❌   |
| 无 `api-contract` 入口 zod 校验中间件   | ❌   |
| 使用 Prisma 而非 db-types               | ⚠️   |
| `ai/` 模块为阶段一自研聊天              | 🆕   |
| Upstash Redis 运行时配置                | 🆕   |
| 端口 3001 vs 设计 3000                  | ⚠️   |

**建议**

- **Fastify 选型**：**保留现状** — 已落地，zod 可后补插件
- **Prisma vs db-types**：**暂保留 Prisma** — miniapp 业务表已建模；同步层表由 sync-engine 直读 Supabase。**阶段二再评估**是否对 `st_*` schema 生成 db-types 供 sync-engine 专用
- **自研 `ai/` 模块**：**暂保留观察** — 阶段二 iframe 上线后，若聊天全交 ST，该模块可标记 deprecated；若需混合模式则保留
- **llm-proxy**：**阶段二再补**（P0 设计项）— ST 需指向平台代理 endpoint；可与 iframe 并行开发
- **env zod**：**阶段二再补** — 与 nginx 统一部署前统一校验

---

### D.3 `@miniapp/sync-engine`

**现状**

- **bridge-api**（`bridge-api/server.ts` L5–11）：`POST /provision/:userId`（202 异步）、`POST /provision/:userId/sync`（200 同步）、`GET /health`；绑定 `127.0.0.1`
- **provisioner**：拉 Supabase → ensureStUser → 写角色卡/预设/settings/secrets → 更新 `st_initialized_at`（`provisioner/index.ts` L7–14）
- **watcher**：chokidar 监听 ST 文件系统回流（`watcher/run.ts`）
- **queue + registry + health**：超出设计稿最小描述，已具备任务队列与规则注册表
- **config**：`lib/config.ts` 完整 zod 校验（L12–50）
- **测试**：vitest 覆盖 provisioner、watcher、queue、registry

**差异**

| 项                                                              | 标记         |
| --------------------------------------------------------------- | ------------ |
| 进程名 `bridge-api` vs 决议 `provision-api` / `start:provision` | ⚠️           |
| 无 provision 状态查询、flush、Realtime 订阅                     | ❌ 阶段二 P0 |
| 无 `@miniapp/shared` 依赖                                       | ⚠️           |
| `ST_PLATFORM_ASSETS_PATH` env 仍引用 platform-assets 概念       | ⚠️           |

**建议**

- **bridge-api 命名**：**改成设计稿**（`start:provision`）— 与主题 4 术语一致，减少「鉴权桥 / bridge-api / bridge-protocol」混淆；**或调整设计稿**保留 `bridge-api` 若团队已口头习惯
- **阶段二改造项**：按 `已决议内容汇总.md` §3.10 逐项排期；现状仅覆盖阶段一最小 provision + watch
- **shared 依赖**：**暂不需要** — sync-engine 边界清晰，不强引 shared

---

### D.4 `@miniapp/frontend`

**现状**

- Next.js 14 App Router；大厅 `CharacterGallery`；聊天页完整自研 UI（`MessageList`, `Composer`, `ChatSidebar`）
- API 经 `lib/api/client.ts`，默认 `NEXT_PUBLIC_API_URL` → `http://localhost:3001`
- Mock 体系：`mock-registry` + `NEXT_PUBLIC_USE_MOCK` 强制 mock（`mock-registry.config.ts` 定义 chat/characters/payment 模块）
- Telegram SDK 集成；无 ST iframe

**差异**

| 项                                             | 标记            |
| ---------------------------------------------- | --------------- |
| 无 `lib/bridge/`、`components/bridge/`         | ❌ 阶段二核心   |
| 无 `stores/st-mirror.ts`                       | ❌              |
| 聊天走 `/api/sessions/:id/messages` SSE，非 ST | ⚠️ 阶段二需迁移 |
| 支付 UI 存在，backend 无对应 API               | 🆕              |
| dev 端口 3000（设计 3001）                     | ⚠️              |
| `CLAUDE.md` 描述阶段二规则，代码未跟上         | ⚠️              |

**建议**

- **iframe + bridge-client**：**立即补**（阶段二编码主线）
- **自研聊天页**：**需你决策**（见 §I #1）— 替换 / 并存 / 渐进切换
- **支付模块**：**暂保留观察** — UI 可继续 mock，不阻塞 iframe MVP
- **根 layout 挂 iframe Provider**：**采纳设计** — `frontend/CLAUDE.md` L107–109 与主题 4 一致

---

### D.5 `bridge-protocol`（不存在）

**现状**：❌ 无包、无源码。主题 4 文档定义了 envelope、握手、错误码、mirror state、action 演进规则。

**建议**：**阶段二编码前创建**。MVP actions 建议最小集（需 spike 后确认 ST 内部 API）：

- `selectCharacter`, `selectChat`, `setModelTier`（或 `patchPresetField`）
- Events: `characterChanged`, `chatChanged`, `generationStarted/Finished`, …
- Mirror: 主题 4 §6.1 七字段

**与 shared 关系**：**新建独立包**，shared 仅保留 `deriveStHandle` 等身份工具；不要把 postMessage schema 塞回 shared。

---

### D.6 `st-extension`（不存在）

**现状**：❌ 无包。ST 在仓库外，无 `vendor/.../extensions/miniapp-bridge/` 注入路径。

**建议**

1. **先 vendoring ST**（`vendor/sillytavern/`）— 锁定 commit，写 NOTICE.md
2. **再建 st-extension** — tsup IIFE，postbuild 拷贝到 vendor 扩展目录
3. **SPIKE 阻塞项**（主题 4 §3.4、§2.3）：ST `APP_READY` / `chats_loaded` 等事件名须在锁定 commit 上确认

---

### D.7 `api-contract` / `db-types`（不存在）

**现状**

- REST 契约在 `@miniapp/shared/src/api/*`
- DB 类型在 `packages/backend/prisma/schema.prisma`（Prisma Client）

**建议**

- **api-contract**：阶段二 MVP **可暂不拆**；当 endpoint 数量 >10 或 frontend/backend 并行开发冲突时再拆
- **db-types**：**阶段二再补** — 优先服务 sync-engine 对 `st_*` schema 的类型安全；Prisma 继续服务 miniapp 业务

---

### D.8 `vendor/sillytavern`（不存在）

**现状**：ST 在仓库外 `SillyTavern-latest`（路径未在本 workspace 验证）。

**建议**：**阶段二启动 iframe 前必须完成 vendoring** — iframe src 依赖可部署、可注入扩展的 ST 实例；本地 dev 可用 docker-compose 或直连外部 ST。

---

### D.9 `ops/`（仅 git 工具）

**现状**：`ops/git/` 含 review 脚本；无 nginx、docker、seed。

**建议**：**阶段二部署前补** nginx + docker-compose；本地统一入口对 iframe 跨域/cookie 调试至关重要。优先级：本地 docker-compose **先于** Railway 五进程。

---

## §E. 真实环境变量清单（代码反查）

### E.1 `packages/backend`

| 变量                        | 读取位置                   | 默认值                  | 必填     | 说明                |
| --------------------------- | -------------------------- | ----------------------- | -------- | ------------------- |
| `PORT`                      | `platform/config.ts:4`     | `3001`                  | 否       | 监听端口            |
| `FRONTEND_URL`              | `platform/config.ts:5`     | `http://localhost:3000` | 否       | CORS                |
| `NODE_ENV`                  | `platform/config.ts:6`     | `development`           | 否       |                     |
| `TELEGRAM_BOT_TOKEN`        | `platform/config.ts:7`     | `''`                    | 生产必填 | TG InitData 校验    |
| `ST_BASE_URL`               | `platform/config.ts:11`    | `http://localhost:8000` | 否       | ST 服务地址         |
| `ST_USER_PASSWORD_SECRET`   | `platform/config.ts:13`    | `''`                    | 是       | 与 sync-engine 一致 |
| `ST_PROVISION_URL`          | `platform/config.ts:17`    | `http://127.0.0.1:9091` | 否       | bridge-api 地址     |
| `SUPABASE_URL`              | `lib/supabase.ts:16`       | —                       | 是       | service_role 客户端 |
| `SUPABASE_SERVICE_ROLE_KEY` | `lib/supabase.ts:17`       | —                       | 是       |                     |
| `DATABASE_URL`              | `prisma/schema.prisma:7`   | —                       | 是       | Prisma 连接         |
| `DIRECT_URL`                | `prisma/schema.prisma:8`   | —                       | 是       | Prisma 直连         |
| `DEV_AUTH_BYPASS`           | `app.ts:32`, `auth.ts:98`  | —                       | 否       | 开发跳过 TG 校验    |
| `MOCK_AUTH`                 | `auth.ts:25`               | —                       | 否       | 非生产 mock 用户    |
| `OPENAI_API_BASE_URL`       | `ChannelRegistry.ts:20` 等 | openai 默认             | 否       | 自研聊天 LLM        |
| `OPENAI_API_KEY`            | 同上                       | `''`                    | 否       |                     |
| `OPENAI_MODEL`              | 同上                       | `gpt-3.5-turbo`         | 否       |                     |
| `UPSTASH_REDIS_REST_URL`    | `UpstashConfigStore.ts:7`  | —                       | 可选     | 运行时配置          |
| `UPSTASH_REDIS_REST_TOKEN`  | `UpstashConfigStore.ts:8`  | —                       | 可选     |                     |

**未在代码中发现**：`JWT_SECRET`、设计稿 `BACKEND_*` 前缀统一校验、LLM 代理相关变量。

### E.2 `packages/frontend`

| 变量                             | 读取位置              | 默认值                  | 说明            |
| -------------------------------- | --------------------- | ----------------------- | --------------- |
| `NEXT_PUBLIC_API_URL`            | `lib/api/client.ts:4` | `http://localhost:3001` | backend 基址    |
| `NEXT_PUBLIC_USE_MOCK`           | `mock-registry.ts:28` | —                       | `1` 强制全 mock |
| `NEXT_PUBLIC_USE_MOCK_INIT_DATA` | `telegram/auth.ts:9`  | —                       | 跳过 TG         |
| `NEXT_PUBLIC_MOCK_USER_ID`       | `telegram/auth.ts:14` | `123456789`             |                 |
| `NODE_ENV`                       | `providers.tsx:33`    | —                       | devtools        |

**阶段二预计新增（设计/主题 4，代码尚无）**：`NEXT_PUBLIC_ST_IFRAME_ORIGIN`、`NEXT_PUBLIC_ST_IFRAME_PATH` 等 — **未确认**具体命名。

### E.3 `packages/sync-engine`

| 变量                        | 读取位置              | 默认    | zod      |
| --------------------------- | --------------------- | ------- | -------- |
| `SUPABASE_URL`              | `lib/config.ts:14`    | —       | 必填     |
| `SUPABASE_SERVICE_ROLE_KEY` | `lib/config.ts:15`    | —       | 必填     |
| `ST_DATA_PATH`              | `lib/config.ts:18`    | —       | 必填     |
| `ST_PLATFORM_ASSETS_PATH`   | `lib/config.ts:19`    | —       | 必填     |
| `ST_BASE_URL`               | `lib/config.ts:22`    | —       | 必填     |
| `ST_ADMIN_USERNAME`         | `lib/config.ts:23`    | `admin` |          |
| `ST_ADMIN_PASSWORD`         | `lib/config.ts:24`    | —       | 必填     |
| `ST_USER_PASSWORD_SECRET`   | `lib/config.ts:25`    | —       | 必填 ≥16 |
| `HEALTH_PORT`               | `lib/config.ts:28-37` | `9090`  |          |
| `BRIDGE_API_PORT`           | `lib/config.ts:40-49` | `9091`  |          |
| `NODE_ENV`                  | `lib/logger.ts:23-24` | —       |          |
| `LOG_LEVEL`                 | `lib/logger.ts:24`    | 按环境  |          |

### E.4 根目录

**未确认**：仓库根无 `.env.example` 文件（扫描未发现）。

---

## §F. 真实 API 端点清单（代码反查）

### F.1 `packages/backend`（Fastify）

| 方法     | 路径                         | 文件:行            | 鉴权        | 说明                      |
| -------- | ---------------------------- | ------------------ | ----------- | ------------------------- |
| `GET`    | `/health`                    | `app.ts:72`        | 无          | 健康检查                  |
| `GET`    | `/api/characters`            | `characters.ts:13` | 无          | Prisma 角色列表           |
| `GET`    | `/api/characters/:id`        | `characters.ts:31` | 无          | 角色详情                  |
| `GET`    | `/api/sessions`              | `sessions.ts:26`   | TG          | 会话列表                  |
| `GET`    | `/api/sessions/:id`          | `sessions.ts:61`   | TG          | 会话详情+消息             |
| `PATCH`  | `/api/sessions/:id`          | `sessions.ts:105`  | TG          | 更新 pinned/name          |
| `DELETE` | `/api/sessions/:id`          | `sessions.ts:160`  | TG          | 软删除                    |
| `POST`   | `/api/sessions/open`         | `sessions.ts:193`  | TG          | 开新会话                  |
| `POST`   | `/api/sessions/:id/messages` | `sessions.ts:233`  | TG          | 发消息 + **SSE 自研 LLM** |
| `POST`   | `/api/bridge/st-session`     | `bridge.ts:130`    | TG          | 鉴权桥                    |
| `ALL`    | `/api/bridge/st/*`           | `app.ts:68`        | Cookie 透传 | ST 反向代理               |

**frontend mock 期望但 backend 不存在**（`mock-registry.config.ts:42-48`）：

- `GET /api/payment/plans`
- `POST /api/payment/orders`
- `GET /api/payment/orders`
- `GET /api/payment/orders/:id`

**设计稿阶段二目标、现状不存在**：

- `/api/platform/llm-proxy/v1/*`
- provision 状态查询（如 `/api/platform/provision-status/:characterId`）

### F.2 `packages/sync-engine` bridge-api（Node http, 127.0.0.1）

| 方法   | 路径                      | 文件                           | 说明                |
| ------ | ------------------------- | ------------------------------ | ------------------- |
| `POST` | `/provision/:userId`      | `bridge-api/server.ts:66-75`   | 异步 provision，202 |
| `POST` | `/provision/:userId/sync` | `bridge-api/server.ts:104-131` | 同步 provision，200 |
| `GET`  | `/health`                 | `bridge-api/server.ts:141`     | 服务健康            |

**不存在**：flush、provision 状态查询、死信管理 HTTP API。

### F.3 health 服务（sync-engine 独立进程端口）

| 方法  | 路径      | 文件               | 说明                |
| ----- | --------- | ------------------ | ------------------- |
| `GET` | `/health` | `health/server.ts` | 队列 + watcher 快照 |

---

## §G. 真实数据库表清单

### G.1 Prisma 管理（`packages/backend/prisma/schema.prisma`）

**schema `miniapp`（阶段一业务）**

| 表                              | Prisma model            | 用途       |
| ------------------------------- | ----------------------- | ---------- |
| `miniapp.characters`            | `Character`             | 大厅角色卡 |
| `miniapp.miniapp_user_settings` | `miniapp_user_settings` | 用户设置   |
| `miniapp.runtime_config`        | `MiniappRuntimeConfig`  | 运行时配置 |

**schema `public`（遗留 + 用户）**

| 表                                                                                            | 说明                                                                    |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `public.users`                                                                                | TG 用户；含积分字段；**迁移 001 追加** `st_handle`, `st_initialized_at` |
| `public.messages`                                                                             | 遗留 bot 消息                                                           |
| `public.bot_users`, `bot_user_settings`, `botlinks`                                           | 遗留 bot                                                                |
| `public.role_data`                                                                            | 遗留角色数据                                                            |
| `public.payment_orders`, `checkin_logs`, `chat_snapshots`, `traffic_clicks`, `runtime_config` | 遗留/运营                                                               |

### G.2 Supabase SQL 迁移（`packages/shared/migrations/`，无 db-types）

**同步层 schema**（`003_create_st_schemas.sql`）

| Schema        | 表                     | 迁移文件 |
| ------------- | ---------------------- | -------- |
| `st_platform` | `platform_settings`    | 005      |
| `st_platform` | `platform_presets`     | 006      |
| `st_platform` | `platform_api_configs` | 007      |
| `st_users`    | `user_st_settings`     | 008      |
| `st_users`    | `user_st_chats`        | 009      |
| `st_infra`    | `sync_tasks`           | 012      |

**`miniapp.characters` 同步字段**（`004_characters_add_sync_fields.sql`）

- `is_default`, `enabled`, `sort_order` — 当前代码、Prisma schema、sync-engine fetcher 均以 `enabled` 作为上架字段。

**阶段一自研聊天表清理**（`020_drop_legacy_app_chat_tables.sql`）

- `miniapp.app_sessions`, `miniapp.app_messages` — 阶段二不再作为 Prisma Client 表面或业务依赖，物理表通过 SQL migration 删除。

**`public.users` ST 字段**（`001_users_add_st_fields.sql`）

- `st_handle`, `st_initialized_at`

### G.3 未确认

- 迁移是否已在目标 Supabase 实例执行：**未确认**
- Supabase Storage bucket / PNG 角色卡：**代码中未发现** Storage SDK 调用
- `db-types` 生成物：**不存在**

---

## §H. 已知差异汇总表

| ID  | 类别  | 描述                                         | 标记 | 推荐                                                           | 优先级     |
| --- | ----- | -------------------------------------------- | ---- | -------------------------------------------------------------- | ---------- |
| H01 | 包    | 无 bridge-protocol / st-extension            | ❌   | 阶段二编码前创建                                               | 立即补     |
| H02 | 包    | 无 vendor/sillytavern                        | ❌   | vendoring 后再做 iframe                                        | 立即补     |
| H03 | 包    | 无 api-contract / db-types                   | ❌   | 阶段二再评估拆分                                               | 阶段二再补 |
| H04 | 包    | 契约合入 @miniapp/shared                     | ⚠️   | 暂保留，bridge 独立后即可                                      | 暂保留观察 |
| H05 | 前端  | 无 iframe / bridge-client                    | ❌   | 按主题 4 实现                                                  | 立即补     |
| H06 | 前端  | 自研聊天 vs ST 原生双轨                      | ✅   | 阶段二以 ST iframe + `st_users.user_st_chats` 为准，遗留表删除 | 已处理     |
| H07 | 后端  | 无 llm-proxy                                 | ❌   | 阶段二 P0（ST 依赖）                                           | 阶段二再补 |
| H08 | 后端  | 无 provision-status API                      | ❌   | 阶段二 P0                                                      | 阶段二再补 |
| H09 | 后端  | 无 payment API 但有前端页                    | 🆕   | 暂保留 mock                                                    | 暂保留观察 |
| H10 | 后端  | Prisma 替代 db-types                         | ⚠️   | 保留 Prisma 服务 miniapp                                       | 调整设计稿 |
| H11 | sync  | bridge-api 命名 vs start:provision           | ⚠️   | 统一术语                                                       | 需小决议   |
| H12 | sync  | 缺 Realtime / flush / 状态查询               | ❌   | 按 §3.10 排期                                                  | 阶段二再补 |
| H13 | 数据  | enabled/is_default vs is_published/is_active | ✅   | 以 `enabled` / `is_default` 为准，代码与迁移已同步             | 已处理     |
| H14 | 目录  | platform-assets/ 仍存在                      | ⚠️   | 清理或迁移到 Supabase Storage                                  | 应清理     |
| H15 | 目录  | ops 仅 git，无 nginx/docker                  | ❌   | 本地 dev 前补 compose                                          | 阶段二再补 |
| H16 | 进程  | 根 dev 不含 sync-engine / ST                 | ⚠️   | 补 dev 文档或 compose                                          | 阶段二再补 |
| H17 | 端口  | frontend :3000, backend :3001 与设计相反     | ⚠️   | 保留现状或统一文档                                             | 调整设计稿 |
| H18 | CI    | 无 turbo / ci.yml / db-drift                 | ❌   | vendoring 后补                                                 | 阶段二再补 |
| H19 | env   | 无根 .env.example                            | ❌   | 补模板                                                         | 阶段二再补 |
| H20 | env   | ST_PLATFORM_ASSETS_PATH 指向旧 assets 概念   | ⚠️   | vendoring 后改路径                                             | 改成设计稿 |
| H21 | 测试  | sync-engine 有 vitest；backend/frontend 无   | 🆕   | 保持                                                           | 暂保留观察 |
| H22 | AI    | backend 自研 ChannelRegistry                 | 🆕   | iframe 后评估去留                                              | 暂保留观察 |
| H23 | 主题4 | SPIKE：ST 就绪事件名未确认                   | ❌   | 锁定 ST commit 后 spike                                        | 立即补     |
| H24 | 主题4 | ping/pong 周期同步                           | —    | 主题 4 已定 MVP 仅事件通道 A                                   | 暂不需要   |
| H25 | 支付  | mock-registry 与后端脱节                     | 🆕   | 不阻塞 MVP                                                     | 暂保留观察 |

---

## §I. 建议补充决议清单（设计盲点 / 需你拍板）

以下问题在写框架时无法从代码推断，**请你决策后再固化到 ADR**：

### I.1 阶段一自研聊天与阶段二 ST iframe 的关系

**结论**：阶段二替换为 ST iframe 原生聊天，侧边栏历史以 `st_users.user_st_chats` 镜像为准；`miniapp.app_sessions` / `app_messages` 已从 Prisma schema 移除，并由 `020_drop_legacy_app_chat_tables.sql` 物理删表。

### I.2 角色卡管控字段命名

**结论**：以 `enabled` / `is_default` 为准；大厅 API、sync-engine fetcher、Prisma schema、`004_characters_add_sync_fields.sql` 已统一。

### I.3 大厅角色卡权威源

**问题**：大厅当前读 `miniapp.characters`（Prisma，`characters.ts:14`）。阶段二是否继续由 Prisma 读取 `enabled=true` 的平台角色卡，还是改为专门 repository？

**影响**：backend 数据访问层、是否要 unified repository。

### I.4 模型等级切换的实现边界

**问题**：MVP「切换模型等级」走 Bridge `setModelTier` 改 ST settings，还是走 backend REST 再 provision 下发？

**影响**：bridge-protocol action 设计、LLM 代理与 ST settings 平台管控段分工。

### I.5 侧边栏历史的数据源

**问题**：阶段二 MVP 侧边栏展示 ST 原生 chat 列表，是否仅依赖 Bridge mirror state + events，还是需要 backend 聚合 `st_users.user_st_chats`？

**影响**：是否要新 API、watch 回流是否必须先可靠。

### I.6 SillyTavern vendoring 时间点与 commit 锁定

**问题**：iframe 开发是否允许短期继续指向外部 `SillyTavern-latest`，还是必须先完成 vendoring + NOTICE？

**影响**：st-extension 注入路径、CI、团队 clone 体验。

### I.7 主题 4 最小 action 清单（需 ST spike）

**问题**：在锁定 ST commit 上，切角色、切 chat、切模型等级分别调用 ST 哪条内部 API / DOM？`APP_READY`、`chats_loaded` 精确事件名？

**影响**：st-extension handlers、握手 phase 2/3 触发条件。主题 4 已标 SPIKE 假设（§3.4）。

### I.8 `bridge-api` vs `provision-api` 命名

**问题**：是否将 `packages/sync-engine` 的 `bridge-api` 脚本重命名为 `start:provision`（主题 4 §重要概念约定）？

**影响**：文档、env `ST_PROVISION_URL`、运维心智负担。

### I.9 nginx / 统一域名时机

**问题**：本地开发阶段是否接受 frontend 直连 :3000 + backend :3001 + ST :8000 三端口，还是尽早 docker-compose + nginx :8443？

**影响**：iframe `targetOrigin`、cookie SameSite、ST 代理路径调试。

### I.10 阶段二 MVP 范围外功能的处理

**问题**：支付页、创建页、主题设置等阶段一 UI 是否纳入阶段二框架，还是标记为「非 MVP、继续 mock」？

**影响**：frontend 路由保留范围、api-contract 拆分优先级。

---

## 附录：阶段二框架演进建议（维护成本视角）

面向 6–10 个月迭代，在**不扩大当前阶段范围**的前提下，建议固化以下分层（与主题 4 + 已决议方向一致）：

1. **契约先行**：`bridge-protocol` 独立包 → frontend `bridge-client` + `st-extension` 同版本联调；REST 契约暂留 shared，稳定后拆 `api-contract`。
2. **iframe 一次挂载**：根 Provider 持久 iframe（`frontend/CLAUDE.md` 规则）；路由只切显隐，避免 remount 导致握手风暴。
3. **数据双轨清晰标注**：ST 文件系统 = 聊天运行时真相；`st_users.*` = 镜像；`miniapp.*` Prisma 表 = 阶段一遗留或平台壳状态——在代码与文档中用注释标明「权威源」，避免新功能写错层。
4. **sync-engine 按决议 §3.10 增量改造**：先 provision 状态查询 + settings 分段，再 Realtime；不要与 iframe MVP 强耦合同一天上线。
5. **vendoring 闸门**：st-extension 开发分支依赖 `vendor/sillytavern` 固定 commit；外部 `SillyTavern-latest` 仅作 spike，不进 CI。

---

_文档生成：仓库静态扫描 + 设计稿对照。未在仓库内验证：Supabase 远程 schema 执行状态、SillyTavern-latest 路径内容、生产部署配置。_
