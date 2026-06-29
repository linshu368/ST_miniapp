# ops/nginx — 单域名反向代理网关（M3）

把 **frontend / backend / provision-api / ST 主体** 统一收口在一个域名 + 端口（80）下。
M3 仅交付配置与镜像，**不与 M2 容器真实联调**；upstream 用 docker network hostname 占位，M4 编排时串接。

- 基础镜像：`nginx:1.27-alpine`
- 监听：`80`（不开 SSL；TLS 终结留给外层 / M4 之后）
- 路由真相依据：[`docs/P1-2_CLOUD_DEPLOY_PROMPT.md`](../../docs/P1-2_CLOUD_DEPLOY_PROMPT.md)（附录 A 单层枚举表）

## upstream / 端口约定

| upstream（hostname） | 端口 | 进程                                            | 来源                                                                                                                                                    |
| -------------------- | ---- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend`           | 3000 | Next.js standalone（**自托管容器**，非 Vercel） | `packages/frontend` `scripts.dev` `-p 3000`                                                                                                             |
| `backend`            | 3001 | Fastify 平台 API                                | **M2 核验**：`packages/backend/src/platform/config.ts` `PORT \|\| 3001`（实测默认 3001）。M2 定稿后若变更，回改 `nginx.conf` 内 `upstream backend` 一行 |
| `st-backend`         | 8000 | SillyTavern 主体                                | M1 确认 ST=8000                                                                                                                                         |
| `st-backend`         | 9091 | provision-api（同 st-bundle 容器副进程）        | M1 确认；`PROVISION_API_PORT` 默认 9091                                                                                                                 |

> watcher（health 9090）不经 nginx，M3 不串接。
> supabase realtime WebSocket 由前端**直连 supabase 域名**，不经 nginx。

## location 路由表（定稿）

按 nginx 优先级（精确 `=` > `^~` 前缀 > 正则 `~` > 普通前缀）自上而下：

| #   | location                                                                                                       | upstream        | 说明                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| 1   | `= /nginx-health`                                                                                              | —               | `return 200 "ok\n"`，`access_log off`                                                 |
| 2   | `= /api/init-st-session`                                                                                       | frontend:3000   | **前端 route handler**（`src/app/api/init-st-session/route.ts`），须先于 `/api/` 截胡 |
| 3   | `= /tavern`、`= /tavern/`                                                                                      | st-backend:8000 | ST iframe 入口，`proxy_pass http://st/` 重写到 ST 根 `/`                              |
| 4   | `~ ^/tavern/<UUID>/?$`                                                                                         | frontend:3000   | 对话页动态路由 `/tavern/[characterId]`                                                |
| 5   | `~ ^/api/characters/<UUID>$`                                                                                   | backend:3001    | 角色详情（`:id` 恒 UUID）                                                             |
| 6   | `^~ /api/bridge/`                                                                                              | backend:3001    | ST 反代桥（SSE/大文件，关缓冲）                                                       |
| 7   | `^~ /api/wallet/`、`^~ /api/payment/`                                                                          | backend:3001    | 钱包 / 支付                                                                           |
| 8   | `^~ /api/platform/`                                                                                            | backend:3001    | **LLM 代理网关（SSE）**，关缓冲 + 3600s 超时                                          |
| 9   | `= /api/users/settings`、`= /api/users/chats`                                                                  | backend:3001    | 平台用户设置 / 历史列表                                                               |
| 10  | `^~ /api/users/`                                                                                               | st-backend:8000 | ST 原生 `/api/users/*`（me/logout/...）                                               |
| 11  | `= /api/characters`                                                                                            | backend:3001    | 平台角色大厅列表（GET 集合）                                                          |
| 12  | `^~ /api/backends/chat-completions/`                                                                           | st-backend:8000 | 浏览器→ST 第二段 SSE，关缓冲                                                          |
| 13  | `/api/characters/`                                                                                             | st-backend:8000 | ST 原生 `/api/characters/<verb>`（all/get/edit…）                                     |
| 14  | `/api/`                                                                                                        | st-backend:8000 | ST 原生 `/api/*` 兜底（40+ 子路由）                                                   |
| 15  | `^~ /provision-api/`                                                                                           | st-backend:9091 | provision-api，剥离前缀（见安全说明）                                                 |
| 16  | `^~ /scripts/ /css/ /img/ /lib/ /locales/ /sounds/ /webfonts/`                                                 | st-backend:8000 | ST 静态资源根路径                                                                     |
| 17  | `^~ /backgrounds/ /characters/ /User%20Avatars/ /assets/ /user/ /thumbnail/`                                   | st-backend:8000 | ST 用户数据根路径                                                                     |
| 18  | `= /favicon.ico /manifest.json /style.css /script.js /lib.js /robots.txt /login.html /st.ico /st-launcher.ico` | st-backend:8000 | ST 根文件                                                                             |
| 19  | `/`（兜底）                                                                                                    | frontend:3000   | 所有前端页面（`/`、`/create`、`/profile/*`、`/_next/*` 等）                           |

### 与任务初稿路由表的对账（grep 修正项）

| 初稿                                                            | 实测修正                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/st/` → st-backend:8000（ST iframe）                           | **不存在 `/st/`**。ST iframe 实际入口是 `/tavern`（`src/components/bridge/st-iframe.tsx` `ST_IFRAME_URL = '/tavern/'`）。ST 用 `<base href="/">`，静态/原生 API 均在**根路径**，故按事实表 2/3 逐条枚举到 ST，不能加前缀                                |
| `/api/` 整段 → backend                                          | `/api/` 是 **frontend(route handler) + backend + ST 三方共享**命名空间。需精确/正则/前缀消歧：backend 仅 `bridge/characters(GET 集合+UUID)/users(settings,chats)/wallet/payment/platform`；其余 `/api/*` 全归 ST                                        |
| `/scripts/extensions/third-party/miniapp-bridge/` 单开 location | ST 自身 serve `/scripts/*`，已被 `^~ /scripts/` → ST 覆盖，无需单开                                                                                                                                                                                     |
| WebSocket（ST ws/SSE）                                          | ST **不使用 WebSocket**（vendor 无 `ws.Server`/`socket.io`）。但**有两段 SSE**（`/api/platform/llm-proxy/*`@backend、`/api/backends/chat-completions/*`@ST），已对其 location 关缓冲 + 3600s 超时。WebSocket header 机制（`map $http_upgrade`）保留备用 |

## SSE / WebSocket 处理

- 通用 proxy header（Host / X-Real-IP / X-Forwarded-For / X-Forwarded-Proto / X-Forwarded-Host / Upgrade / Connection）在 `http{}` 级声明一次（location 继承）。
- `proxy_http_version 1.1` 全局生效。
- `map $http_upgrade $connection_upgrade`：websocket → `Connection: upgrade`；普通/SSE → `Connection: ''`。
- 承载 SSE 的 location（`/api/platform/`、`/api/backends/chat-completions/`、`/api/bridge/`）追加：`proxy_buffering off`、`proxy_cache off`、`proxy_read_timeout 3600s`、`proxy_send_timeout 3600s`、`gzip off`。

## 安全说明 ⚠️

- **provision-api 无鉴权**，设计上仅供 backend 经内网（`*.railway.internal:9091`）调用，且源码默认绑 `127.0.0.1`（M4 容器内须注入 `PROVISION_API_BIND_HOST=0.0.0.0` 才可跨服务访问）。
- `/provision-api/` location 按任务路由表保留，但**公网暴露有风险**。生产建议：仅在受控内网开放，或在该 location 加 `allow`/`deny` 网段白名单、或直接删除此 location（backend 走内网直连不依赖网关）。

## 启动 / 验证

```bash
# 1) 语法校验（仅挂载 nginx.conf，自包含）
docker run --rm \
  -v "$(pwd)/ops/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" \
  nginx:1.27-alpine nginx -t

# 2) 构建网关镜像
docker build -t st-miniapp-nginx:dev ops/nginx

# 3) 跨平台构建 dry-run（amd64 + arm64，不落地产物）
docker buildx build --platform linux/amd64,linux/arm64 \
  --output type=cacheonly ops/nginx

# 4) frontend standalone 产物（M4 容器化复用）
cd packages/frontend && pnpm build
ls .next/standalone .next/static
```

## frontend standalone 注意事项（M4）

- `next.config.mjs` 已设 `output: 'standalone'`，产物在 `packages/frontend/.next/standalone`（含 `server.js`），静态资源在 `.next/static`。
- monorepo 下设了 `experimental.outputFileTracingRoot` 指向仓库根，standalone 会把 workspace 依赖（`@miniapp/shared`、`@miniapp/bridge-protocol`）一并追踪进产物。M4 Dockerfile 需把 `.next/static` 与 `public/` 拷到 standalone 对应目录，并以 `node packages/frontend/server.js` 启动（默认 `PORT=3000`、`HOSTNAME=0.0.0.0`）。
- **`NEXT_PUBLIC_*` 在 build 期固化**（standalone 不在运行时重读）。当前源码用到：`NEXT_PUBLIC_API_URL`、`NEXT_PUBLIC_USE_MOCK`、`NEXT_PUBLIC_USE_MOCK_INIT_DATA`、`NEXT_PUBLIC_MOCK_USER_ID`。本网关方案下前端与 backend 同源，build 时应令 `NEXT_PUBLIC_API_URL` 指向同源根（空串 → 相对 `/api/...`，由 nginx 路由到 backend），否则会写死成默认 `http://localhost:3001`。
- 未加 `basePath` / `assetPrefix`（前端挂在 nginx 根）。
- 既有 `rewrites()` 仅在 `ST_LOCAL_URL` 存在时（本地 dev）启用，用于 ST iframe 同源代理；**非 API 代理**。生产 `ST_LOCAL_URL` 不设 → 返回 `[]`，与 nginx 路由零冲突，故**保留不动**。
