# ST_miniAPP 架构说明

> 本文档基于对 `packages/` 下核心源码的实测梳理，反映 **阶段 0～3 完成后** 的实际架构。
> 阶段 0：清场（删除阶段一遗留 + schema 迁移）｜阶段 1：基础设施落位（vendoring + 包脚手架）｜
> 阶段 2：SPIKE（vendor 内验证 ST 内部 API）｜阶段 3：bridge 完整化（actions/events 补完 + frontend lib/bridge + iframe 宿主）。
>
> 文中凡涉及"计划 vs 实测"差异处，均以 **【实测】** / **【占位】** / **【未接线】** 标注。

---

## 1. 架构铁律（违反即拦截）

1. **ST 原生代码不可修改**：`vendor/sillytavern/` 视为只读 third-party 代码，已锁定 commit（vendoring 自 `SillyTavern-latest` HEAD，永不升级）。任何对该目录下文件的直接修改一律拦截。所有 ST 定制只能通过：
   - 行为定制 → `packages/st-extension`（构建产物注入 ST 扩展机制）
   - 视觉定制 → 外挂 `user.css`
   - 配置定制 → ST 自身 `config.yaml` / 环境变量 / provision 下发的 `settings.json`

2. **跨进程通信走契约层**：postMessage 走 `bridge-protocol`，REST 走共享契约，DB 同步层类型走 `db-types`。禁止应用包内重复定义协议字段。
   - 【实测】REST 契约目前位于 `@miniapp/shared/src/api/*`（envelope / characters / settings / payment / wallet），**尚未拆出独立 `api-contract` 包**。
   - 【实测】`db-types` 已机器生成（`generated.ts` / `tables.ts`），但当前 **无任何运行时包 import**（sync-engine 用 supabase-js 的 `.schema('st_users')` 字符串查询，backend 用 Prisma）。属于"已生成未接线"。

3. **应用包互不 import**：`frontend` / `backend` / `sync-engine` / `st-extension` 之间无 import 关系，跨进程一律走 HTTP 或 postMessage。

4. **DB 类型不进前端**：`frontend` 禁止 import `db-types`；REST 契约（shared/api）禁止 import `db-types`。

5. **Bridge 不走业务组件直接 postMessage**：所有 postMessage 收发统一经 `frontend/src/lib/bridge/`（`BridgeClient` 单例），业务组件只调 `platformAction()` / `useSTEvent()` / `useSTMirror()` / `useBridgeStatus()`。

6. **环境变量入口校验**：进程启动时校验所需 env。
   - 【实测】`sync-engine` 用 zod `loadConfig()` 严格 fail-fast；`backend/src/platform/config.ts` 当前以 `process.env || 默认值` 形式宽松读取（仅 `createDatabaseConfig` 部分严格），后续应收敛为统一 zod 校验。

---

## 2. 架构总览图（实测）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 用户 (Telegram WebView)                                                        │
│ ┌───────────────────────────────────────────────────────────────────────┐   │
│ │ packages/frontend (Next.js App Router, Vercel)                          │   │
│ │   Providers → BridgeProvider → { 业务路由 + <STIframe/> 常驻挂载 }       │   │
│ │                                                                         │   │
│ │ ┌──────────────────────────┐        ┌──────────────────────────────┐   │   │
│ │ │ React 组件树 (自研壳)     │        │ <STIframe> src="/tavern/"     │   │   │
│ │ │ ├─ (main) 大厅/个人中心   │        │  常驻挂载，仅按 pathname        │   │   │
│ │ │ │   /支付/设置            │        │  startsWith('/tavern/') 切显隐 │   │   │
│ │ │ ├─ /tavern/[characterId] │◄──────►│  ┌────────────────────────┐   │   │   │
│ │ │ │   (对话页, 触发切角色)  │ post   │  │ ST 原生前端(零改)       │   │   │   │
│ │ │ └─ BridgeProvider        │ Message│  │ + st-extension(IIFE 注入)│  │   │   │
│ │ └────────────┬─────────────┘        │  └────────────────────────┘   │   │   │
│ │              │ window.postMessage(channel='miniapp-bridge')           │   │   │
│ │ ┌────────────▼──────────────────────────────────────────────────┐    │   │   │
│ │ │ lib/bridge: BridgeClient(单例)                                  │    │   │   │
│ │ │  state-machine(idle→loading→handshaked→ready) + RequestBuffer   │    │   │   │
│ │ │  platformAction() / useSTEvent() / useSTMirror() / useBridge…   │    │   │   │
│ │ │  → stores/st-mirror (zustand 镜像)                              │    │   │   │
│ │ └───────────────────────────────────────────────────────────────┘    │   │   │
│ └───────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────┬────────────────────────────────────────────┘
                                    │ HTTPS（单域名，prod 经 nginx 反代）
        ┌───────────────────────────┼───────────────────────────────┐
        │ /api/* (业务/桥接)         │ /tavern/* (ST 前端 + /api/* ST 原生)
        ▼                            ▼
┌──────────────────────────────┐   ┌────────────────────────────────┐
│ miniapp 后端 backend (Fastify)│   │ ST 服务 vendor/sillytavern      │
│ (Railway, dev :3001)          │   │ + st-extension(注入) (Railway)  │
│                               │   │                                 │
│ 路由分组：                    │   │ 原生 200+ 路由(零改)            │
│ ├─ 鉴权桥 /api/bridge/st-...  │   │ ├─ 用户/登录(cookie-session)    │
│ ├─ ST 反代 /api/bridge/st/*   ├──►│ ├─ 角色卡 / 聊天 / 预设 / 世界书 │
│ ├─ 业务 /api/characters       │   │ ├─ LLM 调用(endpoint 指向网关)  │
│ ├─ 业务 /api/users/settings   │   │ └─ 文件系统持久化               │
│ ├─ 支付 /api/payment·/wallet  │   └─────────────┬──────────────────┘
│ └─ LLM 网关                   │                 │ 文件系统读写
│    /api/platform/llm-proxy/v1 │                 ▼
└──┬──────────────┬─────────────┘   ┌────────────────────────────────┐
   │ Prisma       │ HTTP            │ ST data 目录 data/<st_handle>/  │
   │ (miniapp.*   │ (provision)     │ ├─ chats/                       │
   │  public.*)   │                 │ ├─ characters/ (platform_*.png) │
   │              ▼                 │ ├─ OpenAI Settings/ (预设)      │
   │   ┌────────────────────────┐  │ ├─ secrets.json (API key)       │
   │   │ sync-engine            │  │ └─ settings.json                │
   │   │ (Railway, 双进程)       │  └────────────┬───────────────────┘
   │   │                        │               │
   │   │ 进程1 provision-api     │ 写文件系统     │
   │   │  http 127.0.0.1:9091   ├───────────────┘
   │   │ 进程2 watcher          │◄───────────────┐ chokidar 监听
   │   │  chokidar+queue        │                │ settings.json 变更
   │   │  +health :9090         │                │
   │   └────────────┬───────────┘                │
   │                │ supabase-js                │
   ▼                ▼                            │
┌──────────────────────────────────────────────┴───────────────────────┐
│ Supabase (PostgreSQL + Storage + Realtime)                            │
│  Schema:                                                              │
│  ├─ public.*      用户身份 (users + st_handle / st_initialized_at)    │
│  ├─ miniapp.*     平台业务 (characters / miniapp_user_settings /      │
│  │                wallet / payment_orders / runtime_config)           │
│  ├─ st_platform.* 全平台 ST 资源 (platform_settings / platform_presets│
│  │                / platform_api_configs)                             │
│  ├─ st_users.*    用户私有 ST 镜像 (user_st_settings ✅ /             │
│  │                user_st_chats ⏳占位)                               │
│  └─ st_infra.*    同步任务队列 (sync_tasks)                           │
│  Storage:  characters/ 角色卡 PNG（运营手工上传 / 平台资产目录）       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. 链路编号定义

| 编号 | 方向                               | 用途                                                                   | 实现状态                         |
| ---- | ---------------------------------- | ---------------------------------------------------------------------- | -------------------------------- |
| ①    | frontend → backend (HTTP)          | 业务 REST：角色卡、用户设置、支付/钱包、LLM 代理调用                   | ✅ 已建                          |
| ②    | frontend → ST iframe (postMessage) | bridge action：切角色 / 切 chat / 改模型 / 删除·置顶·重命名等          | ✅ 已建                          |
| ③    | ST iframe → frontend (postMessage) | bridge event / handshake / pong(mirror state)                          | ✅ 已建                          |
| ④    | ST → 文件系统                      | ST 原生持久化（chat 文件、settings.json）；用户运行时真相写入路径      | ✅ 原生                          |
| ⑤    | backend → sync-engine (HTTP)       | provision 触发（同步/异步）；backend 不直接调 ST 后端做 provision      | ✅ 已建                          |
| ⑥    | sync-engine ⇆ Supabase + 文件系统  | provision 下行（读 Supabase 写 ST 文件系统）+ watcher 上行（监听回流） | ✅ settings 已建 / ⏳ chats 占位 |
| ⑦    | frontend → Supabase（仅只读）      | 角色卡 PNG 等只读浏览；禁止前端直写                                    | ✅ 约定                          |

> 链路 ⑤ 现状：backend 只调用 `POST /provision/:userId`（异步）与 `POST /provision/:userId/sync?force=`（同步）。**没有** provision 状态查询 / flush 链路（计划中的 `/status`、`/flush` 端点未实现）。

---

## 4. 包清单（实测）

### 4.1 契约层（纯类型 / 协议）

| 包                | 职责                                                                                                                                                              | 消费者                                   | 状态                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------- |
| `bridge-protocol` | postMessage 完整契约：envelope / 三段握手 / 错误码 / mirror state / 7 actions / 13 events / parser / BridgeError                                                  | `frontend`, `st-extension`               | ✅ **完整落地**                        |
| `shared`          | 跨包常量与纯工具：`deriveStHandle`、`createDatabaseConfig`、REST API 类型（`api/*`）、`ok/fail` envelope、dev-fixtures；含 `migrations/`（Supabase SQL，001~020） | 所有包                                   | ✅ 已建（同时承担 REST 契约职责）      |
| `db-types`        | Supabase 同步层 schema 镜像（机器生成 `generated.ts` + `tables.ts`）                                                                                              | （计划：backend 同步场景 / sync-engine） | ⚠️ **已生成、未接线**                  |
| `api-contract`    | 计划中的独立 REST 契约包                                                                                                                                          | —                                        | ❌ **未创建**（职责暂留 `shared/api`） |

### 4.2 应用层（运行时）

| 包             | 职责                                                                                             | dev 端口        | 部署                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------- |
| `frontend`     | 平台壳 Next.js（App Router）：大厅 / 个人中心 / 支付 / 设置 + `lib/bridge` + 常驻 ST iframe 宿主 | 3000            | Vercel                                                                                    |
| `backend`      | Fastify：鉴权桥 + ST 反代 + 业务 REST（角色卡/设置/支付/钱包）+ LLM 代理网关                     | 3001            | Railway                                                                                   |
| `sync-engine`  | 双进程：`provision-api`（HTTP 127.0.0.1:9091）+ `watcher`（chokidar + 队列消费 + health :9090）  | 9091 / 9090     | Railway（两个独立服务）                                                                   |
| `st-extension` | IIFE 注入 ST，实现 bridge-protocol 的 ST 端                                                      | —（随 ST 加载） | 构建产物拷贝到 `vendor/sillytavern/public/scripts/extensions/third-party/miniapp-bridge/` |

### 4.3 vendor / ops

| 路径                  | 性质                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `vendor/sillytavern/` | vendored ST 原生代码，**只读**，锁 commit hash                                                 |
| `ops/nginx/`          | 反向代理配置（prod 单域名分发 `/`→Vercel、`/tavern/*`+`/api/*`→ST、`/api/platform/*`→backend） |
| `ops/docker/`         | 本地 docker-compose 编排 ST + nginx                                                            |

### 4.4 包依赖方向（强制）

```
契约层（无副作用）：
  bridge-protocol ──┐
  shared (含 api/) ─┼─► 可被应用包 import
  db-types ─────────┘   （db-types 仅服务端，且当前未接线）

应用层：
  frontend     ──► bridge-protocol, shared
  st-extension ──► bridge-protocol, shared
  backend      ──► shared, prisma-client, supabase-js
  sync-engine  ──► shared, supabase-js（+ 计划接入 db-types）

禁止：
  ✗ frontend → db-types
  ✗ frontend → backend / sync-engine（跨进程走 HTTP）
  ✗ 应用包 → 应用包
  ✗ 契约层 → 应用包
  ✗ 任何 import 环
```

---

## 5. Bridge 协议详解（`bridge-protocol`）

### 5.1 信封与消息类型

- 通道常量：`BRIDGE_CHANNEL = 'miniapp-bridge'`，`PROTOCOL_VERSION = 1`。
- 信封 `BridgeEnvelope`：`{ channel, protocolVersion, type, timestamp }`，每条消息都 zod 校验。
- 6 种消息类型：`request` / `response` / `event` / `handshake` / `ping` / `pong`。
- 大小限制：`checkMessageSize` 拦截超过 `MAX_MESSAGE_SIZE` 的消息（见 `limits.ts`）。

### 5.2 两段握手 + 缓冲

```
ST 端 (st-extension)                         壳端 (BridgeClient)
  init() → createBridgeServer('*')
  sendHandshake('handshake', meta) ─────────►  收到 handshake：
    meta = { stCommit, extensionBuildId,        - 校验 protocolVersion / boundUserId
             supportedActions, supportedEvents, - 记录 supportedActions/Events
             boundUserId }                      - 状态 loading→handshaked
  (监听 ST APP_READY)                           - flush 缓冲中 requiredPhase<=handshake 的请求
  APP_READY → setCurrentPhase('ready')
  sendHandshake('ready') ───────────────────►  状态 handshaked→ready，flush 剩余请求
```

- 状态机（`state-machine.ts`）：`idle → loading → handshaked → ready`，任意态可 `→ disconnected`。
- 超时：单次 action `HANDSHAKE_ACTION_TIMEOUT=30s`；总握手 `HANDSHAKE_TOTAL_TIMEOUT=60s`，超时即 `disconnect`。
- 请求缓冲（`buffer.ts`）：握手完成前对 `waitable` 的 action 入队（上限 `HANDSHAKE_BUFFER_LIMIT=32`），到达对应 phase 后按序 flush；非 waitable 且 phase 不足则直接 reject。

### 5.3 Actions（壳 → ST，7 个）

`selectCharacter` / `openChat` / `newChat` / `renameChat` / `deleteChat` / `changeModel` / `getReadyState`。
每个 action 在 `actions/<name>.ts` 定义 `ActionMeta { name, payloadSchema, resultSchema, requiredPhase, waitable }`，统一汇入 `actionRegistry`。ST 端 `bridge-server` 收到 `request` 后：校验信封 → 校验 phase → zod 校验 payload → 查 handler → 执行 → 回 `response`。

### 5.4 Events（ST → 壳，13 个）

`app:ready`、`character:changed`、`chat:changed`、`chat:created`、`chat:deleted`、`chat:renamed`、`generation:started`、`generation:streaming`、`generation:completed`、`generation:stopped`、`generation:ended`、`model:changed`、`settings:updated`。
ST 端 `forwarders/` 把 ST `eventSource` 内部事件转译为 bridge event；其中 `generation:streaming` 以 1s 节流推送。

### 5.5 Mirror State（pong 携带）

`STMirrorState = { userId, currentCharacterId, currentChatId, currentPresetName, generationPhase, messageCount, lastUpdatedAt }`。
壳端 `ping`，ST 端 `pong` 回完整快照（`buildMirrorState()` 从 `SillyTavern.getContext()` 读取），壳端经 `onPong` 写入 `stores/st-mirror`（zustand），组件用 `useSTMirror(selector)` 订阅。

### 5.6 错误码族（`errors.ts` / `BridgeError`）

`BRIDGE_PROTOCOL_*`（信封/版本/payload/超大/未知类型）、`BRIDGE_HANDSHAKE_*`（超时/用户不匹配/缺失/缓冲溢出）、`BRIDGE_CALL_*`（未知/不支持/phase 不可用/超时/payload 非法/重复 id）、`BRIDGE_EXEC_*`（ST 内部/目标不存在/前置失败/用户拒绝）、`BRIDGE_CONN_*`（iframe 不可用/已导航/断连）。

---

## 6. 业务执行模型（关键）

ST 在本项目的定位 **不是纯渲染容器，而是业务执行引擎**。角色切换 / 会话管理 / 消息生成都发生在 ST 内部状态机里。平台壳 = UI 入口 + 通过 bridge 触发 ST 内部动作 + 维护镜像供查询。

| 业务功能        | UI 入口                     | 业务执行                                                       | 持久化（写入真相）                             | 查询真相（镜像）                   |
| --------------- | --------------------------- | -------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------- |
| 大厅角色卡列表  | 自研                        | backend 读 `miniapp.characters`（Prisma，过滤 `enabled=true`） | Storage（PNG）+ `miniapp.characters`（元数据） | 同左                               |
| 切换角色        | 自研（`/tavern/[id]` 触发） | bridge `selectCharacter` ② → ST 切 active_character            | ST 文件系统 ④                                  | `st_users.user_st_settings`        |
| 切换 / 新建会话 | 自研侧边栏（规划中）        | bridge `openChat` / `newChat` ②                                | ST 文件系统 ④                                  | `st_users.user_st_chats`（⏳占位） |
| 删除/重命名会话 | 自研侧边栏（规划中）        | bridge `deleteChat` / `renameChat` ②                           | ST 文件系统 ④                                  | `st_users.user_st_chats`（⏳占位） |
| 模型切换        | 自研按钮                    | bridge `changeModel` ② → ST 改 settings                        | ST 文件系统 ④（settings.json）                 | `st_users.user_st_settings`        |
| 消息生成        | ST iframe 内                | ST 自己（LLM endpoint 指向平台代理网关 ①）                     | ST 文件系统 ④（chat 文件）                     | `st_users.user_st_chats`（⏳占位） |

**关键纪律**：

- **业务真相归属**：运行时真相 = ST 文件系统；业务可查询真相 = Supabase 同步层镜像（`st_users.*`）。平台壳读镜像，不读 ST 文件系统。
- **聊天记录回流 ⏳ 未实现**：watcher 当前 **仅** 回流 `settings.json` → `st_users.user_st_settings`（见 `watcher/uploader.ts`）。`user_st_chats` 表 + db-types 类型已就位，但 **registry.yaml 无 chats 规则、watcher 无 chat uploader**，属占位待补。
- **LLM 代理网关**：`backend/src/routes/llm-proxy.ts` 是一个 **独立的 OpenAI 兼容反向代理 + SSE 透传**，注入平台 API key 后转发上游（默认 OpenRouter）。**不**承担消息双写。
  - 【实测】当前 **未** 基于 `ai/ChannelRegistry` 实现；`src/ai/*`（ChannelRegistry / ModelStrategy / PipelineChannel）是阶段一遗留，与 LLM 网关无直接接线，待清理或重用。
  - 【实测】当前 **未** 做 userId/JWT 验证（dev 直接透传），仅校验 API key 是否配置。

---

## 7. 通道判定（代码审查直接对应）

### 通道 A — 纯自研平台

仅涉及：

- `packages/frontend` 中 **不** 涉及 `lib/bridge/`、`components/bridge/`、`stores/st-mirror.ts`、`platformAction()`、`/tavern/*` 路由的文件
- `packages/backend` 中 **不** 涉及鉴权桥（`routes/bridge.ts`）、ST 反代（`middleware/stProxy.ts`）、LLM 代理网关（`routes/llm-proxy.ts`）的文件（如 `routes/characters.ts` / `payment.ts` / `wallet.ts` / `settings.ts`）
- `packages/shared`
- `packages/sync-engine` 中 **不** 涉及 ST 文件系统读写或 ST 资源格式的代码（纯 queue / health / registry / config 工具）
- 仅链路 ① ⑥ ⑦

### 通道 B — 涉及 ST 桥接

涉及任一：

- `packages/bridge-protocol`
- `packages/st-extension`
- `vendor/sillytavern/` 任何文件变更（含 `NOTICE.md` commit hash 更新；其他文件直接修改 → 触发架构铁律拦截）
- `packages/frontend` 中 `lib/bridge/`、`components/bridge/`（`bridge-provider.tsx` / `st-iframe.tsx`）、`stores/st-mirror.ts`、`/tavern/*`
- `packages/backend` 中鉴权桥、ST 反代、LLM 代理网关
- `packages/sync-engine` 中涉及 ST 文件系统格式（`provisioner/*`、`watcher/uploader.ts`、`lib/st-fs.ts`、`registry.yaml`）
- `ops/nginx` 中 `/tavern/*` 或 `/api/*` 路由分发
- 任何涉及 postMessage、链路 ② ③ ⑤ 的代码

### 跨通道

diff 同时包含 A 和 B 范围，建议拆分独立提交。

---

## 8. 数据真相归属

| 数据类型                  | 权威源                                            | 镜像                        | 备注                                                  |
| ------------------------- | ------------------------------------------------- | --------------------------- | ----------------------------------------------------- |
| 用户身份                  | `public.users`（Prisma + Supabase 混用）          | —                           | TG 身份 + `st_handle` + `st_initialized_at`           |
| 角色卡 PNG                | Supabase Storage `character-assets` bucket        | —                           | provision 从 Storage 下载到 ST（`platform_<id>.png`） |
| 角色卡元数据              | `miniapp.characters`（Prisma）                    | —                           | backend 读取渲染大厅                                  |
| 预设                      | `st_platform.platform_presets`                    | —                           | provision order=20 下发                               |
| API key                   | `st_platform.platform_api_configs`（is_default）  | —                           | provision order=30 写 `secrets.json`                  |
| 平台管控 settings 段      | `st_platform.platform_settings`                   | —                           | provision order=100 merge 后写 settings.json          |
| 用户 settings 用户段      | ST 文件系统 settings.json（白名单子集）           | `st_users.user_st_settings` | watcher 回流（append-only + content_hash 去重）✅     |
| 用户聊天记录              | ST 文件系统 chats/                                | `st_users.user_st_chats`    | ⏳ 回流未实现（占位）                                 |
| 平台壳用户配置（UI 偏好） | `miniapp.miniapp_user_settings`（Prisma）         | —                           | `/api/users/settings`，与 ST 无关                     |
| 钱包 / 支付订单           | `miniapp.*`（wallet / payment_orders，Prisma）    | —                           | 阶段一业务，仍在运行                                  |
| 平台运行时配置            | `miniapp.runtime_config`（Prisma）+ Upstash Redis | —                           | feature flag、`system_fallback_character_id` 等       |

**Prisma vs db-types 边界（设计）**：Prisma 管理 `miniapp.*` + `public.*`；db-types 管理 `st_platform.*` / `st_users.*` / `st_infra.*`。
【实测】sync-engine 暂用 supabase-js 的 `.schema(...)` 字符串查询访问同步层，db-types 尚未实际接入。

---

## 9. 关键路由 / 接口清单（实测）

### 9.1 backend（Fastify, dev :3001 → `src/app.ts`）

| 方法/路径                               | 职责                                                                                                                                                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                           | 健康检查                                                                                                                                                                                                                                                        |
| `GET /api/characters` · `/:id`          | 大厅角色卡（Prisma `miniapp.characters`，`enabled=true`）                                                                                                                                                                                                       |
| `POST /api/bridge/st-session`           | **鉴权桥**：TG InitData → Supabase user(upsert) → 判断首登 → provision → ST `/api/users/login` 取 `connect.sid` → 返回 `{ st_url, st_cookie, is_new_user }`。新用户走 **三阶段 provision**（建账号 → 登录触发 ST content init → `force=true` 覆盖写平台文件）。 |
| `ALL /api/bridge/st/*`                  | **ST 反向代理**（`middleware/stProxy.ts`）：路径重写到 `ST_BASE_URL`，cookie/header/流式响应透传，`redirect: manual`                                                                                                                                            |
| `GET/PATCH /api/users/settings`         | 平台壳用户设置（`miniapp_user_settings`）                                                                                                                                                                                                                       |
| `POST /api/payment/*` · `/api/wallet/*` | 支付（JLPayment 网关）+ 钱包账本（阶段一业务保留）                                                                                                                                                                                                              |
| `ALL /api/platform/llm-proxy/v1/*`      | **LLM 代理网关**：注入平台 API key，转发上游（默认 OpenRouter），SSE 透传                                                                                                                                                                                       |

> 计划中的 `GET /api/platform/provision-status/:userId` **未实现**；历史侧边栏数据源（读 `st_users.user_st_chats`）随 chat 回流一并待补。

### 9.2 sync-engine provision-api（`provision-api/server.ts`, 127.0.0.1:9091）

| 方法/路径                                 | 职责                                         |
| ----------------------------------------- | -------------------------------------------- |
| `POST /provision/:userId`                 | 异步触发，立即返回 202，后台跑完整 provision |
| `POST /provision/:userId/sync?force=true` | 同步触发，等待完成返回 200（新用户首登用）   |
| `GET /health`                             | 健康检查                                     |

> 计划中的 `/provision/:userId/flush`、`/provision/:userId/status` **未实现**。

### 9.3 sync-engine watcher（`watcher/index.ts`, health :9090）

非 HTTP 业务服务。启动流程：`loadConfig` → 加载/校验 `registry.yaml` → 提取上行规则 → 扫描 `tg_*` 目录 → 构建 handle→userId 映射 → 启动队列 consumer（per-handle 串行）→ 启动 health server → chokidar 监听 `settings.json` 变更入队。consumer 调 `uploadSettings()` 执行白名单 pick → hash 去重 → append-only 写 `st_users.user_st_settings`。

### 9.4 ST 服务（vendor/sillytavern, dev :8000）

原生 200+ 路由，**零修改**。所有定制经 st-extension 在浏览器端注入。

---

## 10. provision 执行模型（`sync-engine/provisioner`）

`provision(userId, { force })` 严格按清单 order 执行：

1. `fetchProvisionData` — 从 Supabase 拉取 handle / characters / presets / platformSettings / apiConfig / userSettings
2. `ensureStUser` — 确保 ST 用户账号存在（ST API）
3. order=10 `writeCharacters` — 写角色卡 PNG（`platform_<id>.png`）
4. order=20 `writePresets` — 写预设 JSON（`OpenAI Settings/platform_<id>.json`）
5. order=30 `writeSecrets` — 写 `secrets.json`（默认 API 配置）
6. order=100 `mergeSettings` + `writeSettings` — merge 平台段(A) + 用户段(B) → `settings.json`，并对 `character_ref` 做失效校验 + 默认卡兜底
7. 更新 `users.st_initialized_at`

`force=false` 为增量补全（已存在文件跳过），`force=true` 全量覆盖。密码派生 `deriveUserPassword(handle)` 用 `ST_USER_PASSWORD_SECRET`（backend 与 sync-engine 必须一致）。

---

## 11. 部署单元

| 单元                      | 包                                       | 启动命令                                            | 平台              |
| ------------------------- | ---------------------------------------- | --------------------------------------------------- | ----------------- |
| 平台前端                  | `packages/frontend`                      | Vercel build                                        | Vercel CDN        |
| miniapp 后端              | `packages/backend`                       | `tsx src/server.ts`                                 | Railway           |
| sync-engine provision-api | `packages/sync-engine`                   | `start:provision`（`tsx src/provision-api/run.ts`） | Railway           |
| sync-engine watcher       | `packages/sync-engine`                   | `tsx src/watcher/run.ts`                            | Railway           |
| ST 服务                   | `vendor/sillytavern` + st-extension 产物 | `node server.js`                                    | Railway（Docker） |
| Nginx                     | `ops/nginx`                              | 标准启动                                            | Railway           |
| Supabase                  | 托管                                     | —                                                   | Supabase Cloud    |

---

## 12. 关键约束补充

### 12.1 角色卡字段语义

- `enabled`：是否上架（控制大厅展示 + provision 下发，唯一的上下架开关）
- `sort_order`：大厅展示顺序（数字越小越靠前）
- ~~`is_default`~~：**已删除**。系统兜底卡（`character_ref` 失效时的回退值）改由 `miniapp.runtime_config` 表的 `system_fallback_character_id` 配置。注意：这不是"用户默认角色"，用户进大厅主动选角色，感知不到此配置。
- ~~`is_published` / `is_active`~~：**已删除**。与 `enabled` 语义重复，统一使用 `enabled`。

### 12.2 环境变量

| 前缀 / 关键变量                                                | 用途                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `*_PROJECT_REF` | Supabase 连接与环境隔离                                        |
| `DATABASE_URL` / `DIRECT_URL`                                  | Prisma（backend）                                              |
| `ST_BASE_URL`                                                  | ST 服务地址（backend 登录 + 反代；sync-engine）                |
| `ST_PROVISION_URL`                                             | backend → sync-engine provision-api 地址                       |
| `ST_USER_PASSWORD_SECRET`                                      | 用户密码派生密钥（backend / sync-engine 必须一致）             |
| `ST_DATA_PATH`                                                 | sync-engine ST 文件系统路径                                    |
| `CHARACTER_STORAGE_BUCKET`                                     | Supabase Storage bucket（角色卡 PNG，默认 `character-assets`） |
| `HEALTH_PORT`(9090) / `PROVISION_API_PORT`(9091)               | sync-engine 端口                                               |
| `LLM_UPSTREAM_URL` / `LLM_API_KEY`                             | LLM 上游网关                                                   |
| `PAYMENT_*`                                                    | 支付网关                                                       |
| `TELEGRAM_BOT_TOKEN`                                           | TG InitData 签名校验                                           |
| `FRONTEND_URL` / `DEV_AUTH_BYPASS`                             | CORS / 开发放行                                                |

### 12.3 settings.json 分段

ST 原生不分段；由 sync-engine 的 `platform_settings.writable_paths` 白名单驱动：

- **平台管控段**：LLM endpoint、prompts、模板、默认采样参数等，provision 全平台下发。
- **用户可修改段**：白名单内字段（如 `active_character`、`oai_settings.prompts`），watcher 回流到 `st_users.user_st_settings`。

### 12.4 LLM 调用路径

ST 的 LLM endpoint 配置（通过 provision 写入 settings/secrets）指向 `…/api/platform/llm-proxy/v1/`。网关职责：持平台真实 key、转发上游、SSE 流式透传。**不**承担消息双写。

> 待补：网关侧 userId/JWT 验证与按用户限流（当前 dev 透传）。

---

## 13. 阶段 0～3 完成度矩阵

| 能力                                                           | 状态    | 位置                                                                         |
| -------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------- |
| 阶段 0 清场（删自研聊天表 + schema 迁移）                      | ✅      | `migrations/020_*`、`prisma/migrations/..._phase0_drop_sessions_*`           |
| 阶段 1 vendoring + 包脚手架                                    | ✅      | `vendor/sillytavern`、7 个 `packages/*`                                      |
| 阶段 2 SPIKE（ST 内部 API 验证）                               | ✅      | st-extension `forwarders/` + `mirror-state.ts`（`SillyTavern.getContext()`） |
| 阶段 3 bridge-protocol（actions/events/握手/错误码）           | ✅      | `packages/bridge-protocol`                                                   |
| 阶段 3 st-extension（server/handlers/forwarders/handshake）    | ✅      | `packages/st-extension`                                                      |
| 阶段 3 frontend lib/bridge（client/状态机/buffer/hooks/store） | ✅      | `frontend/src/lib/bridge` + `stores/st-mirror.ts`                            |
| 阶段 3 iframe 宿主（常驻挂载 + 可见性切换）                    | ✅      | `components/bridge/{bridge-provider,st-iframe}.tsx` + `providers.tsx`        |
| 鉴权桥 + ST 反代 + provision 触发                              | ✅      | `backend/routes/bridge.ts` + `middleware/stProxy.ts`                         |
| provision 下行（characters/presets/secrets/settings）          | ✅      | `sync-engine/provisioner`                                                    |
| watcher 上行 settings 回流                                     | ✅      | `sync-engine/watcher` + `queue`                                              |
| **聊天记录回流 `user_st_chats`**                               | ⏳ 占位 | 表/类型就位，registry+uploader 待补                                          |
| **LLM 网关 userId 验证 / 按用户计费**                          | ⏳ 待补 | `routes/llm-proxy.ts`                                                        |
| **db-types 实际接线**                                          | ⏳ 待补 | `packages/db-types`（已生成未消费）                                          |
| **api-contract 独立包**                                        | ❌ 未建 | 职责暂留 `shared/api`                                                        |
| **provision 状态查询 / flush**                                 | ❌ 未建 | provision-api 未实现对应端点                                                 |
| **自研工具栏 / 侧边栏（对话页 UI）**                           | ⏳ 占位 | `/tavern/[characterId]/page.tsx`（含 TODO）                                  |

---
