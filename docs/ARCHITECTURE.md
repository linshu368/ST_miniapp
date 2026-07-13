# ST_miniAPP 架构说明

> 本文档基于对 `packages/` 下核心源码的实测梳理（2026-07-13 复扫更新），反映 **MVP 上线后 + 冷启动优化专项（round 1~4）+ CS 运营平台/增长归因落地后** 的实际架构。
> 相比上一版（2026-06-29），本轮主要增量：
> ① 部署切换为 **方案 Y**（Vercel 前端 + Railway nginx 内部网关 + st-bundle 单容器三进程）；
> ② **iframe 冷启动优化专项**：角色卡懒下发、bridge 多层看门狗/自动重连、隐藏预热、开屏进度反馈、**首次受控修改 vendor**（firstLoadInit 并行化）；
> ③ 新包 **`cs-platform`**（蜜镜AI运营平台：CS 回访工作台 + 渠道归因）+ backend 新路由组（bot / cs / growth / models / wishes）；
> ④ 用户身份迁移至 **`miniapp.users`**（与旧 bot 的 `public.users` 隔离）；LLM 网关计费改由 `runtime_config` 驱动（当前扣费率 0、余额预检临时关闭）；
> ⑤ shared migrations 编号推进至 **030**（新增 chat_history 的 user_character_round 轮次统计）。
>
> 文中凡涉及"计划 vs 实测"差异处，均以 **【实测】** / **【占位】** / **【未接线】** 标注。

---

## 1. 架构铁律（违反即拦截）

1. **ST 原生代码原则上不可修改**：`vendor/sillytavern/` 视为只读 third-party 代码，锁定 commit `51ad27fb`（vendored 2026-06-23，永不升级）。所有 ST 定制优先通过：
   - 行为定制 → `packages/st-extension`（构建产物注入 ST 扩展机制）
   - 视觉定制 → 外挂 `user.css`
   - 配置定制 → ST 自身 `config.yaml` / 环境变量 / provision 下发的 `settings.json`
   - 【实测·例外已放开】**受控本地补丁**：仅限冷启动优化，要求最小 diff、逐行 `[miniapp-patch]` 注释标记、在 `vendor/sillytavern/NOTICE.md` 登记（含回滚文档）。当前仅 1 处：`public/script.js` 的 `firstLoadInit` 前后段串行网络调用 `Promise.all` 并行化（见 `docs/iframe-boot-firstloadinit-parallelization.md`）。审计命令：`rg "\[miniapp-patch\]" vendor/sillytavern/`。**未登记的 vendor 修改一律拦截。**

2. **跨进程通信走契约层**：postMessage 走 `bridge-protocol`，REST 走共享契约（`@miniapp/shared/src/api/*`，12 个契约文件），DB 同步层类型走 `db-types`。禁止应用包内重复定义协议字段。
   - 【实测】独立 `api-contract` 包仍未拆出，职责留在 `shared/api`。
   - 【实测】`db-types` 仍是"已生成未接线"：全仓库无任何运行时包 import（仅 ESLint 守卫测试引用）。生成范围只覆盖 `st_platform` / `st_users` / `st_infra`，不含 `miniapp` / `cs_platform` / `growth`。

3. **应用包互不 import**：`frontend` / `backend` / `sync-engine` / `st-extension` / `cs-platform` 之间无 import 关系，跨进程一律走 HTTP 或 postMessage。

4. **DB 类型不进前端**：`frontend` / `cs-platform` 禁止 import `db-types`；REST 契约（shared/api）禁止 import `db-types`。

5. **Bridge 不走业务组件直接 postMessage**：所有 postMessage 收发统一经 `frontend/src/lib/bridge/`（`BridgeClient` 单例），业务组件只调 `platformAction()` / `useSTEvent()` / `useSTMirror()` / `useBridgeStatus()`。

6. **环境变量入口校验**：进程启动时校验所需 env。
   - 【实测】`sync-engine` 用 zod `loadConfig()` 严格 fail-fast；`backend/src/platform/config.ts` 仍以 `process.env || 默认值` 形式宽松读取（仅 `createDatabaseConfig` 部分严格），待收敛为统一 zod 校验。

---

## 2. 架构总览图（实测）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 用户 (Telegram WebView)                     运营 (内部)                        │
│ ┌────────────────────────────────────────┐ ┌────────────────────────────┐    │
│ │ packages/frontend (Next.js, Vercel)     │ │ packages/cs-platform        │    │
│ │  Providers → BridgeProvider →           │ │ (React+Vite, Vercel, :3002) │    │
│ │  { 业务路由 + <STIframe/> 常驻挂载 }     │ │  回访工作台 / 渠道归因       │    │
│ │                                          │ │  X-CS-Admin-Token           │    │
│ │ ┌──────────────────┐ ┌───────────────┐  │ └──────────┬─────────────────┘    │
│ │ │ React 组件树      │ │ <STIframe>     │  │            │ /api/cs/* /api/growth│
│ │ │ ├ (main) 大厅/我的│ │ src="/tavern/" │  │            │                      │
│ │ │ │ /充值/许愿池    │ │ 常驻挂载        │  │            │                      │
│ │ │ ├ /tavern/[id]   │◄┤ 隐藏态=全尺寸   │  │            │                      │
│ │ │ │ (对话壳页)      │ │ 真实渲染+负z遮罩│  │            │                      │
│ │ │ └ ChatSplash 开屏 │ │ ST原生(受控补丁)│  │            │                      │
│ │ └────────┬─────────┘ │ +st-extension  │  │            │                      │
│ │          │postMessage └───────────────┘  │            │                      │
│ │ ┌────────▼────────────────────────────┐  │            │                      │
│ │ │ lib/bridge: BridgeClient(单例)       │  │            │                      │
│ │ │  状态机 + 缓冲 + 2.5s ping           │  │            │                      │
│ │ │  5 层看门狗 + 退避自动重连(≤3次)      │  │            │                      │
│ │ │  → stores/st-mirror (zustand)        │  │            │                      │
│ │ └─────────────────────────────────────┘  │            │                      │
│ └────────────────────┬─────────────────────┘            │                      │
└──────────────────────┼──────────────────────────────────┼──────────────────────┘
                       │ Vercel rewrites（方案 Y）          │
                       ▼                                   │
        ┌──────────────────────────────┐                   │
        │ Railway nginx（唯一对外服务）  │◄──────────────────┘
        │ /tavern/*、/api/* 内部分发     │      Telegram Bot webhook
        └──────┬────────────────┬──────┘      /api/telegram/webhook 等
               │                │                    │
     /api/(bridge|users|        │ /tavern/* + ST原生 /api/*
      wallet|payment|platform…) │
               ▼                ▼
┌───────────────────────────┐ ┌─────────────────────────────────────────┐
│ backend (Fastify, Railway  │ │ st-bundle 单容器 (Railway, s6-overlay)   │
│ 服务名 stminiapp, :8080)   │ │ ┌─────────────────────────────────────┐ │
│                            │ │ │ 进程1 ST vendor/sillytavern (:8000)  │ │
│ ├ 鉴权桥 /api/bridge/*     │ │ │  原生200+路由 + st-extension注入     │ │
│ │  (老用户先登录放行,       ├─►│ │  + JS-Slash-Runner(酒馆助手)        │ │
│ │   provision后台异步)      │ │ └───────────────┬─────────────────────┘ │
│ ├ ST反代 /api/bridge/st/*  │ │                 │ 文件系统读写           │
│ ├ 业务 characters/settings │ │ ┌───────────────▼─────────────────────┐ │
│ │  /wallet/payment/wishes  │ │ │ ST data 目录 data/<st_handle>/       │ │
│ ├ 历史 /api/users/chats    │ │ │  chats/ characters/ secrets.json     │ │
│ ├ LLM网关 /api/platform/   │ │ │  settings.json OpenAI Settings/      │ │
│ │  llm-proxy/v1 (JWT验签+  │ │ └───────▲──────────────┬──────────────┘ │
│ │  chat_history落库,        │ │         │写文件         │chokidar        │
│ │  扣费率当前=0)            │ │ ┌───────┴────────┐ ┌───▼────────────┐  │
│ ├ CS /api/cs/*             │ │ │进程2 provision- │ │进程3 watcher    │  │
│ ├ 增长 /api/growth/*       ├─►│ │api (:9091,内网) │ │(queue+health    │  │
│ └ Bot /api/telegram/webhook│ │ └───────┬────────┘ │ :9090)          │  │
│                            │ │         │supabase-js└───┬────────────┘  │
└──┬──────────┬──────────────┘ └─────────┼───────────────┼───────────────┘
   │ Prisma   │ Supabase client          │               │
   ▼          ▼                          ▼               ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Supabase (PostgreSQL + Storage + Realtime)                              │
│  ├ public.*      旧 bot 用户体系（与 miniapp 隔离，仍在运行）             │
│  ├ miniapp.*     users(新身份) / characters / chat_history /            │
│  │               user_wallets / payment_orders / runtime_config / 许愿  │
│  ├ st_platform.* platform_settings / platform_presets / api_configs     │
│  ├ st_users.*    user_st_settings ✅ / user_st_chats ⏳占位             │
│  ├ st_infra.*    sync_tasks                                             │
│  ├ cs_platform.* personas / outreach_sessions / outreach_messages /     │
│  │               审计与导出日志 + user_metrics 视图                      │
│  └ growth.*      channel_links / link_clicks / miniapp_entries          │
│  Storage: characters/ 角色卡 PNG                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 链路编号定义

| 编号 | 方向                               | 用途                                                                    | 实现状态                         |
| ---- | ---------------------------------- | ----------------------------------------------------------------------- | -------------------------------- |
| ①    | frontend → backend (HTTP)          | 业务 REST：角色卡、用户设置、支付/钱包、许愿、模型档位、LLM 代理调用    | ✅ 已建                          |
| ②    | frontend → ST iframe (postMessage) | bridge action：切角色（含单卡增量注入）/ 切 chat / 改模型 / 删除·重命名 | ✅ 已建                          |
| ③    | ST iframe → frontend (postMessage) | bridge event / handshake / pong(mirror state)                           | ✅ 已建                          |
| ④    | ST → 文件系统                      | ST 原生持久化（chat 文件、settings.json）；用户运行时真相写入路径       | ✅ 原生                          |
| ⑤    | backend → sync-engine (HTTP)       | provision 触发（同步/异步/单卡懒下发），走 Railway 内网直连 :9091       | ✅ 已建                          |
| ⑥    | sync-engine ⇆ Supabase + 文件系统  | provision 下行 + watcher 上行（settings 回流）                          | ✅ settings 已建 / ⏳ chats 占位 |
| ⑦    | frontend → Supabase（仅只读）      | 角色卡 PNG 等只读浏览；禁止前端直写                                     | ✅ 约定                          |
| ⑧    | cs-platform → backend (HTTP)       | CS 工作台 REST（`/api/cs/*`、`/api/cs/growth/*`），`X-CS-Admin-Token`   | ✅ 已建                          |
| ⑨    | Telegram → backend (webhook)       | Bot `/start` 归因 + 用户回复回流 CS（`/api/telegram/webhook` 等）       | ✅ 已建                          |

> 链路 ⑤ 现状：backend 调用 `POST /provision/:userId?cards=none`（异步 202）、`POST /provision/:userId/sync?cards=none[&force=true]`（同步）、`POST /provision/:userId/character/:characterId/sync`（单卡懒下发）。计划中的 `/status`、`/flush` 端点仍未实现。

---

## 4. 包清单（实测）

### 4.1 契约层（纯类型 / 协议）

| 包                | 职责                                                                                                                                                                                                                                                                                                                  | 消费者                     | 状态                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------- |
| `bridge-protocol` | postMessage 完整契约：envelope / 两段握手 / 23 个错误码 / mirror state / 7 actions / 13 events / parser / BridgeError                                                                                                                                                                                                 | `frontend`, `st-extension` | ✅ 完整落地（本轮无变化）              |
| `shared`          | 跨包常量与纯工具：`deriveStHandle`、`createDatabaseConfig`、REST API 契约 12 文件（envelope / characters / chats / settings / payment / wallet / wishes / models / st-session / health / **cs-platform** / **growth**）、`png-parser`（仅类型）、dev-fixtures；`migrations/`（Supabase SQL，**001~029**，含两个 021） | 所有包                     | ✅ 已建（同时承担 REST 契约职责）      |
| `db-types`        | Supabase 同步层 schema 镜像（机器生成，仅 `st_platform`/`st_users`/`st_infra` 共 6 表）                                                                                                                                                                                                                               | —                          | ⚠️ **已生成、仍未接线**                |
| `api-contract`    | 计划中的独立 REST 契约包                                                                                                                                                                                                                                                                                              | —                          | ❌ **未创建**（职责暂留 `shared/api`） |

### 4.2 应用层（运行时）

| 包             | 职责                                                                                                                                                                                        | dev 端口        | 部署                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `frontend`     | 平台壳 Next.js（App Router）：大厅 / 我的 / 充值 / 许愿池 + `lib/bridge`（含 5 层看门狗）+ 常驻 ST iframe 宿主                                                                              | 3000            | Vercel                                                                                    |
| `backend`      | Fastify：鉴权桥 + ST 反代 + 业务 REST + LLM 代理网关 + CS 工作台 API + 增长归因 + Telegram Bot webhook                                                                                      | 3001            | Railway（服务名 `stminiapp`，容器内 :8080）                                               |
| `sync-engine`  | 双进程：`provision-api`（:9091，含单卡懒下发端点）+ `watcher`（chokidar + 队列 + health :9090）                                                                                             | 9091 / 9090     | Railway（**随 st-bundle 单容器**，s6-overlay 编排，不再是独立服务）                       |
| `st-extension` | IIFE 注入 ST：bridge 服务端 + 7 handlers + 11 个事件转发 + **15 个 patches**                                                                                                                | —（随 ST 加载） | 构建产物拷贝到 `vendor/sillytavern/public/scripts/extensions/third-party/miniapp-bridge/` |
| `cs-platform`  | **蜜镜AI运营平台**（内部）：CS 回访工作台（画像簇 / Telegram 1V1 SOP / Excel 导出）+ 渠道归因面板。React 18 + Vite，单页无路由（`useState` 切模块），只 fetch backend REST，不直连 Supabase | 3002            | Vercel（独立项目，默认 `https://st-cs-platform.vercel.app`）                              |

### 4.3 vendor / ops

| 路径                  | 性质                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vendor/sillytavern/` | vendored ST，锁 commit `51ad27fb`。**只读 + 受控例外**：`[miniapp-patch]` 标记的补丁须登记 `NOTICE.md`（当前仅 script.js firstLoadInit 并行化）       |
| `ops/nginx/`          | 生产模板 `nginx.conf`（方案 Y：仅 ST + backend 内部分发，`location /` 返 404）+ 本地仿真 `nginx.local.conf`（含 frontend upstream）+ 静态资源缓存分档 |
| `ops/docker/`         | 4 个 Dockerfile：backend / st-bundle（多阶段 + s6-overlay）/ frontend（仅 staging）+ nginx（在 `ops/nginx/`）                                         |
| `ops/sillytavern/`    | `config.production.yaml`：`listen: true`、`protocol.ipv6: true`、**`performance.lazyLoadCharacters: true`**（boot 只拉浅层角色列表）                  |
| `ops/st-extensions/`  | 第三方扩展运行产物快照，当前仅 `JS-Slash-Runner`（酒馆助手 v4.8.7）；经 `scripts/install-st-extension.mjs` 幂等安装进 vendor                          |
| `ops/env/`            | 4 份生产 env 模板（vercel / backend / st-bundle / nginx）；跨服务必须一致的密钥：`ST_USER_PASSWORD_SECRET`、`LLM_PROXY_TOKEN_SECRET`                  |
| `ops/s6/`             | st-bundle 容器内进程编排：ST(:8000) + provision-api(:9091) + watcher(:9090)                                                                           |
| `.railway/railway.ts` | Railway IaC（需 `railway config apply` 生效）：st-bundle / stminiapp / nginx 三服务 + 数据卷；prod 服务名 `st-bundle-pro` / `nginx-pro`               |

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
  cs-platform  ──► shared

禁止：
  ✗ frontend / cs-platform → db-types
  ✗ 应用包 → 应用包（跨进程走 HTTP / postMessage）
  ✗ 契约层 → 应用包
  ✗ 任何 import 环
```

---

## 5. Bridge 协议详解（`bridge-protocol` + 两端实现）

### 5.1 信封与消息类型

- 通道常量：`BRIDGE_CHANNEL = 'miniapp-bridge'`，`PROTOCOL_VERSION = 1`。
- 信封 `BridgeEnvelope`：`{ channel, protocolVersion, type, timestamp }`，每条消息都 zod 校验。
- 6 种消息类型：`request` / `response` / `event` / `handshake` / `ping` / `pong`。
- 大小限制：32KB 拦截、4KB 警告（`limits.ts`）。

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

- 状态机（`state-machine.ts`）：`idle → loading → handshaked → ready`，任意态可 `→ disconnected`，且 `disconnected → loading`（重连）。
- 超时：单次 action 30s；首次握手总超时 60s；重连后握手总超时 30s。
- 请求缓冲（`buffer.ts`）：握手完成前对 `waitable` 的 action 入队（上限 32），到达对应 phase 后按序 flush。
- 【实测】`BridgeProvider` 未传 `expectedUserId`（默认 null，握手不做用户绑定校验）。

### 5.3 看门狗与自动重连（壳端安全网，冷启动专项产物）

握手超时不再一次性 disconnect，而是**退避自动重连（最多 3 次，2s/4s/8s）**，重连方式为 `iframe.src = iframe.src` 强制 reload。共 5 层安全网（`frontend/src/lib/bridge/bridge-client.ts`）：

| #   | 看门狗            | 默认阈值            | 触发条件                                                        |
| --- | ----------------- | ------------------- | --------------------------------------------------------------- |
| 1   | Action RPC 超时   | 30s                 | 单次 request 无 response → reject `BRIDGE_CALL_TIMEOUT`         |
| 2   | 握手总超时        | 首次 60s / 重连 30s | 未到 `ready` → 退避重连；额度耗尽（≥3 次）才终态 disconnect     |
| 3   | iframe 加载看门狗 | 15s                 | iframe `load` 事件未触发 → 走重连                               |
| 4   | 握手到达看门狗    | 30s                 | 未收到任意 handshake 消息 → 走重连                              |
| 5   | 点卡即检停摆重载  | 10s                 | 用户进入 `/tavern/*` 时若仍 `loading` 且 boot 已超阈 → 立即重载 |

`ready` 后启动 **2.5s ping 轮询**，`onPong` 把 `STMirrorState` 写入 `stores/st-mirror`（zustand）——这是模型档位高亮与历史当前对话高亮的数据来源。

【实测·已清理】冷启动全链路 debug 埋点（frontend `iframe-timing.ts`、st-extension `debug-*.ts`、backend `routes/debug.ts` 及全部调用点）已于 2026-07-13 整体移除。

### 5.4 Actions（壳 → ST，7 个）

`selectCharacter` / `openChat` / `newChat` / `renameChat` / `deleteChat` / `changeModel` / `getReadyState`。
每个 action 在 `actions/<name>.ts` 定义 `ActionMeta { name, payloadSchema, resultSchema, requiredPhase, waitable }`，统一汇入 `actionRegistry`。ST 端 `bridge-server` 收到 `request` 后：校验信封 → 校验 phase → zod 校验 payload → 查 handler → 执行 → 回 `response`。

- **【实测】selectCharacter 单卡增量注入**（配合懒下发）：handler 先在内存 `ctx.characters` 按 avatar 查找；未命中则 `POST /api/characters/get` 拉单卡 push 进内存（替代全量重扫，兜底最多 3 次 `getCharacters()` 全量重载）；选卡前依次调用正则/预设正则/世界书的预授权；支持 `forceNewChat`（平台从大厅进卡固定新开对话）。
- **【实测】跨角色历史聊天**：`openChat` / `renameChat` 的 payload 含可选 `avatar`；与当前角色不同时先 `selectCharacterById` 再 open/rename。
- **【实测】changeModel 写 custom_model**：平台 ST 固定 `chat_completion_source='custom'`，handler 写 `oai_settings.custom_model` + 手动 emit `CHATCOMPLETION_MODEL_CHANGED`。

### 5.5 Events（ST → 壳）

协议定义 **13 个**：`app:ready`、`character:changed`、`chat:changed`、`chat:created`、`chat:deleted`、`chat:renamed`、`generation:started`、`generation:streaming`、`generation:completed`、`generation:stopped`、`generation:ended`、`model:changed`、`settings:updated`。

【实测】st-extension `forwarders/` 实际 `sendEvent` 转发 **11 个**：`app:ready` 由握手的 `sendHandshake('ready')` 承担（非 event）；**`character:changed` 无任何转发实现**（协议定义了但 ST 端未接）。`generation:streaming` 以 1s 节流推送。

### 5.6 Mirror State（pong 携带）

`STMirrorState = { userId, currentCharacterId, currentChatId, currentPresetName, currentModel, generationPhase, messageCount, lastUpdatedAt }`。
壳端 `ping`，ST 端 `pong` 回完整快照（`buildMirrorState()` 从 `SillyTavern.getContext()` 读取），壳端经 `onPong` 写入 `stores/st-mirror`，组件用 `useSTMirror(selector)` 订阅。

### 5.7 错误码族（`errors.ts` / `BridgeError`，共 23 个）

`BRIDGE_PROTOCOL_*`（5：信封/版本/payload/超大/未知类型）、`BRIDGE_HANDSHAKE_*`（5：超时/总超时/用户不匹配/缺失/缓冲溢出）、`BRIDGE_CALL_*`（6：未知/不支持/phase 不可用/超时/payload 非法/重复 id）、`BRIDGE_EXEC_*`（4：ST 内部/目标不存在/前置失败/用户拒绝）、`BRIDGE_CONN_*`（3：iframe 不可用/已导航/断连）。

---

## 6. 业务执行模型（关键）

ST 在本项目的定位 **不是纯渲染容器，而是业务执行引擎**。角色切换 / 会话管理 / 消息生成都发生在 ST 内部状态机里。平台壳 = UI 入口 + 通过 bridge 触发 ST 内部动作 + 维护镜像供查询。

| 业务功能        | UI 入口                                | 业务执行                                                                                            | 持久化（写入真相）                             | 查询真相（镜像）                                          |
| --------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| 大厅角色卡列表  | 自研 `CharacterGallery`                | backend 读 `miniapp.characters`（Prisma，`enabled=true`）                                           | Storage（PNG）+ `miniapp.characters`（元数据） | 同左                                                      |
| 切换角色        | 自研（`/tavern/[id]` 触发）            | 浮层打开即预取懒下发（`prefetchEnsureStCharacter`）→ bridge `selectCharacter`（含 `forceNewChat`）② | ST 文件系统 ④                                  | `st_users.user_st_settings`                               |
| 切换 / 新建会话 | 自研侧边栏 + 工具菜单                  | bridge `openChat` / `newChat` ②                                                                     | ST 文件系统 ④                                  | 列表反代 ST `/api/chats/recent`（`user_st_chats` ⏳占位） |
| 删除/重命名会话 | 自研侧边栏（`chat-sidebar.tsx`）       | bridge `deleteChat` / `renameChat` ②                                                                | ST 文件系统 ④                                  | 列表反代 ST `/api/chats/recent`（`user_st_chats` ⏳占位） |
| 模型切换        | 自研工具菜单二级面板（乐观更新）       | bridge `changeModel` ② → ST 改 settings                                                             | ST 文件系统 ④（settings.json）                 | `st_users.user_st_settings` + mirror `currentModel`       |
| 消息生成        | ST iframe 内                           | ST 自己（LLM endpoint 指向平台代理网关 ①）                                                          | ST 文件系统 ④（chat 文件）                     | `miniapp.chat_history`（LLM 网关落库）                    |
| 开屏体验        | 自研 `ChatSplash`（伪进度 + 阶段文案） | 订阅 bridge 状态；ready 前焦点守卫拦截 iframe 内输入抢键盘                                          | —                                              | —                                                         |

**关键纪律**：

- **业务真相归属**：运行时真相 = ST 文件系统；业务可查询真相 = Supabase 同步层镜像（`st_users.*`）。平台壳读镜像，不读 ST 文件系统。
- **历史聊天列表**：壳端读 backend `GET /api/users/chats`（`routes/chats.ts`），后者反代 ST `POST /api/chats/recent`（跨角色聚合 max=200，ST cookie 走 Upstash Redis 缓存 + 401/403 自动重登），把 `platform_<uuid>.png` 映射回 `miniapp.characters` 元数据。**这仍是历史列表的真相源**（非 `user_st_chats` 镜像）。
- **聊天记录回流 ⏳ 仍未实现**：watcher 仅回流 `settings.json` → `st_users.user_st_settings`。`user_st_chats` 表已就位，但 registry.yaml 无 chats 规则、watcher 无 chat uploader。
- **LLM 代理网关**（`backend/src/routes/llm-proxy.ts`，独立 OpenAI 兼容反代 + SSE 透传）：
  - 【实测】**JWT 验签仍在**：`requirePlatformToken` 校验 `Authorization: Bearer <platformToken>`（HS256，无 exp）→ 提取 `userId`。token 由 provision 写入每用户 `secrets.json`（键恒为 `api_key_custom`，替代真实 key）。
  - 【实测】**计费当前实质关闭**：余额预检整段注释（允许 0 积分用户调用）；扣费逻辑保留但仅在 `deductionRate > 0` 时执行，而 tiers 默认扣费率为 **0**。
  - 【实测】**model-tiers 已改为 runtime_config 驱动**：从 `miniapp.runtime_config` 键 `llm_model_tiers` 读取（5 分钟内存缓存），代码内 fallback 两档模型（默认 `google/gemini-3.1-flash-lite`，备选 `anthropic/claude-sonnet-4.5`），不再硬编码 standard=10/premium=15。
  - 【实测】**新增 chat_history 落库**：SSE 正常结束/上游错误/流中断均 fire-and-forget 写 `miniapp.chat_history`（`lib/chat-history-logger.ts`，成功后 RPC 递增 `total_round`）。**不**承担消息双写（指 ST chat 文件）。
  - 【实测·已清理】阶段一遗留的 `src/ai/*`（ChannelRegistry / ModelStrategy / PipelineChannel）、`features/chat/domain/billingRules.ts`、`services/RuntimeConfigService.ts` 均无接线，已于 2026-07-13 删除。

---

## 7. 通道判定（代码审查直接对应）

### 通道 A — 纯自研平台

仅涉及：

- `packages/frontend` 中 **不** 涉及 `lib/bridge/`、`components/bridge/`、`stores/st-mirror.ts`、`platformAction()`、`/tavern/*` 路由的文件
- `packages/backend` 中 **不** 涉及鉴权桥（`routes/bridge.ts`）、ST 反代（`middleware/stProxy.ts`）、历史聊天反代（`routes/chats.ts`）、LLM 代理网关（`routes/llm-proxy.ts`）的文件（如 `routes/characters.ts` / `payment.ts` / `wallet.ts` / `settings.ts` / `wishes.ts` / `bot.ts` / `cs-platform.ts` / `growth.ts`）
- `packages/cs-platform`（整包，纯 REST 消费者）
- `packages/shared`
- `packages/sync-engine` 中 **不** 涉及 ST 文件系统读写或 ST 资源格式的代码（纯 queue / health / registry / config 工具）
- 仅链路 ① ⑥ ⑦ ⑧ ⑨

### 通道 B — 涉及 ST 桥接

涉及任一：

- `packages/bridge-protocol`
- `packages/st-extension`
- `vendor/sillytavern/` 任何文件变更（**受控补丁须同步更新 `NOTICE.md` 登记，否则触发架构铁律拦截**）
- `packages/frontend` 中 `lib/bridge/`、`components/bridge/`（`bridge-provider.tsx` / `st-iframe.tsx`）、`stores/st-mirror.ts`、`/tavern/*`
- `packages/backend` 中鉴权桥（`routes/bridge.ts`，含懒下发端点）、ST 反代（`middleware/stProxy.ts`）、历史聊天反代（`routes/chats.ts`）、LLM 代理网关（`routes/llm-proxy.ts`）
- `packages/sync-engine` 中涉及 ST 文件系统格式（`provisioner/*`、`watcher/uploader.ts`、`lib/st-fs.ts`、`registry.yaml`）
- `ops/nginx` 中 `/tavern/*` 或 `/api/*` 路由分发、静态资源缓存分档；`ops/sillytavern/config.production.yaml`；`ops/st-extensions/`
- 任何涉及 postMessage、链路 ② ③ ⑤ 的代码

### 跨通道

diff 同时包含 A 和 B 范围，建议拆分独立提交。

---

## 8. 数据真相归属

| 数据类型                  | 权威源                                                                             | 镜像                        | 备注                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| 用户身份（MiniApp）       | **`miniapp.users`**（migration 028）                                               | —                           | TG 身份 + `st_handle` / `st_initialized_at` / `bot_entered_at` / `source_id`；**不再写 `public.users`** |
| 用户身份（旧 Bot）        | `public.users` 及 `bot_*` 表                                                       | —                           | 旧 bot 体系，与 miniapp 隔离，仍在运行                                                                  |
| 角色卡 PNG                | Supabase Storage `character-assets` bucket                                         | —                           | provision 按需下载到 ST（`platform_<id>.png`，懒下发）                                                  |
| 角色卡元数据              | `miniapp.characters`（Prisma）                                                     | —                           | backend 读取渲染大厅（seeded shuffle 排序）                                                             |
| 预设                      | `st_platform.platform_presets`                                                     | —                           | provision order=20 下发 + merge 前 `applyActivePreset()`                                                |
| API key                   | `st_platform.platform_api_configs`（is_default）                                   | —                           | provision order=30 写 `secrets.json` 的 `api_key_custom`（per-user JWT，非真实 key）                    |
| 平台管控 settings 段      | `st_platform.platform_settings`                                                    | —                           | provision order=100 merge 后写 settings.json                                                            |
| 用户 settings 用户段      | ST 文件系统 settings.json（白名单子集）                                            | `st_users.user_st_settings` | watcher 回流（append-only + content_hash 去重，3s 防抖）✅                                              |
| 用户聊天记录              | ST 文件系统 chats/                                                                 | `st_users.user_st_chats`    | ⏳ 回流未实现（占位）                                                                                   |
| LLM 交互日志              | `miniapp.chat_history`（migration 026）                                            | —                           | LLM 网关异步落库；CS `user_metrics` 视图 JOIN 取最后活跃                                                |
| 平台壳用户配置（UI 偏好） | `miniapp.miniapp_user_settings`（Prisma）                                          | —                           | `/api/users/settings`；同时是 TG persona（显示名/头像）注入 provision 的数据源                          |
| 钱包 / 支付订单 / 签到    | `miniapp.*`（user_wallets / payment_orders / daily_checkins，Prisma）              | —                           | 含 `wallet_ledger` 账本、`chat_message_charges` 幂等记录                                                |
| 许愿池                    | `miniapp.wish_roles` / `wish_role_sessions`                                        | —                           | 每日一次，`pagehide` 自动补全                                                                           |
| 平台运行时配置            | `miniapp.runtime_config`（Prisma）+ Upstash Redis                                  | —                           | `llm_model_tiers`（模型档位+扣费率+默认模型）、`system_fallback_character_id` 等                        |
| CS 回访数据               | `cs_platform.*`（personas / outreach_sessions / outreach_messages / 审计导出日志） | —                           | Prisma raw SQL 访问（不在 Prisma schema 声明）；`user_metrics` / `persona_users_detail` 视图供工作台    |
| 渠道归因                  | `growth.*`（channel_links / link_clicks / miniapp_entries，migration 029）         | —                           | `/api/growth/click/:sourceId` 重定向 + `/api/growth/miniapp-entry` 上报                                 |

**Prisma vs Supabase client 边界（实测）**：Prisma schema 只声明 `miniapp.*` + `public.*`（且 `chat_history` / `miniapp.users` 等新表由 SQL 迁移管理、部分经 raw SQL / supabase-js 访问）；`st_platform.*` / `st_users.*` / `st_infra.*` / `cs_platform.*` / `growth.*` 均走 supabase-js 或 raw SQL。db-types 仍未接线。

---

## 9. 关键路由 / 接口清单（实测）

### 9.1 backend（Fastify, dev :3001 / prod :8080 → `src/app.ts`）

CORS 允许 `FRONTEND_URL` + `CS_PLATFORM_URL`（非 prod 额外放行 `*.vercel.app` / localhost）。

| 方法/路径                                      | 职责                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                  | 健康检查                                                                                                                                                                                                                                                                                      |
| `GET /api/characters` · `/:id`                 | 大厅角色卡（Prisma `miniapp.characters`，`enabled=true`，按环境窗口 seeded shuffle）                                                                                                                                                                                                          |
| `POST /api/bridge/st-session`                  | **鉴权桥**：TG InitData → `miniapp.users` upsert → 分流：**新用户**三阶段同步 provision（建号 → 登录触发 ST content init → `force=true` 覆盖写，全程 `cards=none`）；**老用户**先 `loginToSt` 拿 cookie 立即放行，provision 转后台异步（不 await）。返回 `{ st_url, st_cookie, is_new_user }` |
| `POST /api/bridge/st-character/:characterId`   | **单卡懒下发**：转调 sync-engine `POST /provision/:userId/character/:characterId/sync`（进对话前 ensure）                                                                                                                                                                                     |
| `ALL /api/bridge/st/*`                         | **ST 反向代理**（`middleware/stProxy.ts`）：路径重写到 `ST_BASE_URL`，cookie/header/流式透传                                                                                                                                                                                                  |
| `GET/PATCH /api/users/settings`                | 平台壳用户设置（`miniapp_user_settings`，含 TG persona 字段）                                                                                                                                                                                                                                 |
| `GET /api/users/chats`                         | **历史聊天列表**：反代 ST `POST /api/chats/recent`（cookie 走 Redis 缓存），跨角色聚合，avatar→角色元数据映射                                                                                                                                                                                 |
| `GET /api/platform/models`                     | 模型档位列表（`platform/model-tiers.ts` ← `runtime_config.llm_model_tiers`）                                                                                                                                                                                                                  |
| `ALL /api/platform/llm-proxy/v1/*`             | **LLM 代理网关**：JWT 验签 → 转发上游（注入平台真实 key）→ SSE 透传 → 异步写 `chat_history`；余额预检已注释、默认扣费率 0（见 §6）                                                                                                                                                            |
| `POST /api/payment/*` · `GET /api/wallet/*` 等 | 支付（JLPay，含 webhook/return 页）+ 钱包余额 + 每日签到                                                                                                                                                                                                                                      |
| `GET/POST /api/wishes*`                        | 许愿池（状态 / 提交 / 补全，24h 限次）                                                                                                                                                                                                                                                        |
| `POST /api/internal/bot/start`                 | Bot 进程内部调用（`X-Bot-Internal-Secret`）：记录 `/start` 进入（`bot_entered_at` + `source_id`）                                                                                                                                                                                             |
| `POST /api/telegram/webhook`                   | Telegram webhook：`/start [payload]` → 归因；其他文本 → **CS 用户回复回流**（写 `cs_platform.outreach_messages`）                                                                                                                                                                             |
| `/api/cs/*`（17 个端点）                       | **CS 工作台 API**（`X-CS-Admin-Token`）：画像簇 CRUD/refresh、簇内用户、回访 session（advance/snooze/skip）、消息收发/重试、XLSX 导出、审计日志、CS 专用 TG webhook                                                                                                                           |
| `GET /api/cs/growth/channel-links` · `POST` 等 | **渠道归因**：渠道链接管理 + `GET /api/growth/click/:sourceId`（点击重定向）+ `POST /api/growth/miniapp-entry`（进入上报）                                                                                                                                                                    |

### 9.2 sync-engine provision-api（`provision-api/server.ts`, :9091，backend 内网直连，无鉴权）

| 方法/路径                                                | 职责                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `POST /provision/:userId[?force=true][&cards=none]`      | 异步触发，立即 202，后台跑完整 provision                       |
| `POST /provision/:userId/sync[?force=true][&cards=none]` | 同步触发，等待完成返回 200（新用户首登用）                     |
| `POST /provision/:userId/character/:characterId/sync`    | **单卡懒下发**：`ensureCharacterProvisioned()`，只落盘单张 PNG |
| `GET /health`                                            | 健康检查                                                       |

> `?cards=none` → `characterScope='none'`：登录关键路径不下发任何角色卡（消除全量下载尖峰）。计划中的 `/flush`、`/status` 仍未实现。

### 9.3 sync-engine watcher（`watcher/index.ts`, health :9090）

非 HTTP 业务服务。启动流程：`loadConfig` → 加载/校验 `registry.yaml`（v2，4 条规则）→ 提取上行规则（当前仅 `user_settings_up`）→ 扫描 `tg_*` 目录 → 构建 handle→userId 映射 → 启动队列 consumer（per-handle 串行）→ 启动 health server → chokidar 监听 `settings.json` 变更（3s 防抖）入队。consumer 调 `uploadSettings()` 执行白名单 pick → hash 去重 → append-only 写 `st_users.user_st_settings`。

### 9.4 ST 服务（vendor/sillytavern, :8000）

原生 200+ 路由。定制经 st-extension 注入 + 受控 `[miniapp-patch]` 补丁（仅 firstLoadInit 并行化）。另装第三方扩展 JS-Slash-Runner（酒馆助手）。

### 9.5 frontend 自有 API（Next.js Route Handler）

| 方法/路径                   | 职责                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/init-st-session` | 同源代理 backend `st-session`，把 ST cookie 写入前端域（`SameSite=None; Secure; Partitioned`）。在 Vercel 文件系统阶段先命中，不被 `/api/:path*` rewrite 劫持 |

---

## 10. provision 执行模型（`sync-engine/provisioner`）

`provision(userId, { force, characterScope })` 严格按清单 order 执行：

1. `fetchProvisionData` — 从 Supabase 拉取 handle / characters / presets / platformSettings / apiConfig / userSettings / **TG persona（miniapp_user_settings）** / **默认模型（runtime_config.llm_model_tiers 中 isDefault 项）**
2. `ensureStUser` — 确保 ST 用户账号存在（ST API）
3. order=10 `writeCharacters` — 从 Supabase Storage 下载角色卡 PNG 落盘为 `platform_<id>.png`。受 `characterScope` 控制：`'all'` 全量 / `'none'` 跳过（登录关键路径）/ `{ ids }` 子集；单卡懒下发走独立入口 `ensureCharacterProvisioned()` → `writeCharacterById()`（不重跑 merge/settings/secrets）
4. order=20 `writePresets` — 写预设 JSON（`OpenAI Settings/platform_<id>.json`）
5. order=30 `writeSecrets` — 写 `secrets.json` 的 `api_key_custom`：`signPlatformToken(userId)` 派生的 per-user JWT（HS256）
6. order=100 `mergeSettings` + `writeSettings` — merge 平台段(A) + 用户段(B) → `settings.json`。merger 强制项【实测】：
   - `disabledExtensions` 并入 **10 个平台无用内置扩展**（tts / vectors / stable-diffusion / gallery / caption / translate / expressions / connection-manager / assets / attachments，用户段无法解禁）——冷启动 P0
   - 强制平台 LLM 链路：`main_api='openai'`、`chat_completion_source='custom'`、`reverse_proxy`/`custom_url` = `LLM_PROXY_URL`
   - 默认模型：`custom_model` 缺省时取 runtime_config 默认档，硬编码兜底 `anthropic/claude-sonnet-4.5`
   - `openai_max_context=32768` + `max_context_unlocked=true`；`message_token_count_enabled=false`（消除切卡远程 token 计数）；`firstRun=false`
   - **TG persona 注入**：`applyUserPersona()` 写 username / name1 / user_avatar / power_user.personas；头像由 `ensureUserAvatar()` 落盘 `User Avatars/<handle>.png`
   - merge 前 `applyActivePreset()`；B 段白名单覆盖后做 `character_ref` 失效校验 + 默认卡兜底（懒下发场景用 `listCharacterIds()` 读磁盘真实列表避免误判）
7. 更新 `miniapp.users.st_initialized_at`

`force=false` 为增量补全（已存在文件跳过），`force=true` 全量覆盖。密码派生 `deriveUserPassword(handle)` 用 `ST_USER_PASSWORD_SECRET`（backend 与 sync-engine 必须一致）。

---

## 11. 部署单元（方案 Y，实测）

| 单元                          | 包 / 镜像                                                         | 说明                                                                                                                                                                                | 平台                               |
| ----------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 平台前端                      | `packages/frontend`                                               | Vercel 构建部署；对外域名绑定 Vercel；ST 流量经 `next.config.mjs` rewrites 转发 Railway nginx（`ST_PUBLIC_PROXY_URL`）                                                              | Vercel                             |
| CS 运营平台                   | `packages/cs-platform`                                            | 独立 Vercel 项目（Vite 静态构建）                                                                                                                                                   | Vercel                             |
| nginx 网关                    | `ghcr.io/<owner>/st-miniapp-nginx`（`ops/nginx/Dockerfile`）      | **唯一对外 Railway 服务**；仅做 ST + backend 内部分发（`location /` 返 404）；静态资源缓存分档（ST 原生包 90d immutable / 酒馆助手 30d / 其余 third-party no-cache / 用户数据不动） | Railway（prod 名 `nginx-pro`）     |
| miniapp 后端                  | `ghcr.io/<owner>/st-miniapp-backend`（`Dockerfile.backend`）      | 服务名 `stminiapp`，内网 :8080，不对外                                                                                                                                              | Railway                            |
| st-bundle（**单容器三进程**） | `ghcr.io/<owner>/st-miniapp-st-backend`（`Dockerfile.st-bundle`） | s6-overlay 编排：ST(:8000) + provision-api(:9091) + watcher(:9090)；数据卷 `/home/node/app/data`（prod 卷 `st-data-pro`）；构建期安装 st-extension 产物 + 酒馆助手                  | Railway（prod 名 `st-bundle-pro`） |
| Supabase                      | 托管                                                              | —                                                                                                                                                                                   | Supabase Cloud                     |

**流量路径**：用户 → Vercel（页面 + rewrites）→ Railway nginx → backend（`stminiapp:8080`）/ ST（`st-bundle:8000`）；backend → st-bundle:9091（provision，内网直连不经 nginx）。

**CI/CD**：`.github/workflows/build-and-push.yml` 构建 4 个 GHCR 镜像（frontend / backend / st-backend / nginx，amd64+arm64，`verify-multiarch` 校验）；frontend 镜像仅 `staging-*` tag 构建（生产在 Vercel）。Railway 拓扑用 `.railway/railway.ts` IaC 管理（需 `railway config apply`）。另有 `ci.yml`（质量门禁）、`db-migrate.yml`（手动迁移）、`pr-review.yml`。

---

## 12. 关键约束补充

### 12.1 角色卡字段语义

- `enabled`：是否上架（控制大厅展示 + provision 下发，唯一的上下架开关）
- `sort_order`：大厅展示顺序（数字越小越靠前；实测大厅另叠加环境窗口 seeded shuffle）
- ~~`is_default`~~ / ~~`is_published`~~ / ~~`is_active`~~：**已删除**（migrations 021/022）。系统兜底卡由 `miniapp.runtime_config` 的 `system_fallback_character_id` 配置
- `raw_card`（jsonb）：角色卡 PNG 解析出的原始 JSON，无损保留生态扩展字段
- `created_at` / `updated_at`：北京时间墙上时间（`Asia/Shanghai`，不带时区）

### 12.2 环境变量

| 前缀 / 关键变量                                                              | 用途                                                                                              |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `*_PROJECT_REF`               | Supabase 连接与环境隔离                                                                           |
| `DATABASE_URL` / `DIRECT_URL`                                                | Prisma（backend）                                                                                 |
| `ST_BASE_URL`                                                                | ST 服务地址（backend 登录 + 反代）                                                                |
| `ST_PROVISION_URL`                                                           | backend → sync-engine provision-api 地址（Railway 内网）                                          |
| `ST_USER_PASSWORD_SECRET`                                                    | 用户密码派生密钥（backend / sync-engine 必须一致）                                                |
| `ST_DATA_PATH`                                                               | sync-engine ST 文件系统路径                                                                       |
| `CHARACTER_STORAGE_BUCKET`                                                   | Supabase Storage bucket（角色卡 PNG，默认 `character-assets`）                                    |
| `HEALTH_PORT`(9090) / `PROVISION_API_PORT`(9091) / `PROVISION_API_BIND_HOST` | sync-engine 端口与绑定                                                                            |
| `LLM_UPSTREAM_URL` / `LLM_API_KEY`                                           | LLM 上游网关（平台真实 key，仅 backend 持有）                                                     |
| `LLM_PROXY_TOKEN_SECRET`                                                     | per-user JWT 签发/验签密钥（backend 与 sync-engine 必须一致，缺省回退 `ST_USER_PASSWORD_SECRET`） |
| `LLM_PROXY_URL`                                                              | 写入 ST settings 的代理网关可达地址（sync-engine merger）                                         |
| `ST_PUBLIC_PROXY_URL` / `NEXT_PUBLIC_ST_PROXY_URL`                           | 生产 Vercel rewrites 目标（Railway nginx 对外地址）；与本地 `ST_LOCAL_URL` 互斥                   |
| `PAYMENT_*`                                                                  | 支付网关（JLPay）                                                                                 |
| `TELEGRAM_BOT_TOKEN` / `BOT_INTERNAL_SECRET`                                 | TG InitData 签名校验 / Bot 内部端点鉴权                                                           |
| `CS_PLATFORM_URL` / `CS_ADMIN_TOKEN` / `CS_TELEGRAM_WEBHOOK_SECRET`          | CS 平台 CORS / 工作台鉴权 / CS 专用 webhook                                                       |
| `UPSTASH_REDIS_REST_*`                                                       | ST cookie 缓存（TTL 24h）+ runtime_config 缓存                                                    |
| `FRONTEND_URL` / `DEV_AUTH_BYPASS`                                           | CORS / 开发放行                                                                                   |

### 12.3 settings.json 分段

ST 原生不分段；由 sync-engine 的 `platform_settings.writable_paths` 白名单驱动：

- **平台管控段**：LLM endpoint、prompts、模板、默认采样参数、禁用扩展清单等，provision 全平台下发（merger 强制项见 §10）。
- **用户可修改段**：白名单内字段（如 `active_character`、`oai_settings.prompts`），watcher 回流到 `st_users.user_st_settings`。

### 12.4 LLM 调用路径

ST 的 LLM endpoint 配置（provision 写入 `oai_settings.custom_url`/`reverse_proxy` + secrets 的 per-user JWT）指向 `…/api/platform/llm-proxy/v1/`。网关职责：JWT 验签提取 userId、持平台真实 key 转发上游（默认 OpenRouter）、SSE 流式透传、异步落库 `chat_history`。

> 【实测】计费链路现状：余额预检**临时注释关闭**、tiers 默认扣费率 **0**（配置在 `runtime_config.llm_model_tiers`，具备热更能力）。恢复计费只需改 runtime_config 扣费率 + 解开预检注释。待补：网关侧按用户限流。

### 12.5 iframe 冷启动优化清单（专项，详见 docs/iframe-\*.md）

- **网络层**：nginx 静态资源缓存分档；`lazyLoadCharacters: true`；角色卡懒下发（登录 `cards=none` + 浮层预取 + 单卡 sync）；vendor firstLoadInit 并行化（受控补丁）
- **执行层**：禁用 10 个内置扩展；消除切卡远程 token 计数；摘除 ST 原生欢迎屏渲染（`welcome-screen-suppress`）
- **鲁棒层**：bridge 5 层看门狗 + 退避重连（§5.3）；隐藏预热改全尺寸真实渲染（禁 `display:none`/1×1px，防 WebKit 后台降级楔死）
- **感知层**：ChatSplash 伪进度 + 阶段文案 + 长尾兜底（45s 返回大厅/重试）；焦点守卫防键盘抢焦
- 实测基线（2026-07-09，round-3 后）：冷启动全长中位数 23.7s → **15.2s**
- 全链路 debug 埋点（iframe-timing / debug-boot-\* / routes/debug.ts）已于 2026-07-13 整体移除；后续排查需重新临时接入

---

## 13. 完成度矩阵

### 13.1 已完成（阶段 0~4 + MVP 后增量）

| 能力                                                                        | 状态 | 位置                                                                                                                                |
| --------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 阶段 0~3：清场 / vendoring / SPIKE / bridge 全链路                          | ✅   | `vendor/sillytavern`、`packages/bridge-protocol`、`st-extension`、`frontend/src/lib/bridge`                                         |
| 鉴权桥 + ST 反代 + provision 触发                                           | ✅   | `backend/routes/bridge.ts` + `middleware/stProxy.ts`                                                                                |
| provision 下行（characters/presets/secrets/settings/persona）               | ✅   | `sync-engine/provisioner`                                                                                                           |
| watcher 上行 settings 回流                                                  | ✅   | `sync-engine/watcher` + `queue`                                                                                                     |
| 历史聊天列表（反代 ST recent）                                              | ✅   | `backend/routes/chats.ts` + `frontend/components/tavern/chat-sidebar.tsx`                                                           |
| LLM 网关 JWT 验签 + chat_history 落库                                       | ✅   | `routes/llm-proxy.ts` + `lib/llm-token.ts` + `lib/chat-history-logger.ts`                                                           |
| 模型档位切换（runtime_config 驱动 + 乐观更新）                              | ✅   | `platform/model-tiers.ts` + `frontend/components/tavern/model-tier-switcher.tsx`                                                    |
| 角色卡 Supabase Storage 下发 + **懒下发**                                   | ✅   | `provisioner/writer.ts` + `provision-api/server.ts` + `frontend/lib/api/st-bridge.ts` + `st-extension/handlers/select-character.ts` |
| st-extension 兼容/体验补丁（15 个 install）                                 | ✅   | `st-extension/src/patches/*`（见 `docs/st-extension-patches.md`）                                                                   |
| 正则/世界书自动授权导入 + 全局正则兜底 + 推理解析器                         | ✅   | `patches/{regex,preset-regex}-autoconfirm.ts`、`worldbook-autoimport.ts`、`global-regex-safety-net.ts`、`reasoning-auto-parse.ts`   |
| TG persona 注入（真实名字 + 头像）                                          | ✅   | `sync-engine`：`fetcher.ts` / `writer.ts` / `merger.ts`（**不在 st-extension**）                                                    |
| 冷启动优化 round 1~3 + bridge 安全网                                        | ✅   | §12.5；`docs/iframe-cold-boot-progress.md`                                                                                          |
| 用户身份迁移 `miniapp.users`                                                | ✅   | migration 028 + `backend/lib/user.ts`                                                                                               |
| CS 运营平台（回访工作台 + SOP + 导出 + 审计）                               | ✅   | `packages/cs-platform` + `backend/routes/cs-platform.ts` + `CsPlatformRepository` + migration 024/027                               |
| 渠道归因（Bot /start + 点击链接 + miniapp 进入上报）                        | ✅   | `backend/routes/{bot,growth}.ts` + migration 029 + `frontend` GrowthEntryReporter                                                   |
| 许愿池 / 充值商店 / 每日签到                                                | ✅   | `backend/routes/{wishes,payment,wallet}.ts` + `frontend/(main)/{create/wish,profile/recharge}`                                      |
| 方案 Y 部署（Vercel rewrites + Railway nginx + st-bundle 单容器 + GHCR CI） | ✅   | `ops/*` + `.railway/railway.ts` + `.github/workflows/build-and-push.yml`                                                            |

### 13.2 待补 / 占位 / 待清理

| 项                                  | 状态    | 说明                                                                                          |
| ----------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| **聊天记录回流 `user_st_chats`**    | ⏳ 占位 | 表/类型就位，registry 无规则、watcher 无 uploader（历史列表用反代已够用）                     |
| **LLM 计费恢复**                    | ⏳ 待启 | 余额预检注释关闭、扣费率 0；恢复=改 runtime_config + 解注释；网关按用户限流未做               |
| **`character:changed` 事件转发**    | ⏳ 未接 | 协议已定义，st-extension forwarders 无实现                                                    |
| **db-types 实际接线**               | ⏳ 待补 | 已生成未消费；生成范围也未覆盖 cs_platform / growth / miniapp                                 |
| **冷启动 debug 埋点移除**           | ✅ 已清 | 2026-07-13：`iframe-timing.ts`、st-extension `debug-*.ts`、`routes/debug.ts` 及全部调用点删除 |
| **backend `src/ai/*` 遗留清理**     | ✅ 已清 | 2026-07-13：`src/ai/*`、`features/chat/billingRules`、`services/RuntimeConfigService` 删除    |
| **backend env 收敛 zod 校验**       | ⏳ 待改 | `platform/config.ts` 仍宽松读取                                                               |
| **migrations README 索引滞后**      | ⏳ 待补 | 正文只列到 024/025，026~029 未登记；021 编号重复（两个文件）                                  |
| **api-contract 独立包**             | ❌ 未建 | 职责暂留 `shared/api`                                                                         |
| **provision 状态查询 / flush 端点** | ❌ 未建 | provision-api 未实现                                                                          |
| **前端占位页**                      | ⏳ 占位 | `/create` 主功能、`/profile/settings` 主入口均为占位                                          |

---
