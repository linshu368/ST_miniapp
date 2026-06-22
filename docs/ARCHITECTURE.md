## 1. 架构铁律（违反即拦截）

1. **ST 原生代码不可修改**：`vendor/sillytavern/` 视为只读 third-party 代码，已锁定 commit（vendoring 自 `SillyTavern-latest` HEAD，永不升级）。任何对该目录下文件的直接修改一律拦截。所有 ST 定制只能通过：
   - 行为定制 → `packages/st-extension`（注入 ST 扩展机制）
   - 视觉定制 → 外挂 `user.css`
   - 配置定制 → ST 自身 `config.yaml` / 环境变量

2. **跨进程通信走契约层**：postMessage 走 `bridge-protocol`，REST 走 `api-contract`，DB 走 `db-types`。禁止应用包内重复定义协议字段。

3. **应用包互不 import**：`frontend` / `backend` / `sync-engine` / `st-extension` 之间无 import 关系，跨进程一律走 HTTP 或 postMessage。

4. **DB 类型不进前端**：`frontend` 禁止 import `db-types`；`api-contract` 禁止 import `db-types`。

5. **Bridge 不走业务组件直接 postMessage**：所有 postMessage 收发统一经 `frontend/lib/bridge/` 中的 `bridge-client`，业务组件只调 `platformAction()` / `useSTEvent()`。

6. **环境变量入口 zod 校验**：每个进程启动时校验所需 env，缺失/类型错误立即 throw。

---

## 2. 架构总览图

┌─────────────────────────────────────────────────────────────────────────┐
│ 用户 (Telegram WebView) │
│ ┌───────────────────────────────────────────────────────────────────┐ │
│ │ packages/frontend (Next.js, Vercel) │ │
│ │ │ │
│ │ ┌──────────────────────────┐ ┌──────────────────────────────┐ │ │
│ │ │ React 组件树 │ │ ST iframe │ │ │
│ │ │ ├─ 大厅(角色卡列表) │ │ /tavern/_ (持久挂载,根 layout)│ │ │
│ │ │ ├─ 对话页(自研工具栏 + │◄──►│ │ │ │
│ │ │ │ 自研侧边栏 + │ │ ┌────────────────────────┐ │ │ │
│ │ │ │ ST iframe 投影) │ │ │ ST 原生前端(零改) │ │ │ │
│ │ │ ├─ 个人中心 / 支付 │ │ │ + st-extension(IIFE) │ │ │ │
│ │ │ └─ Bridge Provider │ │ └────────────────────────┘ │ │ │
│ │ └────────────┬─────────────┘ └──────────────────────────────┘ │ │
│ │ │ postMessage(miniapp-bridge channel) │ │
│ │ ┌────────────▼─────────────┐ │ │
│ │ │ bridge-client │ │ │
│ │ │ (lib/bridge/_) │ │ │
│ │ │ platformAction()/ │ │ │
│ │ │ useSTEvent()/ │ │ │
│ │ │ useBridgeStatus() │ │ │
│ │ └───────────────────────────┘ │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────┬─────────────────────────────────────────┘
│ HTTPS (单一域名,经 nginx 反代)
▼
┌────────────────────────────┐
│ nginx (Railway) │
│ / → Vercel │
│ /api/platform/_→ backend │
│ /tavern/_ → ST 服务 │
│ /api/_ → ST 服务 │
└──┬──────────────┬───────────┘
│ │
┌───────────────┘ └──────────────┐
▼ ▼
┌──────────────────────┐ ┌────────────────────────┐
│ miniapp 后端 │ │ ST 服务 │
│ packages/backend │ │ vendor/sillytavern │
│ (Railway) │ │ + st-extension(注入) │
│ │ │ (Railway) │
│ 路由分组: │ │ │
│ ├─ 鉴权桥 │ │ 原生 200+ 路由(零改) │
│ │ /api/bridge/_ │ │ ├─ 角色卡 / 聊天 │
│ ├─ 业务 API │ │ ├─ 预设 / 世界书 │
│ │ /api/characters │ │ ├─ LLM 调用(指向网关) │
│ ├─ LLM 代理网关 │◄─── ST 透传调用 ───┤ └─ 文件系统持久化 │
│ │ /api/platform/ │ └─────────┬───────────────┘
│ │ llm-proxy/v1/_ │ │
│ └─ provision 状态 │ │ 文件系统读写
│ 代理(转发到 │ ▼
│ sync-engine) │ ┌────────────────────────┐
└──┬───────────────────┘ │ ST data 目录 │
│ Prisma │ data/<userId>/ │
│ + supabase-js │ ├─ chats/ │
│ + HTTP→sync-engine │ ├─ characters/ │
│ │ ├─ presets/ │
│ ┌─────────────────────►│ └─ settings.json │
│ │ HTTP └─────────┬───────────────┘
│ │ │
│ ┌────────┴───────────────┐ │
│ │ sync-engine │ │
│ │ packages/sync-engine │ │
│ │ (Railway,双进程) │ │
│ │ │ │
│ │ 进程 1: provision-api │ 写入文件系统 │
│ │ HTTP :PROVISION_API_PORT├───────────────┘
│ │ │
│ │ 进程 2: watcher │◄───────────────┐
│ │ chokidar 监听 │ 监听文件系统变化│
│ └────────────┬────────────┘ │
│ │ supabase-js │
▼ ▼ │
┌──────────────────────────────────────────────────────┴──────────────┐
│ Supabase (PostgreSQL + Storage + Realtime) │
│ │
│ Schema: │
│ ├─ public._ 用户身份(users + 阶段一遗留 bot 表) │
│ ├─ miniapp._ 平台业务(characters / runtime_config / │
│ │ miniapp_user_settings) │
│ ├─ st_platform._ 全平台 ST 资源(settings 平台段 / presets / API 配置)│
│ ├─ st_users._ 用户私有 ST 镜像(settings 用户段 / │
│ │ user_st_chats) │
│ └─ st_infra._ 同步任务(sync_tasks) │
│ │
│ Storage: │
│ └─ characters/ 角色卡 PNG (运营手工上传) │
│ │
│ Realtime: │
│ └─ is_published 翻转事件 → sync-engine 订阅 │
└──────────────────────────────────────────────────────────────────────┘

## 3. 链路编号定义

| 编号 | 方向                               | 用途                                                                               | 通道 |
| ---- | ---------------------------------- | ---------------------------------------------------------------------------------- | ---- |
| ①    | frontend → backend (HTTP)          | 业务 REST：角色卡、用户信息、LLM 代理调用、provision 状态查询、历史侧边栏列表      | A    |
| ②    | frontend → ST iframe (postMessage) | bridge action：切角色、切 chat、切模型等级、删除/置顶/重命名等所有 ST 内部业务调用 | B    |
| ③    | ST iframe → frontend (postMessage) | bridge event：APP_READY、生成开始/结束、mirror state 推送                          | B    |
| ④    | ST → 文件系统                      | ST 原生持久化（chat 文件、settings.json）；用户运行时真相的写入路径                | —    |
| ⑤    | backend ⇆ sync-engine (HTTP)       | provision 触发与状态查询；backend 不直接调 ST 后端                                 | B    |
| ⑥    | sync-engine ⇆ Supabase             | provision 下行（读 Supabase 写 ST 文件系统）+ watcher 上行（监听 ST 文件系统回流） | —    |
| ⑦    | frontend → Supabase（仅只读）      | 角色卡 PNG 等只读浏览；禁止前端直写                                                | A    |

---

## 4. 包清单

### 4.1 契约层（纯类型，无运行时）

| 包                | 职责                                                                             | 消费者                                 | 状态                                                     |
| ----------------- | -------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| `bridge-protocol` | postMessage 契约：envelope / 三段握手 / 错误码 / mirror state / actions / events | `frontend`, `st-extension`             | 阶段二待建（先建协议骨架，actions/events 待 spike 后补） |
| `api-contract`    | REST API Zod schema                                                              | `frontend`, `backend`                  | 阶段二可暂留 `@miniapp/shared`，稳定后再拆               |
| `db-types`        | Supabase 同步层 schema 镜像（机器生成）                                          | `backend`（同步层场景）, `sync-engine` | 阶段二启动前必建                                         |
| `shared`          | 跨包常量、纯工具、`deriveStHandle` 等                                            | 所有包                                 | 已存在；含 `migrations/`（Supabase SQL）                 |

### 4.2 应用层（运行时）

| 包             | 职责                                                                     | dev 端口           | 部署                                                                          |
| -------------- | ------------------------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------- |
| `frontend`     | 平台壳 Next.js 应用（大厅、自研工具栏、ST iframe 宿主、lib/bridge）      | 3000               | Vercel                                                                        |
| `backend`      | Fastify：鉴权桥 + ST 反代 + 业务 REST + LLM 代理网关 + provision-status  | 3001               | Railway                                                                       |
| `sync-engine`  | 双进程：`provision-api`（HTTP :9091）+ `watcher`（chokidar，无业务端口） | 9091 / health 9090 | Railway（两个独立服务）                                                       |
| `st-extension` | IIFE 注入到 ST，实现 bridge-protocol 的 ST 端                            | —                  | 构建产物拷贝到 `vendor/sillytavern/public/scripts/extensions/miniapp-bridge/` |

### 4.3 vendor / ops

| 路径                  | 性质                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| `vendor/sillytavern/` | vendored ST 原生代码，**只读**，锁 commit hash，删 `.git`，写 `NOTICE.md` |
| `ops/nginx/`          | 反向代理配置（dev :8443 / prod :443）                                     |
| `ops/docker/`         | 本地 docker-compose 编排 ST + nginx                                       |

### 4.4 包依赖方向（强制）

契约层（无副作用）：
bridge-protocol ──┐
api-contract ──┼─► 可被任意应用包 import
db-types ──┤ （db-types 仅服务端）
shared ──┘

应用层：
frontend ──► bridge-protocol, api-contract, shared
st-extension ──► bridge-protocol, shared
backend ──► api-contract, db-types, shared, prisma-client, supabase-js
sync-engine ──► db-types, shared, supabase-js

禁止：
✗ frontend → db-types
✗ frontend → backend / sync-engine（跨进程走 HTTP）
✗ 应用包 → 应用包
✗ 契约层 → 应用包
✗ 任何 import 环

---

## 5. 业务执行模型（关键）

ST 在本项目的定位**不是纯渲染容器，而是业务执行引擎**。角色切换 / 会话管理 / 消息生成都在 ST 内部状态机里发生。平台壳的角色 = UI 入口 + 通过 bridge 触发 ST 内部动作 + 维护完整镜像供查询。

| 业务功能             | UI 入口                | 业务执行                                        | 持久化（写入真相）                                      | 查询真相（镜像）                     |
| -------------------- | ---------------------- | ----------------------------------------------- | ------------------------------------------------------- | ------------------------------------ |
| 大厅角色卡列表       | 自研                   | backend 读 `miniapp.characters`（Prisma）       | Supabase Storage（PNG）+ `miniapp.characters`（元数据） | 同左                                 |
| 切换角色             | 自研（点角色卡）       | bridge action ② → ST 改 `active_character`      | ST 文件系统 ④                                           | `st_users.user_st_settings`          |
| 切换会话             | 自研（点侧边栏列表项） | bridge action ② → ST 内部 chat 切换             | ST 文件系统 ④                                           | `st_users.user_st_chats`             |
| 删除/置顶/重命名会话 | 自研（侧边栏交互）     | bridge action ② → ST 内部处理                   | ST 文件系统 ④                                           | `st_users.user_st_chats`             |
| 历史侧边栏列表渲染   | 自研                   | backend 读 `st_users.user_st_chats`（db-types） | —                                                       | 同步层镜像                           |
| 模型切换             | 自研按钮               | bridge action ② → ST 改 settings                | ST 文件系统 ④（settings.json 用户段）                   | `st_users.user_st_settings`          |
| 消息生成             | ST iframe 内           | ST 自己（通过平台 LLM 代理网关 ① 调上游）       | ST 文件系统 ④（chat 文件）                              | `st_users.user_st_chats`（异步回流） |

**关键纪律**：

- **业务真相归属**：运行时真相 = ST 文件系统；业务可查询真相 = Supabase 同步层镜像（`st_users.*`）。平台壳通过 db-types 读镜像，不读 ST 文件系统。
- **聊天记录单一回流**：LLM 代理网关**不**承担消息双写；用户聊天记录的镜像由 sync-engine watcher 单一回流到 `st_users.user_st_chats`，分钟级最终一致。
- **阶段一自研聊天已废弃**：`miniapp.app_sessions` / `app_messages` 表、frontend `MessageList` / `Composer` / `ChatSidebar`、backend `/api/sessions/*` CRUD 路由，**阶段二开工即拆**。任何向这些遗留代码提交新功能的 PR 应被拦截。
- **`ai/ChannelRegistry` 模块**改造为 LLM 代理网关底层（无状态 LLM 调用器 + SSE 透传），路径迁移到 `/api/platform/llm-proxy/v1/*`。

---

## 6. 通道判定（代码审查直接对应）

代码审查按 diff 涉及文件路径判定通道：

### 通道 A — 纯自研平台

仅涉及以下范围：

- `packages/frontend` 中**不**涉及 `lib/bridge/`、`components/bridge/`、`stores/st-mirror.ts`、iframe 控制层、`platformAction()` 的文件
- `packages/backend` 中**不**涉及鉴权桥（`routes/bridge.ts`）、ST 反代（`middleware/stProxy.ts`）、`provision-client`、LLM 代理网关、ST API 调用的文件
- `packages/shared`、`packages/api-contract`
- `packages/sync-engine` 中**不**涉及 ST 文件系统读写或 ST 资源格式的代码（如纯 queue / health / config 工具）
- 仅链路 ① ⑥ ⑦

### 通道 B — 涉及 ST 桥接

涉及任一：

- `packages/bridge-protocol`
- `packages/st-extension`
- `vendor/sillytavern/` 任何文件变更（含 `NOTICE.md` 中 commit hash 更新；其他文件直接修改 → 触发架构铁律拦截）
- `packages/frontend` 中 `lib/bridge/`、`components/bridge/`、`stores/st-mirror.ts`、`platformAction()`、iframe 宿主组件
- `packages/backend` 中鉴权桥、ST 反代、`provision-client`、LLM 代理网关、ST API Client
- `packages/sync-engine` 中涉及 ST 文件系统格式（provisioner、watcher 的 uploader/fetcher）
- `ops/nginx` 中 `/tavern/*` 或 `/api/*` 路由分发逻辑
- `ops/docker` 中 ST 镜像构建脚本
- 任何涉及 postMessage、链路 ② ③ ⑤ 的代码

### 跨通道

diff 同时包含 A 和 B 范围。建议拆分独立提交。

---

## 7. 数据真相归属

| 数据类型                    | 权威源                                             | 镜像                        | 备注                             |
| --------------------------- | -------------------------------------------------- | --------------------------- | -------------------------------- |
| 用户身份                    | `public.users`（Prisma + Supabase 混用）           | —                           | TG 身份 + `st_handle`            |
| 角色卡 PNG                  | Supabase Storage                                   | —                           | sync-engine 拉取下发 ST          |
| 角色卡元数据                | `miniapp.characters`（Prisma）                     | —                           | backend 读取渲染大厅             |
| 预设                        | `st_platform.platform_presets`（同步层）           | —                           | provision 时全量下发             |
| 平台管控 settings 段        | `st_platform.platform_settings`（同步层）          | —                           | provision 下发到 settings.json   |
| 用户 settings 用户段        | ST 文件系统 settings.json（用户段）                | `st_users.user_st_settings` | watcher 回流                     |
| 用户聊天记录                | ST 文件系统 chats/                                 | `st_users.user_st_chats`    | watcher 异步回流，分钟级最终一致 |
| 平台壳用户配置（UI 偏好等） | `miniapp.miniapp_user_settings`（Prisma）          | —                           | 与 ST 无关的纯平台数据           |
| 平台运行时配置              | `miniapp.runtime_config`（Prisma） + Upstash Redis | —                           | feature flag 等                  |

**Prisma vs db-types 边界**：

- Prisma 管理 `miniapp.*` + `public.*`（业务/平台数据）
- db-types 管理 `st_platform.*` / `st_users.*` / `st_infra.*`（同步层）
- frontend **禁止** import db-types

---

## 8. 关键路由 / 接口清单

### 8.1 backend（Fastify, dev :3001）

- `POST /api/bridge/st-session` — 鉴权桥（TG InitData → ST cookie）
- `ALL /api/bridge/st/*` — ST 反向代理（透明转发到 :8000）
- `GET /api/characters` / `:id` — 大厅角色卡（Prisma `miniapp.characters`，过滤 `is_published=true AND is_active=true`）
- `POST /api/platform/llm-proxy/v1/*` — LLM 代理网关（OpenAI 兼容 + SSE 透传，由 `ai/ChannelRegistry` 改造）
- `GET /api/platform/provision-status/:userId` — provision 状态查询（代理 sync-engine）
- 历史侧边栏数据源（具体路径阶段二实现时定）— 读 db-types 查 `st_users.user_st_chats`

阶段二需删除（H06 决议）：

- `GET/POST/PATCH/DELETE /api/sessions/*` 全部自研聊天 CRUD

### 8.2 sync-engine provision-api（dev :9091, 仅 127.0.0.1）

- `POST /provision/:userId` — 异步触发，202
- `POST /provision/:userId/sync` — 同步触发，200
- `POST /provision/:userId/flush` — 强制回流（登出前），阶段二 P0
- `GET /provision/:userId/status` — 状态查询，阶段二 P0
- `GET /health`

### 8.3 ST 服务（vendor/sillytavern, dev :8000）

原生 200+ 路由，**零修改**。所有定制经 st-extension 在浏览器端注入。

---

## 9. 部署单元

| 单元                      | 包                                       | 启动命令               | 平台                   |
| ------------------------- | ---------------------------------------- | ---------------------- | ---------------------- |
| 平台前端                  | `packages/frontend`                      | Vercel build           | Vercel CDN             |
| miniapp 后端              | `packages/backend`                       | `tsx src/server.ts`    | Railway                |
| sync-engine provision-api | `packages/sync-engine`                   | `pnpm start:provision` | Railway                |
| sync-engine watcher       | `packages/sync-engine`                   | `pnpm start:watcher`   | Railway                |
| ST 服务                   | `vendor/sillytavern` + st-extension 产物 | `node server.js`       | Railway（Docker 镜像） |
| Nginx                     | `ops/nginx`                              | 标准启动               | Railway                |
| Supabase                  | 托管                                     | —                      | Supabase Cloud         |

---

## 10. 关键约束补充

### 10.1 角色卡字段语义（P0 已归档）

- `is_published`：上架状态，控制大厅展示和新用户 provision
- `is_active`：可用状态，控制老用户已物化卡是否可继续使用
- `is_default`：新用户初始化时是否自动激活此卡
- `sort_order`：大厅展示顺序

### 10.2 环境变量命名前缀

| 前缀        | 用途                 |
| ----------- | -------------------- |
| `PUBLIC_`   | 暴露给浏览器         |
| `BACKEND_`  | miniapp 后端私有     |
| `SYNC_`     | sync-engine 私有     |
| `ST_`       | ST 进程相关          |
| `SUPABASE_` | Supabase 连接        |
| `LLM_`      | LLM 上游             |
| `BRIDGE_`   | Bridge Protocol 常量 |

### 10.3 settings.json 分段

ST 原生不分段；由 sync-engine 维护字段清单：

- **平台管控段**：LLM endpoint、instruct templates、context templates、默认采样参数等。provision 时从 Supabase 全平台统一下发。
- **用户可修改段**：UI 偏好、用户对预设的微调等。watcher 时回流到 `st_users.user_st_settings`。

### 10.4 LLM 调用路径

ST 配置中 LLM endpoint 指向 `https://your-domain.com/api/platform/llm-proxy/v1/`。代理网关职责：JWT/内部 token 验证、识别 userId、持平台真实 API key、转发到上游、SSE 流式透传。**不**承担消息双写。

### 10.5 代码审查 prompt 兼容性提示

代码审查 prompt 中的术语与本项目实际命名映射：

- prompt 中 `packages/st-injection` ＝ 本项目 `packages/st-extension`
- prompt 中 `sillytavern/` 路径 ＝ 本项目 `vendor/sillytavern/`
- prompt 中 `bridge-server` ＝ 本项目 backend 的"鉴权桥 + ST 反代 + provision-client"组合
- prompt 中"链路 ② ③ ⑤" 与本文档第 3 节链路编号一致

---

_本文档随阶段二编码推进迭代；P1 / P2 决议过审完成后会扩展第 11 节"开发约定与 CI 规则"。_
