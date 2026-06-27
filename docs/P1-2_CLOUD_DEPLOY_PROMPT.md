# P1-2 云部署 — Agent 任务提示词

> 本文件是交给独立 Agent 窗口执行 P1-2 云部署的完整上下文。
> 生成时间：2026-06-26。修订：2026-06-27（4 项关键补丁，基于真实代码核验）。
>
> **本轮修订口径**：所有路由 / env / 文件路径均以仓库真实代码 grep/ls 结果为准；
> 凡与旧版本冲突处，以「✅ 实测」标注的为准。对外域名一律用占位 `miniapp.example.com`，
> 真实生产域名待定，**不要写死**。

---

## 一、项目概况

### 1.1 项目是什么

ST_miniAPP 是一个 **Telegram MiniApp**，核心功能是把 SillyTavern（开源 AI 角色扮演前端，下称 ST）嵌入 iframe，外包一层平台壳（Next.js 前端 + Fastify 后端），实现：

- Telegram 身份登录 → 角色大厅 → 点角色卡进对话
- 对话走平台 LLM 代理网关（backend `llm-proxy`），代理转发至 OpenRouter，**按模型档位扣费**（标准 10 / 高级 15）
- 历史聊天列表、切换、新建、删除、重命名
- 模型切换（标准 gemini-2.5-flash / 高级 claude-sonnet-4）
- 钱包余额、签到
- 角色卡 PNG 由运营上传到 Supabase Storage，provisioner 首登时下发到 ST 文件系统

### 1.2 项目根路径

```
/Users/qj/python_project/ST_miniAPP
```

### 1.3 当前分支与状态

- 分支：`dev_character_card_management`
- **P0 全部完成**（本地一键编排 / 端到端冒烟验收 / LLM endpoint 固化 / vendor 零改红线修复）
- **P1-1 完成**（角色卡 PNG 改从 Supabase Storage 下载 + 运营 import 脚本 `scripts/import-character.ts`）
- 工作区基本干净（仅有 import 脚本增量改动和几个废弃文档删除）

---

## 二、架构（5 进程 → 云端单元）

### 2.1 本地 5 进程

由根脚本 `pnpm dev:all`（concurrently）并发拉起：

| 前缀    | 进程                      | 端口        | 技术                | 云端目标                                       |
| ------- | ------------------------- | ----------- | ------------------- | ---------------------------------------------- |
| `st`    | SillyTavern 原生          | 8000        | Node.js `server.js` | Railway 服务（与 sync-engine 同容器，见 §3.6） |
| `prov`  | sync-engine provision-api | 9091        | tsx（Node http）    | Railway 服务（同 ST 容器，副进程）             |
| `watch` | sync-engine watcher       | health 9090 | tsx                 | Railway 服务（同 ST 容器，副进程）             |
| `be`    | backend                   | 3001        | Fastify             | Railway 服务（独立）                           |
| `fe`    | frontend                  | 3000        | Next.js             | **Vercel**                                     |

> ✅ 实测：sync-engine 不是 Fastify，provision-api 是裸 `node:http` server（`src/provision-api/server.ts`），
> **硬编码绑定 `127.0.0.1`**（`BIND_HOST = '127.0.0.1'`，server.ts:21）。这对部署拓扑有硬约束，见 §3.6.7。

### 2.2 monorepo 包结构

```
packages/
  frontend/        @miniapp/frontend      — Next.js 14（App Router），入口 http://localhost:3000
  backend/         @miniapp/backend       — Fastify API 服务，端口 3001
  sync-engine/     @miniapp/sync-engine   — provision-api + watcher（双进程），端口 9091/9090
  st-extension/    @miniapp/st-extension  — ST 内嵌扩展（build → entry.global.js → 拷入 vendor ST 扩展目录）
  bridge-protocol/ @miniapp/bridge-protocol — iframe 桥接协议类型定义
  shared/          @miniapp/shared        — 共享类型 + SQL migrations（001–022，✅ 实测 22 个）
  db-types/        @miniapp/db-types      — Supabase 数据库类型生成
vendor/
  sillytavern/     — ST 原生代码（vendor 只读，所有修补通过 st-extension 注入）
```

workspace 配置：`pnpm-workspace.yaml` → `packages: ['packages/*']`

### 2.3 关键依赖关系

```
frontend(Vercel) ──iframe(同源)──► ST          （iframe src 指向 /tavern，必须与前端页面同源）
frontend(Vercel) ──API(CORS)──► backend         （NEXT_PUBLIC_API_URL + /api/*；CORS 已放行 vercel.app）
backend ──反代──► ST                             （/api/bridge/st/* → ST_BASE_URL/*，stProxy.ts）
backend ──HTTP──► sync-engine provision-api      （ST_PROVISION_URL :9091，触发首登 provision）
sync-engine provision-api ──HTTP──► ST           （ST_BASE_URL，建用户/登录/csrf）
sync-engine ──文件系统──► ST data/ 目录          （写 settings/secrets/characters/presets）
sync-engine ──Supabase──► DB + Storage           （读用户配置 + 下载角色卡 PNG）
ST 服务端 ──HTTP──► backend llm-proxy             （custom_url，✅ 服务端调用，见 §3.2bis / §3.4 注 A）
backend ──OpenRouter──► LLM API                  （代理转发 + SSE 流式）
```

### 2.4 核心同源约束（最重要的部署约束）

ST 被嵌入 Next.js 页面的 iframe 中。**iframe 必须与主页面同源**，否则：

- 浏览器阻止跨域 iframe 通信（bridge postMessage）
- ST 的 `X-Frame-Options` 阻止嵌入

**关键边界澄清（本轮新增）**：

- **只有 ST iframe 需要同源**。frontend → backend 的普通 API 调用走 `fetch` + CORS（backend `app.ts` 已放行 `*.vercel.app` / `FRONTEND_URL`），**不需要同源**，因此可以指向 backend 自有域名 / 内网地址。
- 这条边界是补丁 ④ 选「方案 Y」并消解 `/api/*` 命名空间冲突的基础（见 §3.2ter）。

**本地实现方式**：Next.js `rewrites()`（见 `packages/frontend/next.config.mjs`）：

```javascript
// 仅当 ST_LOCAL_URL 存在时启用（开发模式）；生产 ST_LOCAL_URL 不设 → rewrites 返回空。
fallback: [
  { source: '/tavern', destination: `${stUrl}/` },
  { source: '/tavern/', destination: `${stUrl}/` },
  { source: '/:path*', destination: `${stUrl}/:path*` },
];
```

> ⚠️ **不能把本地 `fallback: /:path* → ST` 直接搬到 nginx**。原因见 §3.2 末「为什么本地能 fallback 到 ST 而 nginx 不行」。

---

## 三、P1-2 部署方案

### 3.1 目标平台

- **frontend** → Vercel（Next.js 原生支持，承担对外域名 + 边缘 CDN）
- **backend** → Railway（独立服务）
- **ST + sync-engine（provision-api + watcher）** → Railway（**单容器三进程**，共享 volume，见 §3.6）
- **nginx**（仅方案 X 需要；方案 Y 下可省，见 §3.2ter）

### 3.2 路由表（补丁 ① 重写）

> 本节先给出**事实基础（5 张表）**，再给出**最终路由方案**。
> 最终架构采用**方案 Y（Vercel 边缘入口 + Railway 内部 nginx）**，详见 §3.2ter；
> §3.2 路由表按方案 Y 分两层呈现。方案 X（nginx 唯一入口）的完整单层枚举表见**附录 A**。

#### 事实表 1 — backend 实际占用的 `/api/*` 前缀（✅ grep `packages/backend/src/routes/` + `app.ts`）

| 路径模式                       | 方法      | 来源文件                           | 说明                                    |
| ------------------------------ | --------- | ---------------------------------- | --------------------------------------- |
| `/api/bridge/st-session`       | POST      | `routes/bridge.ts`                 | 首登三阶段 provision 触发               |
| `/api/bridge/st/*`             | ALL       | `app.ts` + `middleware/stProxy.ts` | backend **反代 ST**（透传 cookie/SSE）  |
| `/api/characters`              | GET       | `routes/characters.ts`             | 平台角色大厅列表                        |
| `/api/characters/:id`          | GET       | `routes/characters.ts`             | `:id` = 平台角色 **UUID**               |
| `/api/users/settings`          | GET/PATCH | `routes/settings.ts`               | 平台用户设置                            |
| `/api/users/chats`             | GET       | `routes/chats.ts`                  | 历史列表（反代 ST `/api/chats/recent`） |
| `/api/wallet/balance`          | GET       | `routes/wallet.ts`                 | 钱包余额                                |
| `/api/wallet/checkin`          | GET/POST  | `routes/wallet.ts`                 | 签到                                    |
| `/api/payment/plans`           | GET       | `routes/payment.ts`                | 套餐                                    |
| `/api/payment/orders`          | GET/POST  | `routes/payment.ts`                | 订单                                    |
| `/api/payment/orders/:id`      | GET       | `routes/payment.ts`                | 订单详情                                |
| `/api/payment/return`          | GET       | `routes/payment.ts`                | 支付回跳                                |
| `/api/payment/webhook/jlpay`   | GET/POST  | `routes/payment.ts`                | 支付回调                                |
| `/api/platform/llm-proxy/v1/*` | ALL       | `routes/llm-proxy.ts`              | **LLM 代理网关（SSE）**                 |
| `/health`                      | GET       | `app.ts`                           | 健康检查                                |

→ 收敛成 nginx 一级/二级前缀组（共 **7** 个 `/api/*` 组 + `/health`）：
`/api/bridge/*`、`/api/characters`(+`/:id`)、`/api/users/settings`、`/api/users/chats`、`/api/wallet/*`、`/api/payment/*`、`/api/platform/*`。

> **消歧决策（三选一）→ 选 (a) 显式枚举 + 兜底 ST**。
> 依据：✅ grep 出 backend **7 个前缀组里只有 1 个**（`/api/platform/*`）落在 platform 命名空间，
> 其余 6 个（bridge/characters/users/wallet/payment）都是非-platform；
> 方案 (b)「全部收敛到 `/api/platform/*`」需要改动 6 组路由 + 前端调用 + ST 反代，工程量大、风险高，**本轮不做**。
> **P1-2 后置技术债（登记）**：未来把 backend 全部业务路由迁到 `/api/platform/*` 单一前缀，可一次性消除下方与 ST 的命名空间冲突，nginx/Vercel 路由表可大幅简化。
> 方案 (c) 拆 `api.<域名>` 子域：当前对外域名未定，**不写死**；方案 Y 下天然等效（backend 用自有 host），见 §3.2ter。

#### 事实表 2 — ST `public/` 真实顶层静态 + 用户数据根路径（✅ `ls vendor/sillytavern/public/` + grep `server-main.js` / `users.js` / `server-startup.js`）

ST 静态根仅来自 `express.static('public')`（`server-main.js:259`），public 顶层**只有**：

```
目录： /css /img /lib /locales /scripts /sounds /webfonts
根文件：/favicon.ico /index.html /login.html /manifest.json /robots.txt
        /script.js /style.css /st.ico /st-launcher.ico /lib.js
```

另有**用户数据根路径**（`users.js` userDataRouter 挂在 `app.use('/', …)`，**不在 public/**，但同样是根路径，必须打到 ST）：

```
/backgrounds/*  /characters/*  /User%20Avatars/*  /assets/*
/user/images/*  /user/files/*  /scripts/extensions/third-party/*
/thumbnail/*   （thumbnailRouter）
```

> ⚠️ **纠正旧版与常见臆想**：ST public 下**没有** `/Themes`、`/Worlds`、`/Groups`、`/Notifications` 顶层目录——
> 它们是 **API 路由**（`/api/themes`、`/api/worldinfo`、`/api/groups`），不是静态资源。
> `/User Avatars` 的真实路径是 **URL 编码的 `/User%20Avatars/*`**（含空格）。
> 旧 §3.2 只列 `/scripts /css /img` 三个，严重不全。

#### 事实表 3 — ST 原生 `/api/*` 命名空间（✅ grep `server-startup.js:141-187`）

ST 自带 **40+ 个 `/api/*` 子路由**，与 backend **真实冲突**的有：

| ST 原生前缀           | 是否与 backend 冲突 | 说明                                                                                                                                                     |
| --------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/characters/*`   | **冲突**            | ST 用 `/api/characters/all`、`/get`、`/edit`…（词动词，多为 POST）；backend 用 `/api/characters`（GET）和 `/api/characters/:UUID`（GET）                 |
| `/api/users/*`        | **不冲突**          | ST 用 `/api/users/me /logout /change-avatar /change-password /backup /reset-* /change-name`（✅ grep users-private.js），**无 `/settings`、无 `/chats`** |
| `/api/chats/*` 等 30+ | 不冲突              | backend 无同名前缀（backend 用 `/api/users/chats`，ST 用 `/api/chats/*`）                                                                                |

冲突消歧（仅方案 X / nginx 需要；方案 Y 用 host 分离，见 §3.2ter）：

- backend `/api/characters` 是 **GET 集合**；`/api/characters/:id` 的 `:id` 恒为 **UUID**。
- ST `/api/characters/<verb>` 的子路径恒为**英文动词词**（all/get/edit/create/delete/rename/import/duplicate/export/chats），**绝不会是 UUID**。
- ∴ 可用 **UUID 正则**精确切分（见下方伪代码 location 3）。

#### 事实表 4 — frontend 路由清单（✅ `ls packages/frontend/src/app/`，App Router）

| 路径                          | 类型                        | 备注                          |
| ----------------------------- | --------------------------- | ----------------------------- |
| `/`                           | page                        | 角色大厅（`(main)/page.tsx`） |
| `/create`                     | page                        | `(main)/create`               |
| `/profile`                    | page                        | `(main)/profile`              |
| `/profile/orders`             | page                        |                               |
| `/profile/recharge`           | page                        |                               |
| `/profile/recharge/[orderId]` | dynamic page                |                               |
| `/profile/settings`           | page                        |                               |
| `/profile/settings/theme`     | page                        |                               |
| `/tavern/[characterId]`       | **dynamic page**            | 对话页，characterId=UUID      |
| `/api/init-st-session`        | **route handler（Vercel）** | ⚠️ 前端**也占用 `/api/*`**    |
| `/_next/*`                    | Next 静态/数据              | 必须打到 Vercel               |

> ⚠️ **纠正旧版**：没有 `/pay`、没有顶层 `/settings`（实际是 `/profile/settings`）。
> 顶层前端路由是 `/create`、`/profile/*`、`/tavern/[uuid]`——若 nginx 兜底打到 ST，这些页面会全部 404。
> 且 `/api/init-st-session` 是**前端 route handler**，意味着 `/api/*` 命名空间是**前端 + backend + ST 三方共享**。

#### 事实表 5 — sync-engine 启动命令（✅ `package.json` + `run.ts`）

| 进程          | 命令                                                     | 端口/健康                            | 信号处理                                                     |
| ------------- | -------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| provision-api | `tsx src/provision-api/run.ts`（`pnpm start:provision`） | `127.0.0.1:9091`（硬编码 BIND_HOST） | ✅ 显式 `SIGTERM`/`SIGINT` graceful shutdown（run.ts:28-29） |
| watcher       | `tsx src/watcher/run.ts`（`pnpm watch`）                 | health `9090`                        | 无显式信号处理（依赖默认；s6 需 SIGTERM 直接终止 tsx）       |

migrations（✅ `ls packages/shared/migrations/*.sql | wc -l` = **22**，编号 **001–022 连续**，另有 1 个 `README.md` 非 SQL）。

---

#### 最终路由方案（方案 Y，两层）

**第 0 层 — UUID 路径正则（两层共用）**

```
^/tavern/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/?$
```

**Layer A — Vercel 边缘（对外域名入口）**

Vercel 项目绑定对外域名，`next.config.mjs` 用生产 `rewrites().beforeFiles` 把「属于 ST 的路径」转发到 Railway nginx 内部入口（`https://<railway-nginx>/…`）；其余一律由 Vercel 自己处理（自家页面/route handler/`_next` 优先匹配）。

```
（Vercel 优先匹配自家：page / route handler / _next / public-file，命中即止）
  /                                  → Vercel page（大厅）
  /create, /profile/*                → Vercel page
  /tavern/<UUID>                     → Vercel page（对话页，动态路由优先）
  /api/init-st-session               → Vercel route handler
  /_next/*                           → Vercel（CDN）

（beforeFiles rewrites：转发到 Railway nginx 内部入口 → 内部 nginx 再分发到 ST）
  /tavern                            → Railway nginx → ST 根 /
  /tavern/                           → Railway nginx → ST 根 /
  /scripts/*  /css/*  /img/*  /lib/*  /locales/*  /sounds/*  /webfonts/*
                                     → Railway nginx → ST（静态）
  /backgrounds/*  /characters/*  /User%20Avatars/*  /assets/*
  /user/images/*  /user/files/*  /thumbnail/*
  /scripts/extensions/third-party/*  → Railway nginx → ST（用户数据/扩展）
  /favicon.ico /manifest.json /style.css /script.js /robots.txt /login.html
                                     → Railway nginx → ST（根文件）
  /api/*                             → Railway nginx → ST（ST 原生 API 兜底）
```

> 关键：**backend 业务 API 不走对外域名**。前端用 `NEXT_PUBLIC_API_URL` 指向 backend 自有地址（Railway public host），
> 经 CORS 调用；ST 服务端用**内网地址**调 llm-proxy（见 §3.4 注 A）。
> 于是对外域名的 `/api/*` 100% 归 ST，`/api/characters` 与 `/api/users/*` 命名空间冲突**自动消失**——
> 这就是方案 Y 相比方案 X 的最大简化。

**Layer B — Railway 内部 nginx（仅 ST 分发，不暴露公网）**

内部 nginx 只面向 ST 单一上游（Vercel rewrites 已经只把 ST 流量转发进来），职责退化为：

```
location ^~ /_next/                 { return 404; }   # 防御：_next 不应进内部 nginx
location  = /tavern                 → proxy_pass http://st;  rewrite → /
location  = /tavern/                → proxy_pass http://st;  rewrite → /
location ^~ /api/platform/          → 不应到达（backend 走内网，非此入口）；如到达 return 404
location    /                       → proxy_pass http://st;   # 其余全部给 ST
```

> 若运营出于成本/简化考虑**不愿引入内部 nginx**，方案 Y 允许 Vercel rewrites 直接转发到 **ST 服务的 Railway public host**，
> 省掉 nginx。是否保留内部 nginx 取决于是否需要在 Railway 侧再做一层路由收口（见《未决问题》）。

#### location 块语义速记（给执行 Agent 写真正 nginx.conf 时用）

nginx `location` 优先级（高 → 低）：

1. `location = /exact`（精确匹配，最高）
2. `location ^~ /prefix`（前缀匹配且**命中后不再查正则**）
3. `location ~ /regex` / `~* /regex`（正则，区分/不区分大小写，**按出现顺序**）
4. `location /prefix`（普通前缀，最长匹配）

方案 X（附录 A）里 `/api/characters` 的消歧就靠这套优先级：

```nginx
# 伪代码草稿 —— 不是最终 nginx.conf
location = /api/characters            { proxy_pass http://backend; }       # GET 集合 → backend（精确）
location ~ ^/api/characters/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ {
                                        proxy_pass http://backend; }        # /:UUID → backend（正则）
location ^~ /api/characters/          { proxy_pass http://st; }            # all/get/edit… → ST（前缀兜底）
```

#### 为什么本地能 fallback 到 ST，而 nginx 不行

Next.js `rewrites().fallback` 是**智能 fallback**：Next 先尝试匹配**自家** page / route handler / `public/` 文件 / 动态路由，**全部 miss 之后**才落到 `fallback` 规则。所以本地 `/:path* → ST` 不会吃掉 `/`、`/create`、`/profile`、`/tavern/<uuid>`、`/api/init-st-session`、`/_next/*`——因为这些先被 Next 自家路由截胡了。

nginx 的 `location /` **没有这种"先问自己再兜底"的语义**——它就是字面前缀匹配，谁优先级高谁赢。若照抄本地的"兜底 → ST"，nginx 会把 `/profile`、`/create`、`/tavern/<uuid>` 直接送给 ST → 全部 404（ST 没有这些页面）。

∴ 在 nginx 里**兜底方向必须改成 Vercel/前端**（方案 X 附录 A 即如此），或干脆用方案 Y 让 Vercel 当入口、由 Next 自己的智能匹配兜底（推荐）。

---

### 3.2bis 流式响应与超时配置（补丁 ③ 新增）

LLM 走 SSE 流式。nginx / 任何反代默认 `proxy_buffering on` 会**缓冲整段响应到结束才回客户端**，导致逐字流式体验完全失效，且长回复易触发 60s 超时断流。

#### 走 SSE / 长连接的路径（✅ grep `routes/` + vendor ST）

| 路径                                                   | 上游    | 流式证据                                                                                                                                   |
| ------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `/api/platform/llm-proxy/v1/*`                         | backend | ✅ `routes/llm-proxy.ts`：`content-type: text/event-stream`、`Transform` 拦截 `data: [DONE]`、`Readable.fromWeb` pipe                      |
| `/api/backends/chat-completions/*`（尤其 `/generate`） | ST      | ✅ `vendor/.../backends/chat-completions.js`：`request.body.stream` + `forwardFetchResponse(stream, response)`（浏览器→ST 这一跳仍是 SSE） |
| `/api/bridge/st/*`                                     | backend | ✅ `middleware/stProxy.ts`：注释「SSE / 大文件直接 pipe 不缓冲」，反代 ST，可能透传上面的 ST SSE                                           |

> ⚠️ **两段 SSE 都存在**：浏览器 → ST `/api/backends/chat-completions/generate`（ST 服务端再去调 custom_url）。
> 即使 ST 已改走平台代理，浏览器→ST 这一跳**依旧是 SSE**（ST 的 chat-completion source=`custom`，仍走 ST 自己的 generate 端点），
> 所以**凡承载这两个路径的反代/网关都必须关缓冲**。
>
> **方案 Y 下**：`/api/platform/llm-proxy/*` 由 backend 自有域名 / 内网承载（不经对外 nginx）；`/api/backends/chat-completions/*` 经
> Vercel rewrite → Railway nginx → ST。**Vercel 对 streaming 默认透传**（边缘不缓冲 SSE），但 Railway 内部 nginx 仍需显式关闭缓冲。

#### nginx 必配指令清单（对承载 SSE 的 location 生效，**不是完整 conf**）

```nginx
proxy_http_version 1.1;
proxy_buffering off;
proxy_cache off;
proxy_set_header Connection '';
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
chunked_transfer_encoding on;
```

#### 超时

- LLM 长回复可能 > 60s，`proxy_read_timeout` / `proxy_send_timeout` 提到 **1h（3600s）** 或更长。
- ✅ 前端 `lib/api/client.ts` 的 `apiStreamClient` 用原生 `fetch` + `ReadableStream` reader，**未设额外超时**（无 AbortController 计时器），不会自己提前断流。✅ backend `llm-proxy.ts` fetch 上游同样无显式超时。∴ 超时短板只在反代层，按上方配置即可。

#### WebSocket

- ✅ grep `vendor/sillytavern`（server.js / src）**未发现** `ws.Server` / `WebSocketServer` / `socket.io` / `express-ws`。
  **ST 不使用 WebSocket**，无需配置 `Upgrade` / `Connection: upgrade`。若未来引入再补。

#### 安全 header 透传要求

- nginx **不要**新增 `X-Frame-Options: DENY` 或 `Content-Security-Policy: frame-ancestors 'none'` 类 header——会直接打断 iframe 嵌入（同源是生命线）。
- nginx **不要覆盖** ST 返回的 `X-Frame-Options`；同源场景下 ST 的 `SAMEORIGIN` 是正确值。
- 若 ST 未设置该 header，由 nginx 兜底设 `X-Frame-Options: SAMEORIGIN`（不要 DENY）。
- CSP 同理：不要在 nginx 注入 `frame-ancestors`，交给 ST 自己决定。
- 透传 ST 的 `Set-Cookie`（session）——✅ `stProxy.ts` 已透传，nginx 不要剥离。

---

### 3.2ter Vercel 反代实施细节与最终架构决策（补丁 ④ 新增）

#### 两种架构方案

- **方案 X（nginx 唯一入口）**：对外域名 → Railway nginx → 再反代到 Vercel / backend / ST。
  - 优点：路由集中在一处。
  - 缺点：nginx 必须**反代 Vercel**（DNS/SNI/Host/anti-abuse 一堆坑，见下）；Vercel 边缘 CDN 加速对前端**半失效**（流量绕一圈 Railway）；`/api/*` 三方命名空间冲突全压在 nginx（需 UUID 正则等技巧，见附录 A）。
- **方案 Y（Vercel 边缘入口 + Railway 内部分发）**：对外域名直接绑 Vercel 项目，Vercel `rewrites` 把 ST 相关路径转发到 Railway nginx（仅 ST），backend 用自有 host + CORS。
  - 优点：①Vercel 全球 CDN 原生加速前端；②Next 动态路由（`/tavern/[uuid]`）由 Vercel 自己处理，nginx 不必复刻 UUID 正则；③`/api/*` 命名空间冲突**自动消解**（对外域名 `/api/*` 全归 ST）；④Railway nginx 退化为「只分发 ST」，极简。
  - 缺点：①依赖 Vercel rewrites（有数量上限，但本项目规则约 12 条，远低于上限）；②ST 静态资源经 Vercel→Railway 转发，比直连略多一跳（可接受，ST 静态量不大）。

> **推荐：方案 Y。**
> 决策依据（✅ 实测）：
>
> 1. frontend 路由很少（约 8 个 page + 1 个 route handler，事实表 4），Vercel rewrites 规则数（≈12）远低于平台上限，方案 Y 完全可行。
> 2. `/api/*` 是**前端 route handler + backend + ST 三方共享**（事实表 1/3/4）。方案 X 要在 nginx 里同时摆平三方（含 `/api/characters` UUID 正则、`/api/init-st-session`→Vercel），脆弱；方案 Y 借「同源只约束 iframe、backend 走 CORS/内网」把三方拆开，结构干净。
> 3. ST 服务端调 llm-proxy（custom_url 服务端消费，注 A）可用**内网**，不必把 `/api/platform/*` 暴露到对外域名。
>
> **反向情形**：若未来前端路由爆炸式增长 / 需要在边缘做大量自定义重写超过 Vercel 限制，再回退方案 X（附录 A 已备齐完整 nginx 表与坑位清单）。

#### 方案 X 若被采用：Vercel 反代必踩的坑（写进 nginx.conf 注释 + 验收）

1. **DNS 动态解析**：Vercel 上游是 `cname.vercel-dns.com`，IP 会变。nginx 必须 `resolver 1.1.1.1 valid=60s;` 且 `proxy_pass` 用变量（`set $vercel "<project>.vercel.app"; proxy_pass https://$vercel;`），否则首次解析后 IP 变更即失联。
2. **SNI + Host**：`proxy_ssl_server_name on;` + `proxy_set_header Host <project>.vercel.app;`，否则 Vercel SNI 路由失败返回 404。
3. **真实对外域名转发**：`proxy_set_header X-Forwarded-Host miniapp.example.com;` + `proxy_set_header X-Forwarded-Proto https;`，让 Next SSR 拿到真实对外域名生成绝对 URL。
4. **Vercel anti-abuse**：单一 Railway 出口 IP 高频反代可能被 Vercel challenge；评估流量级别，必要时在 Vercel 侧将 Railway 出口 IP 加信任 / 升级套餐。
5. **自定义域 vs 反代**：能直接把对外域名加到 Vercel 项目就别反代（即转向方案 Y）。
6. **验收项（方案 X 专属）**：`curl -H "Host: <project>.vercel.app" https://<nginx>/` 应返回 Next 首页 HTML。

#### 方案 Y 落地要点

- 对外域名添加到 **Vercel 项目自定义域**（不经 nginx）。
- `next.config.mjs` 生产分支用 `rewrites().beforeFiles` 列出 §3.2 Layer A 的 ST 路径 → `https://<railway-nginx-or-st>/…`。
  > 注意：生产 rewrites 的 `destination` 用**绝对 URL**指向 Railway；当前 `next.config.mjs` 仅在 `ST_LOCAL_URL` 存在时启用 rewrites（本地），生产需新增一套基于 `ST_PUBLIC_PROXY_URL`（占位变量名）的 `beforeFiles` 规则。**这是 P1-2 执行 Agent 要在 frontend 加的产物**（属部署资产，不算改业务源码）。
- `NEXT_PUBLIC_API_URL` 指向 **backend 自有 Railway public host**（如 `https://<backend>.up.railway.app`），CORS 已放行 `*.vercel.app`。
- TG WebView 入口指向 Vercel 对外域名。

---

### 3.3 需要创建的 Dockerfiles（补丁 ② 重写）

> 旧版的「ST 独立镜像 + sync-engine 独立镜像」拆分**不可行**：Railway persistent volume **只能绑定一个 service**（官方限制），
> 而 ST 与 sync-engine 必须共享同一份 `data/`（§3.6）。∴ 删除 `Dockerfile.sync-engine`，合并为 **`Dockerfile.st-bundle`**（单容器三进程）。

`ops/docker/` 下需要的 Dockerfile：

#### 3.3.1 `Dockerfile.st-bundle`（ST + provision-api + watcher，三进程）

基于 `vendor/sillytavern/Dockerfile`（stock：`node:lts-alpine3.23` + tini + `docker-entrypoint.sh`），在其之上：

- 安装 **Node + pnpm**（vendor 镜像已含 Node；需补 `corepack enable` 或 `npm i -g pnpm`）。
- 构建 st-extension：`pnpm --filter @miniapp/st-extension build` → 产物 `dist/entry.global.js` + `manifest.json`；
  ✅ 现有 `packages/st-extension/scripts/postbuild.ts` 已负责拷贝到 `public/scripts/extensions/third-party/miniapp-bridge/`，构建期复用即可。
- 复制 **sync-engine 源码 + node_modules**（或在镜像内 `pnpm --filter @miniapp/sync-engine install`），保留 `tsx` 运行入口。
- 注入 **production `config.yaml`**（覆盖字段见 §3.3.5）。
- 安装 **s6-overlay**（见 §3.6.2）并放置三个 service 定义。
- 暴露端口：**8000**（ST）、**9091**（provision-api）、**9090**（watcher health）。
  > ⚠️ provision-api 硬编码绑 `127.0.0.1`（事实表 5 / §3.6.7），EXPOSE 9091 对**跨服务**调用无效，见 §3.6.7 未决项。
- 持久化 volume 挂载点：**`/home/node/app/data`**（ST `dataRoot: ./data` 的绝对路径）。
- ENTRYPOINT 改为 s6-overlay 的 `/init`（不再直接 `tini -- docker-entrypoint.sh`；ST 的目录初始化逻辑迁移到 ST service 的 run 脚本里调用，见 §3.6.4）。

#### 3.3.2 `Dockerfile.backend`

Fastify 服务。✅ 启动命令见 `packages/backend/package.json` 的 `start`（如 `tsx src/server.ts`；若含 Prisma 步骤则构建期完成）。独立 Railway 服务，无 volume。

#### 3.3.3 ~~`Dockerfile.sync-engine`~~（删除）

合并进 `Dockerfile.st-bundle`（§3.3.1）。

#### 3.3.4 `Dockerfile.nginx`（仅方案 X / 或方案 Y 的内部 nginx 需要）

`FROM nginx:alpine` + `COPY nginx.conf`，**不引入额外构建步骤**。方案 Y 若省内部 nginx，则此 Dockerfile 也可省。

#### 3.3.5 production `config.yaml` 覆盖字段（✅ 对比 `vendor/sillytavern/config.yaml`）

| 字段                             | 默认值（vendor） | 生产值      | 原因                                 |
| -------------------------------- | ---------------- | ----------- | ------------------------------------ |
| `listen`                         | `false`          | **`true`**  | 接受外部连接（容器内被反代）         |
| `whitelistMode`                  | `true`           | **`false`** | 关闭 IP 白名单（反代后源 IP 不可信） |
| `enableUserAccounts`             | `true`（已是）   | `true`      | 多用户                               |
| `port`                           | `8000`           | `8000`      | 保持                                 |
| `disableCsrfProtection`          | `true`（已是）   | `true`      | bridge/反代场景                      |
| `forwardedHeaders.xForwardedFor` | `true`（已是）   | `true`      | 反代后取真实 IP                      |

---

### 3.4 生产环境变量

> **注 A（本轮重要修正）**：✅ `vendor/.../backends/chat-completions.js:1924-1926`——`chat_completion_source==='custom'` 时
> `apiUrl = request.body.custom_url`，由 **ST 服务端**发起上游 fetch；`packages/sync-engine/.env.example:47-49` 亦明确
> 「prod/staging 必须覆盖为 **ST 进程可达**的 backend 网关 URL」。
> ∴ 旧版「注意事项 #6」所述 `LLM_PROXY_URL` 必须**浏览器端可达\*\***不准确**——它是 **ST 服务端消费**，
> **应填 Railway 内网地址\*\*（`http://<backend>.railway.internal:3001/api/platform/llm-proxy/v1`），更安全、少一跳公网回环。

> **注 B（Railway 内网 DNS）**：Railway 服务间用 `http://<service-name>.railway.internal:<port>`。
> 下方所有 `*.railway.internal` 均为**占位**，以 Railway 控制台显示的实际 service hostname 为准。

> **注 C（跨服务密钥一致性）**：`ST_USER_PASSWORD_SECRET` 现在分布在 **backend 服务**与 **st-bundle 服务**两处，
> 二者必须**完全相同**（HMAC 派生 ST 登录密码，不一致 → bridge 登录 ST 失败）。强烈建议用 Railway
> **Project-level Shared Variables**（项目级共享变量）注入到两个服务；若不可用，则在两边 env 模板用醒目警告标注「⚠️ 必须与另一服务逐字一致」。

#### frontend（Vercel 环境变量）

```
NEXT_PUBLIC_API_URL=https://<backend>.up.railway.app   # backend 自有 host（方案 Y）；CORS 已放行 *.vercel.app
NEXT_PUBLIC_USE_MOCK_INIT_DATA=0
ST_PUBLIC_PROXY_URL=https://<railway-nginx-or-st-host>  # 生产 rewrites 把 ST 路径转发到此（方案 Y 新增占位变量）
# ST_LOCAL_URL 不设 → 本地 dev rewrites 关闭
```

#### backend（Railway 环境变量）

```
NODE_ENV=production
DATABASE_ENV=production
PROD_DATABASE_URL=...                  PROD_DIRECT_URL=...
PROD_SUPABASE_URL=...                   PROD_SUPABASE_PROJECT_REF=...
PROD_SUPABASE_SERVICE_ROLE_KEY=...
TELEGRAM_BOT_TOKEN=...
LLM_UPSTREAM_URL=https://openrouter.ai/api/v1
LLM_API_KEY=...
LLM_DEFAULT_MODEL=google/gemini-2.5-flash
LLM_PROXY_SECRET=...
ST_BASE_URL=http://<st-bundle>.railway.internal:8000        # 内网；注 B
ST_PROVISION_URL=http://<st-bundle>.railway.internal:9091   # 内网；⚠️ 见 §3.6.7（provision-api 绑 127.0.0.1，跨服务不通）
ST_USER_PASSWORD_SECRET=...                                 # ⚠️ 注 C：必须与 st-bundle 一致（建议项目级共享变量）
FRONTEND_URL=https://miniapp.example.com                    # 对外域名（占位）；CORS 精确匹配 + 业务回跳
PAYMENT_NOTIFY_URL=https://<backend>.up.railway.app/api/payment/webhook/jlpay
PAYMENT_RETURN_URL=https://<backend>.up.railway.app/api/payment/return
```

#### sync-engine（注入 st-bundle 容器的 env，provision-api + watcher 共用）

```
DATABASE_ENV=production
PROD_SUPABASE_PROJECT_REF=...   PROD_SUPABASE_URL=...   PROD_SUPABASE_SERVICE_ROLE_KEY=...
ST_DATA_PATH=/home/node/app/data            # 与 ST dataRoot 同一 volume 挂载点
ST_BASE_URL=http://127.0.0.1:8000           # ✅ 同容器，走本机回环（ST 与 sync-engine 同 pod）
ST_ADMIN_USERNAME=admin
ST_ADMIN_PASSWORD=...
ST_USER_PASSWORD_SECRET=...                 # ⚠️ 注 C：必须与 backend 一致
LLM_PROXY_URL=http://<backend>.railway.internal:3001/api/platform/llm-proxy/v1   # ✅ 注 A：ST 服务端可达的内网地址
CHARACTER_STORAGE_BUCKET=character-assets
PROVISION_API_PORT=9091
HEALTH_PORT=9090
```

#### ST（config.yaml 注入为主，env 极少）

见 §3.3.5。

---

### 3.5 Supabase 生产库准备

✅ 实测 `packages/shared/migrations/` 下 **22 个 SQL（001–022 连续）**，需全部按序应用：

```
001_users_add_st_fields.sql … 022_characters_raw_card_beijing_time.sql   （共 22 个）
```

> 注：`docs/MVP_ACTION_PLAN.md` P1-2 行写的「001–020」为旧口径，真实数量是 **22**，以本节为准。

加上 Prisma migrations（`packages/backend/prisma/migrations/`）：

```
0_baseline/
20260422102132_add_miniapp_tables/
20260422111917_align_characters_with_tavern_spec/
20260422114408_character_soft_reference/
20260623113000_phase0_drop_sessions_character_flags/
20260626150000_character_field_cleanup_fallback_config/
```

还需 seed 数据（角色卡记录 + 预设 + 初始配置）。

> ⚠️ **应用完所有 migration 后，必须执行 `NOTIFY pgrst, 'reload schema';`**，否则 PostgREST schema cache 未刷新，
> RPC 函数（如 `miniapp.deduct_wallet_credits`、`charge_chat_message`）会报
> `Could not find the function … in the schema cache`，扣费静默失败（fire-and-forget 不报错、易漏）。
> 此坑已在 `docs/MVP_ACTION_PLAN.md` P0-2 末「计费 RPC 缺失（test 库迁移半应用）」踩过并修复。

---

### 3.6 文件系统共享方案（补丁 ② 重写）

#### 3.6.1 唯一可行路径：方案 B（ST + sync-engine 同容器）

**ST 与 sync-engine 必须共享同一份 `data/`**（provisioner 写 `data/<handle>/` 下的 settings/secrets/角色卡 PNG/presets，ST 读取）。

- **方案 A（两个 service 各挂同一 volume）走不通**：Railway persistent volume **只能绑定一个 service**。
  > 若执行 Agent 在 Railway 文档发现已支持「一个 volume 多 service 挂载」，请附官方链接，可重新评估方案 A。
- **∴ 选方案 B**：ST + provision-api + watcher 打进**同一容器**（`Dockerfile.st-bundle`），共享本地文件系统 + 单一 volume。

#### 3.6.2 三进程编排：选 **s6-overlay**（而非 supervisord / pm2 / shell &）

- ✅ **s6-overlay**（推荐）：官方 base image 友好、对 `SIGTERM` 传播可靠（容器优雅退出），支持服务依赖与 readiness。
- ❌ supervisord：通用，但对容器 `SIGTERM` 传播一般，需额外配置。
- ❌ pm2：不适合做容器 PID 1。
- ❌ shell `&` 后台：信号丢失，容器优雅退出失败、僵尸进程。

#### 3.6.3 三个 service：`st` / `provision-api` / `watcher`

| service         | 启动命令                                             | 端口/健康      |
| --------------- | ---------------------------------------------------- | -------------- |
| `st`            | ST 原生（ST 目录初始化 + `node server.js --listen`） | 8000           |
| `provision-api` | `tsx src/provision-api/run.ts`                       | 127.0.0.1:9091 |
| `watcher`       | `tsx src/watcher/run.ts`                             | health 9090    |

#### 3.6.4 s6 run 脚本骨架（仅关键结构，非完整脚本）

```sh
# /etc/s6-overlay/s6-rc.d/st/run
#!/command/execlineb -P
# （复用 vendor docker-entrypoint.sh 的目录初始化逻辑：config/data/plugins/extensions/backups）
cd /home/node/app
# config check + npm run init（自动补全 config.yaml）后：
node server.js --listen
```

```sh
# /etc/s6-overlay/s6-rc.d/provision-api/run
#!/command/execlineb -P
cd /home/node/app/packages/sync-engine
# 依赖 st 就绪（见 3.6.6）
npx tsx src/provision-api/run.ts
```

```sh
# /etc/s6-overlay/s6-rc.d/watcher/run
#!/command/execlineb -P
cd /home/node/app/packages/sync-engine
npx tsx src/watcher/run.ts
```

- 每个 service 配 `type=longrun`；s6 自动重启崩溃进程。
- 关闭时 s6 向各进程发 `SIGTERM`：provision-api ✅ 已 graceful（事实表 5）；watcher 依赖默认终止行为，必要时在 P1-2-deploy 补显式处理（登记，非本轮）。

#### 3.6.5 端口

EXPOSE `8000`（ST）、`9091`（provision-api，受 §3.6.7 约束）、`9090`（watcher health）。

#### 3.6.6 启动顺序（强约束）

provision-api 启动后会**立即可能收到 backend 的 provision 请求**，并随即调用 ST（`st-user.ts` 打 `ST_BASE_URL/csrf-token`、建用户、登录）。**ST 必须先就绪（监听 8000）再起 provision-api**，否则首登失败。

- s6 用 `dependencies.d/`：在 `provision-api` 与 `watcher` 的目录下放 `dependencies.d/st`。
- 因 s6 的 dependency 仅保证「st 的 run 已拉起」而非「8000 已 accept」，建议 provision-api/watcher run 脚本前置一个 **readiness 等待**（`until curl -sf http://127.0.0.1:8000/ ; do sleep 1; done`）再启动本体。

#### 3.6.7 ⚠️ 未决：provision-api 绑 `127.0.0.1` 与「backend 独立服务」冲突

- ✅ 实测 `src/provision-api/server.ts:21` 硬编码 `BIND_HOST = '127.0.0.1'`，**无 env 可覆盖**。
- 后果：backend 在**独立 Railway 服务**，无法通过 `http://<st-bundle>.railway.internal:9091` 跨服务访问绑在容器内 loopback 的 provision-api。
- 候选解（需人工拍板，均涉及范围/源码，**不在本文档产出内**）：
  - (1) 把 **backend 也并入 st-bundle**（四进程），则 backend→provision-api 走 `127.0.0.1:9091` 即通——但放弃「backend 独立服务」。
  - (2) 在 P1-2-deploy 子任务里把 `BIND_HOST` 改为可配置（默认容器内 `0.0.0.0`）——最小源码改动，**登记为后置技术债**。
  - (3) 容器内加一个 loopback→外部端口的转发（socat），不改源码但增运维复杂度。
- 见《补丁修订摘要》未决问题表。

---

### 3.7 TG WebView 联调

最终在 TG Bot 配置 WebApp URL 指向 **Vercel 对外域名**（方案 Y）。`MOCK_AUTH` 关闭后，frontend 从 Telegram WebApp SDK 取真实 `initData`，backend 用 `TELEGRAM_BOT_TOKEN` 验签。

> ⚠️ 在 **BotFather** 用 `/setdomain`（或 `/newapp` 创建 WebApp 时）**白名单对外域名**，否则 TG WebView 拒绝加载页面。

---

## 四、必读附件清单

| 优先级   | 文件路径                                                      | 内容                                                     |
| -------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| **必读** | `docs/MVP_ACTION_PLAN.md`                                     | 总体进度、P1-2 定义、执行顺序                            |
| **必读** | `docs/st-extension-patches.md`                                | 6 个 vendor 兼容补丁，理解同源 + base href 约束          |
| **必读** | `packages/frontend/next.config.mjs`                           | Next.js rewrite 规则（生产 rewrites 要新增 beforeFiles） |
| **必读** | `packages/backend/src/app.ts`                                 | backend 路由挂载真相 + CORS + `/api/bridge/st/*` 反代    |
| **必读** | `packages/backend/src/routes/`                                | backend 全部 `/api/*` 前缀（事实表 1）                   |
| **必读** | `packages/backend/src/routes/llm-proxy.ts`                    | SSE 实现，确认 proxy_buffering 必须关                    |
| **必读** | `packages/backend/src/middleware/stProxy.ts`                  | ST 反代逻辑（与 nginx 协同）                             |
| **必读** | `vendor/sillytavern/src/server-startup.js`                    | ST 原生 `/api/*` + userDataRouter 根路径（事实表 2/3）   |
| **必读** | `vendor/sillytavern/Dockerfile`                               | ST stock Dockerfile（st-bundle 基础）                    |
| **必读** | `vendor/sillytavern/docker/docker-entrypoint.sh`              | ST 容器入口（目录初始化逻辑要迁进 s6 run）               |
| **必读** | `vendor/sillytavern/config.yaml`                              | ST 默认 config（覆盖字段见 §3.3.5）                      |
| **必读** | `packages/sync-engine/package.json`                           | provision/watcher start 脚本（事实表 5）                 |
| **必读** | `packages/sync-engine/src/provision-api/run.ts` / `server.ts` | 入口 + BIND_HOST 约束（§3.6.7）                          |
| 参考     | `packages/sync-engine/src/watcher/run.ts`                     | watcher 入口                                             |
| 参考     | `packages/frontend/src/lib/api/client.ts`                     | 前端 base URL = `NEXT_PUBLIC_API_URL`（无硬编码）        |
| 参考     | `packages/backend/.env.example`                               | backend env 模板                                         |
| 参考     | `packages/sync-engine/.env.example`                           | sync-engine env 模板（注 A 出处）                        |
| 参考     | `docs/ARCHITECTURE.md`                                        | 架构设计文档                                             |

---

## 五、执行步骤与验收目标

### 5.1 执行步骤（建议顺序）

1. **创建 `ops/docker/`**，编写：
   - `Dockerfile.st-bundle` — ST + provision-api + watcher 三进程（s6-overlay；含 st-extension 产物、生产 config.yaml、volume 挂载点 `/home/node/app/data`）
   - `Dockerfile.backend` — backend 独立服务镜像
   - `Dockerfile.nginx` —（仅方案 X / 方案 Y 内部 nginx 需要）`FROM nginx:alpine` + `COPY nginx.conf`
   - ~~`Dockerfile.sync-engine`~~（删除，合并进 st-bundle）

2. **路由资产**：
   - 方案 Y：在 `packages/frontend/next.config.mjs` 增加生产 `rewrites().beforeFiles`（基于 `ST_PUBLIC_PROXY_URL`），列出 §3.2 Layer A 的 ST 路径；如保留内部 nginx，写 `ops/nginx/nginx.conf`（仅分发 ST，§3.2 Layer B）。
   - 方案 X：写 `ops/nginx/nginx.conf`，严格复刻**附录 A** 单层枚举表（含 `/api/characters` UUID 正则、SSE 关缓冲、Vercel 反代坑位）。

3. **`ops/s6/`**：三个 service 的 s6-overlay 定义（run 脚本 + `dependencies.d/` + readiness 等待，§3.6.4/3.6.6）。

4. **生产 env 模板**：`ops/env/` 下各服务 `.env.production.example`，落实注 A/B/C（含 `ST_USER_PASSWORD_SECRET` 共享变量警告、内网地址占位、`LLM_PROXY_URL` 内网）。

5. **本地构建验证**：每个镜像 `docker build` 成功；st-bundle 内三进程能各自起来、ST 先就绪。

6. **文档更新**：把 `docs/MVP_ACTION_PLAN.md` 中 P1-2 标记为 **🟡 已交付部署资产（Dockerfile / nginx.conf-or-rewrites / s6 / env 模板）**，**实际上线待 P1-2-deploy 子任务**（不要直接 ✅）。

### 5.2 验收目标

| #   | 验收项                | 标准                                                                                                                                                                                                                        |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | st-bundle 镜像构建    | `docker build -f ops/docker/Dockerfile.st-bundle .` 成功；容器内 `public/scripts/extensions/third-party/miniapp-bridge/entry.global.js` 存在                                                                                |
| 2   | backend 镜像构建      | `docker build -f ops/docker/Dockerfile.backend .` 成功                                                                                                                                                                      |
| 3   | st-bundle 三进程编排  | s6 起容器后：ST 先监听 8000 → provision-api（127.0.0.1:9091）→ watcher（health 9090）；`SIGTERM` 能优雅退出；ST 未就绪时 provision-api readiness 等待生效                                                                   |
| 4   | 路由配置正确性        | 方案 Y：`next.config.mjs` rewrites 覆盖 §3.2 Layer A 全部 ST 路径；（如有内部 nginx）`nginx -t` 通过。方案 X：`nginx -t` 通过且覆盖附录 A 全部路径                                                                          |
| 5   | 同源 + 命名空间消歧   | `/tavern`→ST 根；ST 静态/用户数据根路径（事实表 2）→ST；`/api/*`(ST 原生)→ST；`/api/characters`(GET 集合)/`/api/characters/:UUID`→backend；`/tavern/[uuid]`/`/profile/*`/`/create`/`/api/init-st-session`/`/_next/*`→Vercel |
| 6   | SSE 不缓冲            | 承载 `/api/platform/llm-proxy/*`（backend）与 `/api/backends/chat-completions/*`（ST）的反代层均 `proxy_buffering off` + 超时 ≥3600s；逐字流式可见                                                                          |
| 7   | env 模板完整          | 各服务模板含所有必需变量 + 注释；`ST_USER_PASSWORD_SECRET` 跨服务一致性警告；`LLM_PROXY_URL` 为内网地址；无遗漏                                                                                                             |
| 8   | 前端无硬编码 base URL | grep `packages/frontend/src/` 确认无硬编码 `http://localhost:3001`（仅 `client.ts` 默认回退一处，生产由 `NEXT_PUBLIC_API_URL` 覆盖）                                                                                        |

### 5.3 不在本轮范围

- 实际 Vercel / Railway 部署（需账号 + 域名）
- 生产 Supabase 迁移执行（需 DBA；记得 `NOTIFY pgrst, 'reload schema';`）
- 真实 TG WebView 联调（需 bot 配置 + BotFather `/setdomain`）
- SSL 证书（Railway / Vercel 自带）
- §3.6.7 的 provision-api BIND_HOST 源码改动（如选候选解 2）

---

## 六、注意事项与陷阱

1. **同源是生命线（仅约束 ST iframe）**：ST 资源（`/scripts/*`、`/css/*`、用户数据根路径）与 ST 入口（`/tavern`）必须与前端页面同源可达。backend API 走 CORS，不要求同源（这是方案 Y 拆 `/api/*` 冲突的依据）。

2. **`<base href="/">`**：ST `index.html` 含 `<base href="/">`，相对路径以根解析。所以 ST 静态/数据必须在**根路径**（`/scripts/*` 等）可达，nginx/rewrites 不能加前缀。`tabs-base-guard` 补丁（st-extension §2）已修复 iframe 挂 `/tavern` 子路径下 jQuery UI Tabs 误判远程 URL 的问题。

3. **`/tavern/[uuid]` vs `/tavern/`**：`/tavern`、`/tavern/`（无 UUID）→ ST 入口；`/tavern/<UUID>` → Vercel 对话页。UUID 正则见 §3.2 第 0 层。方案 Y 下 Vercel 动态路由天然区分，nginx 不必复刻。

4. **文件系统共享 → 单容器三进程**：Railway volume 单 service 绑定，∴ ST + sync-engine 同容器（§3.6）。

5. **`ST_USER_PASSWORD_SECRET` 一致性**：backend 与 st-bundle 两服务必须同值（注 C）。

6. **`LLM_PROXY_URL` 由 ST 服务端消费（修正）**：✅ chat-completions.js 用 `custom_url` 服务端 fetch；应填 **Railway 内网**地址（注 A），不是浏览器地址。

7. **SSE 关缓冲**：两段 SSE（浏览器→ST、ST→backend）所经反代层都要 `proxy_buffering off` + 长超时（§3.2bis）。

8. **`/api/*` 三方共享**：前端 route handler（`/api/init-st-session`）+ backend + ST。方案 Y 用 host 分离；方案 X 必须在 nginx 精确消歧（附录 A）。

9. **ST 无 WebSocket**：✅ vendor 无 `ws.Server`；无需 Upgrade 配置。

---

## 附录 A — 方案 X 单层 nginx 路由表（仅当回退方案 X 时使用）

> 对外域名 = Railway nginx。优先级由上到下；同层按 nginx location 规则（§3.2「location 块语义速记」）。

**Layer 1（精确前缀 / 正则，优先级最高）**

```
location ^~ /_next/                       → Vercel                       # Next 静态/数据
location  = /api/init-st-session          → Vercel                       # 前端 route handler
location  = /tavern                       → ST（rewrite → /）
location  = /tavern/                      → ST（rewrite → /）
location ~ ^/tavern/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/?$
                                          → Vercel                       # 对话页（UUID）
location ^~ /api/bridge/                  → backend
location  = /api/characters               → backend                      # GET 集合
location ~ ^/api/characters/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
                                          → backend                      # /:UUID
location ^~ /api/characters/              → ST                           # all/get/edit…（ST 词动词）
location  = /api/users/settings           → backend
location  = /api/users/chats              → backend
location ^~ /api/users/                   → ST                           # me/logout/change-*…
location ^~ /api/wallet/                  → backend
location ^~ /api/payment/                 → backend
location ^~ /api/platform/                → backend  [SSE: proxy_buffering off]
location ^~ /api/backends/chat-completions/ → ST     [SSE: proxy_buffering off]
location ^~ /api/                          → ST                          # ST 原生 API 兜底
```

**Layer 2（ST 静态 + 用户数据根路径，按事实表 2 真实枚举）**

```
location ^~ /scripts/    → ST     location ^~ /css/        → ST
location ^~ /img/        → ST     location ^~ /lib/        → ST
location ^~ /locales/    → ST     location ^~ /sounds/     → ST
location ^~ /webfonts/   → ST
location ^~ /backgrounds/        → ST    location ^~ /characters/         → ST
location ^~ /User%20Avatars/     → ST    location ^~ /assets/             → ST
location ^~ /user/images/        → ST    location ^~ /user/files/         → ST
location ^~ /thumbnail/          → ST
location = /favicon.ico  → ST    location = /manifest.json → ST
location = /style.css    → ST    location = /script.js     → ST
location = /robots.txt   → ST    location = /login.html    → ST
location = /st.ico       → ST    location = /lib.js        → ST
```

**Layer 3（兜底 → Vercel，方向已纠正）**

```
location / → Vercel        # 含 /、/create、/profile/* 等所有前端页面
```

> Layer 1 含 SSE 标注的 location 必须套用 §3.2bis 指令清单。
> nginx 反代 Vercel 必须套用 §3.2ter 方案 X 的 DNS/SNI/Host 配置。
