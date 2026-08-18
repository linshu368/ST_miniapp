# ST 旧路径清理：混用清单（已执行）

> 状态：**已执行。** 2026-08-14 按 §5 归档到 `legacy/st-removed/`（保留 git 历史，未硬删除）。
> 2026-08-18 追加第二批：`chat_engine_mode` 开关、first-chat 埋点、`legacy/st-removed/` 本体与几个纯代码遗留已硬删除，见 **§8**。
> 前置：`docs/ST_remove-整包清理清单.md`（§2 / §3 已归档）
> 本份记录 **当时还活在 `packages/` / `ops/` / `scripts/` 里、和自研代码缠在一起** 的 ST / 预设 / simulation 残留，以及执行结果。

归档后 frontend 不再依赖 `@miniapp/bridge-protocol` 的 `file:` 指向。`mvp-regression` 已内联假上游与 fixtures，并删除 `billing_parity`。

归档目标仍是 `legacy/st-removed/`，按原相对路径放下。

---

## 1. 可整文件 / 整目录归档（目录内没有自研还要的代码）

### 1.1 前端纯 ST

| 路径                                                              | 说明                                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/frontend/src/lib/bridge/`                               | BridgeClient / 握手 / cookie / iframe 打点 / 乐观 action。清掉后才能拆 `file:` 依赖 |
| `packages/frontend/src/components/bridge/`                        | `STIframe`、`BridgeProvider`、`ModelPresetReconciler`                               |
| `packages/frontend/src/stores/st-mirror.ts`                       | ST iframe 状态镜像                                                                  |
| `packages/frontend/src/stores/chat-list.ts`                       | 只喂 ST `GET /api/users/chats`                                                      |
| `packages/frontend/src/lib/api/st-bridge.ts`                      | 懒下发角色卡                                                                        |
| `packages/frontend/src/lib/api/chats.ts`                          | ST recent 客户端                                                                    |
| `packages/frontend/src/lib/sentry/bridge-telemetry.ts`            | iframe/bridge 遥测                                                                  |
| `packages/frontend/src/app/tavern/[characterId]/page.tsx`         | ST 会话页（自研模式会 redirect 到 `/chat/...`）                                     |
| `packages/frontend/src/app/api/init-st-session/route.ts`          | 同源代理 st-session                                                                 |
| `packages/frontend/src/components/tavern/chat-header.tsx`         | 仅 ST 页                                                                            |
| `packages/frontend/src/components/tavern/chat-sidebar.tsx`        | 仅 ST 页                                                                            |
| `packages/frontend/src/components/tavern/chat-tools-menu.tsx`     | 仅 ST 页                                                                            |
| `packages/frontend/src/components/tavern/model-tier-switcher.tsx` | 仅 ST 页（写 ST 预设）                                                              |
| `packages/frontend/src/components/tavern/model-tools-sheet.tsx`   | 仅 ST 页                                                                            |

`ChatSplash` **不进本表**：自研 `/chat/[characterId]` 仍在用。

### 1.2 后端纯 ST / simulation

| 路径                                                 | 说明                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/backend/src/routes/bridge.ts`              | st-session + 单卡懒下发                                                         |
| `packages/backend/src/middleware/stProxy.ts`         | `/api/bridge/st/*`                                                              |
| `packages/backend/src/routes/chats.ts`               | ST recent 反代                                                                  |
| `packages/backend/src/features/chats/`               | ST 会话列表过滤                                                                 |
| `packages/backend/src/lib/st-cookie.ts`              | ST cookie Redis 缓存                                                            |
| `packages/backend/src/routes/simulation.ts`          | simulation 测卡 HTTP                                                            |
| `packages/backend/src/routes/debug.ts`               | iframe-timing 临时打点                                                          |
| `packages/backend/src/lib/llm-token.ts` + `.test.ts` | platformToken，只被 `llm-proxy` / `st-regression` 用                            |
| `packages/backend/src/platform/effective-presets.ts` | 解析 ST `platform_presets`                                                      |
| `packages/backend/src/routes/llm-proxy.ts`           | ST + simulation 的 OpenAI 透传外壳。自研对话走 `features/generation/`，不走这条 |

`llm-proxy.ts` 整文件可归档的前提：`mvp-regression` 的 `billing_parity` 先删掉（它会自签 token 打这条路由）。见 §3。

### 1.3 运营台纯 ST 预设

`App.tsx` **已经不挂** `PlatformPresetsView`，菜单也没有预设入口。下面是遗留文件，可整文件归档：

| 路径                                                      | 说明                                    |
| --------------------------------------------------------- | --------------------------------------- |
| `packages/admin/src/components/PlatformPresetsView.tsx`   | ST 预设管理页（零引用）                 |
| `packages/admin/src/lib/platformPresetsApi.ts`            | 调 `admin.list_platform_presets` 等 RPC |
| `packages/admin/src/lib/presetValidation.ts` + `.test.ts` | 校验酒馆 JSON                           |

`adminNavigation.test.ts` 里「`platform_presets` 回落到 configs」那条是兼容测试，属接线，不整文件挪。

### 1.4 契约层纯 ST / simulation

| 路径                                                                             | 说明                                                                 |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/shared/src/api/chats.ts`                                               | 旧列表契约                                                           |
| `packages/shared/src/api/st-session.ts`                                          | st-session / ensure-character                                        |
| `packages/shared/src/api/simulation.ts` + `__tests__/simulation.test.ts`         | 测卡契约                                                             |
| `packages/shared/src/platform-presets.ts` + `__tests__/platform-presets.test.ts` | ST payload 清洗                                                      |
| `packages/shared/src/st-bridge/`                                                 | `deriveStHandle`。`getOrCreateDbUser` 还在写 `st_handle`，见 §4 暂缓 |

### 1.5 根脚本

| 路径                               | 说明                                                                 |
| ---------------------------------- | -------------------------------------------------------------------- |
| `scripts/install-st-extension.mjs` | 仍写死 `ops/st-extensions` 与 `vendor/sillytavern`，一跑就找不到目录 |

---

## 2. 必须拆、不能整文件挪

清 §1 的时候要改这些调用方，文件本身留下。

### 2.1 前端

| 路径                                                   | 拆掉什么                                                                    | 留下什么                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `src/app/providers.tsx`                                | `LegacySTRuntime`、`BridgeProvider` 外壳                                    | QueryClient / TG / 支付回流 / 增长上报                              |
| `src/app/(main)/chats/page.tsx`                        | `StHistoryList`、`useBridgeStatus`                                          | 自研历史列表                                                        |
| `src/lib/chat-entry.ts` + `.test.ts`                   | `sillytavern` → `/tavern/...`                                               | `self_hosted` → `/chat/...`                                         |
| `src/components/characters/character-gallery.tsx`      | `useBridgeStatus`、`prefetchEnsureStCharacter`                              | 大厅点卡、`beginFirstChatNavigation`                                |
| `src/components/characters/character-detail-sheet.tsx` | `prefetchEnsureStCharacter`                                                 | 角色详情浮层                                                        |
| `src/lib/api/models.ts`                                | `fetchEffectivePreset` / `useEffectivePresetQuery`、catalog 的 60s 预设轮询 | `useModelCatalogQuery` / `useSelectModelMutation`（自研切模型仍用） |
| `next.config.mjs`                                      | ST rewrite、`transpilePackages` 里的 `bridge-protocol`、`file:` 依赖        | Next 配置本身                                                       |
| `package.json`                                         | `"@miniapp/bridge-protocol": "file:..."`                                    | 其余依赖                                                            |

`first-chat-telemetry.ts` 大厅 / 聊天 Tab / `api/client.ts` 仍调用，**本轮不整文件归档**；只删 tavern 页那些 iframe 停摆打点。`ChatSplash` 同上。

### 2.2 后端

| 路径                             | 拆掉什么                                                                  | 留下什么                 |
| -------------------------------- | ------------------------------------------------------------------------- | ------------------------ |
| `src/app.ts`                     | 注册 `bridge` / `chats` / `stProxy` / `debug` / `simulation` / `llmProxy` | 其余路由、CORS、health   |
| `src/platform/config.ts`         | `ST_BASE_URL` / `ST_PROVISION_URL` / `ST_USER_PASSWORD_SECRET`            | 其余 env                 |
| `src/routes/models.ts`           | `resolveEffectivePresetForModel`、`GET /api/v1/models/effective-preset`   | 目录 / 选模型 / 余额闸门 |
| `src/lib/chat-history-logger.ts` | ST 路径 `session_id = NULL` 的 INSERT 分支                                | 自研按预建 id UPDATE     |
| `src/lib/user.ts`                | 见 §4：`st_handle` 暂缓                                                   | 建用户逻辑本身留下       |
| `package.json`                   | `st:regression` / `st:regression:diff`                                    | `mvp:regression`         |

`features/generation/` **整目录留下**（注释里会提到 llm-proxy，只改注释不必挪）。

### 2.3 shared / admin

| 路径                                             | 拆掉什么                                                                                                           | 留下什么              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `packages/shared/src/index.ts`                   | re-export chats / st-session / simulation / platform-presets / st-bridge（若 `st_handle` 仍写则 `st-bridge` 暂留） | 其余契约              |
| `packages/shared/src/api/models.ts`              | `EffectivePresetSummary` 并进 catalog/select 响应、`GetEffectivePresetData`                                        | 模型目录 / 选模型 DTO |
| `packages/admin/src/lib/adminNavigation.test.ts` | `platform_presets` 回落那条用例                                                                                    | 其余导航测试          |

---

## 3. 脚本混用（已按此拆开）

归档 `st-regression/` 之前必须先解耦 `mvp-regression`，否则会 import 失败。已按此做完：

| 脚本                                               | 执行结果                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/backend/src/scripts/st-regression/`      | 已整目录归档到 `legacy/st-removed/`                                                                                  |
| `packages/backend/src/scripts/mvp-regression/`     | **留下**。已内联 `mock-upstream.ts` 与 fixtures，删除 `billing_parity`，不再 import `st-regression` / 打 `llm-proxy` |
| `packages/backend/src/scripts/chat-engine-mode.ts` | 本档留下；开关整条链已于 2026-08-18 删除，见 §8                                                                      |

---

## 4. 本轮建议暂缓

| 项                                                                     | 原因                                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| ~~`chat_engine_mode` 及前后端开关接线~~                                | **已于 2026-08-18 删除，见 §8**                                  |
| `users.st_handle` / `deriveStHandle` / `getOrCreateDbUser` 里写 handle | 列还在；停写要单独 migration，不跟混用代码绑在一起               |
| ~~`first-chat-telemetry.ts`~~                                          | **已于 2026-08-18 删除，见 §8**；`ChatSplash` 仍被自研聊天页使用 |
| ~~`ops/nginx/nginx.conf`、`nginx.local.conf`~~                         | **已于 2026-08-18 随网关收敛删除，见 §9**                        |
| ~~`.railway/railway.ts` 里的 `st-bundle` 服务~~                        | **已于 2026-08-18 随网关收敛删除，见 §9**                        |
| 历史 SQL（`006_platform_presets` 等）                                  | 只记账，不改已执行的 migration                                   |

---

## 5. 建议执行顺序（确认后）

1. **脚本接缝**：把 mvp-regression 从 st-regression 解耦，删 `billing_parity`
2. **前端纯 ST 文件**（§1.1）+ providers / chats 页 / chat-entry 接线（§2.1）→ 拆掉 `file:` 依赖
3. **后端纯 ST / simulation 文件**（§1.2）+ `app.ts` / `models.ts` 接线（§2.2）
4. **admin 遗留预设文件**（§1.3）+ shared 契约（§1.4）
5. **根脚本** `install-st-extension.mjs`
6. nginx / Railway / `chat_engine_mode` 另开，不塞进这一档

---

## 6. 确认项（已批，已执行）

- [x] §1 可整文件归档的范围没问题
- [x] §2 混用文件只拆 ST 侧、文件留下
- [x] §3：mvp-regression 先解耦再归档 st-regression / llm-proxy
- [x] §4 暂缓项（开关、`st_handle`、nginx、Railway）本档不动
- [x] 执行顺序按 §5

---

## 7. 执行结果（2026-08-14）

归档方式：`git mv` 到 `legacy/st-removed/`，保留原相对路径与 git 历史，不做硬删除。

已完成：

1. `mvp-regression` 解耦，删除 `billing_parity`；`st:regression` / `st:regression:diff` 脚本去掉
2. 前端纯 ST 文件归档；`Providers` 不再挂 iframe；`chatEntryPath` 只生成 `/chat/...`；拆掉 `@miniapp/bridge-protocol` 的 `file:` 依赖与 Next ST rewrite
3. 后端不再注册 bridge / chats / stProxy / debug / simulation / llm-proxy；去掉 `ST_BASE_URL` / `ST_PROVISION_URL` / `ST_USER_PASSWORD_SECRET`；模型接口不再解析 ST 预设；`chat_history` 只按预建 id UPDATE
4. admin 预设页与 shared 的 chats / st-session / simulation / platform-presets 契约归档；`st-bridge` / `deriveStHandle` 因 `st_handle` 暂缓而留下
5. `scripts/install-st-extension.mjs` 归档

`pnpm typecheck` 与 `pnpm lint:imports` 在执行后通过。§4 暂缓项本档未动。

---

## 8. 第二批：暂缓项中的开关与埋点（2026-08-18）

本轮**硬删除**，不再进 `legacy/st-removed/`：归档的意义由 git 历史本身承担，而 `legacy/` 已经 1.2G。

### 8.1 `chat_engine_mode` 全局开关

前置条件已满足——ST 会话页与 bridge 体系在第一批里已归档，前端 `useChatEngine()` 因此变成零调用方，兜底值 `'sillytavern'` 也已没有可回落的目标。整条链一次删净：

| 路径                                                  | 处理                                         |
| ----------------------------------------------------- | -------------------------------------------- |
| `packages/shared/src/api/chat-engine.ts`              | 删除，`shared/src/index.ts` 去掉 export      |
| `packages/backend/src/platform/chat-engine.ts` + 测试 | 删除                                         |
| `packages/backend/src/routes/chat-engine.ts`          | 删除，`app.ts` 去掉 import 与 register       |
| `packages/backend/src/scripts/chat-engine-mode.ts`    | 删除，`package.json` 去掉 `chat-engine:mode` |
| `packages/frontend/src/lib/api/chat-engine.ts`        | 删除                                         |

数据库侧新增 `packages/shared/migrations/083_drop_chat_engine_mode.sql`，DELETE 掉 075 建的那一行。
执行前该 key 已无消费方，删行不改变运行时行为；`chat_engine_mode` 不在 `admin.is_managed_config_key`
白名单内，`admin.config_drafts` / `config_releases` 不会有指向它的行。**需手动触发 `Database Migration`。**

### 8.2 first-chat 埋点

按「不重写、直接删」处理（现在没有点卡耗时问题，需要时再针对性埋）：

| 路径                                                     | 处理                                                                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/src/lib/sentry/first-chat-telemetry.ts` + 测试 | 删除。14 个导出里当时只剩 `getFirstChatCorrelation` 有调用方，span 名仍是 iframe 时代口径                                                                                                                     |
| `frontend/src/lib/api/client.ts`                         | 删掉 `applyTelemetryHeaders`                                                                                                                                                                                  |
| `backend/src/lib/sentry.ts`                              | 去掉 `journeyId` / `attemptId` / `bootSessionId` 与对应 header 读取；删 `downstreamTelemetryHeaders`（零调用方，作用就是把这些头转发给 ST）；`captureBackendException` 的 `first_chat` context 改名 `request` |
| `backend/src/app.ts`                                     | CORS 去掉 `X-First-Chat-Journey-Id` / `X-First-Chat-Attempt-Id` / `X-Boot-Session-Id`                                                                                                                         |
| `backend/src/lib/sentry.test.ts`                         | 收窄到 `requestId` 一条关联键                                                                                                                                                                                 |

⚠️ **副作用**：`applyTelemetryHeaders` 顺带承担了 `sentry-trace` / `baggage` 透传（仅在 first-chat
journey 存在时触发），删掉后前端到后端的 trace 关联消失。要恢复得改成「无条件透传」，属于新增行为，本轮未做。

### 8.3 归档目录与剩余纯代码遗留

| 项                                             | 处理                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legacy/st-removed/`（1260 文件 / 1.2G）       | **整个删除**。它不在 pnpm workspace、不进 CI lint、不进任何镜像构建上下文；归档语义由 git 历史承担，取回用 `git show 6206f3a:<原路径>`                                                                                                                                       |
| 根 `.dockerignore`                             | 删除。文件头就写明只服务 `Dockerfile.st-bundle`（已删），而两个在用镜像各有 `<dockerfile>.dockerignore` sidecar（CI 走 buildx，BuildKit 认它）。留着还有隐患：它 exclude 了 `packages/backend` / `packages/frontend`                                                         |
| `packages/shared/scripts/generate-seed-sql.ts` | 删除（目录随之空掉）。它从本机 SillyTavern 数据目录读 PNG / `settings.json`，产物是已在各环境执行过的 `011_seed_data.sql`，且 `st_platform.*` 三张表已无消费方。README 的「重新生成种子数据」一节同步改成说明                                                                |
| `ops/env/backend.env.production.example`       | 删掉 `ST_USER_PASSWORD_SECRET` / `LLM_PROXY_TOKEN_SECRET` / `ST_BASE_URL` / `ST_PROVISION_URL` / `SIMULATION_*`（代码里已全部零引用），并修掉 `LLM_API_KEY`、`UPSTASH_*`、`CHAT_HISTORY_SYNC_ENABLED` 三处提到 ST / 模拟环境的注释                                           |
| `ops/env/vercel.env.production.example`        | 本轮 `ST_PUBLIC_PROXY_URL` **暂留**：它仍被 `frontend/src/app/api/lobby-characters/route.ts` 当作 backend 地址兜底。模板里「next.config.mjs 据此启用 rewrites 转发 /tavern/\*」已是错的（rewrites 在第一批就删了），先改成如实描述；变量本身归网关收敛那一档（已于 §9 删除） |
| `frontend/src/components/tavern/`              | 目录只剩 `chat-splash.tsx`（自研聊天页在用），挪到 `components/chat/` 并改掉唯一的 import，空目录删除                                                                                                                                                                        |

`chat-top-bar.tsx` / `chat-session-drawer.tsx` 注释里「几何对齐原版 ST 链路的 `components/tavern/chat-header.tsx`」保留：
那是说明取值来源的设计注记，指向的是历史文件而不是现存依赖。

### 8.4 验证

`pnpm typecheck`（5 个包）、`pnpm lint:imports`、shared 52/52、frontend 49/49 全绿；
backend 228/229，唯一失败是 `conversations.integration.test.ts` 里 `pref_word_count` 默认值断言
（期望 `300-500`，test 库现在给 `500-800`），属 test 库与 015 列默认值的漂移，与本轮改动无关。

---

## 9. 网关收敛（2026-08-18 执行）

§4 里挂了很久的两项暂缓（nginx 与 `.railway/railway.ts` 的 `st-bundle`）在这一档一起落地。
定下来的形态是 **Vercel 直连 backend**：ST 退场后 nginx 已无分发对象，`next.config.mjs`
本来就没有任何 rewrites、仓库里也没有 `vercel.json`，前端走的是 `NEXT_PUBLIC_API_URL`
直连——nginx 已经不在浏览器到 backend 的路径里，只剩一层可删的声明。

### 9.1 删除与改写

| 路径                                                                                              | 处理                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ops/nginx/`（Dockerfile / nginx.conf / nginx.local.conf / README）                               | 整个删除                                                                                                                                                                                                                                       |
| `ops/env/nginx.env.production.example`                                                            | 删除                                                                                                                                                                                                                                           |
| `.railway/railway.ts`                                                                             | 删掉 `service('nginx')`、`service('st-bundle')` 与卷 `st-bundle-data`，以及 backend 段里零引用的 `ST_BASE_URL` / `ST_PROVISION_URL`；`resources` 只剩 `stminiapp`                                                                              |
| `.github/workflows/ci.yml`                                                                        | `docker-build` 矩阵去掉 nginx（否则 CI 直接红：构建目标指向已删目录）                                                                                                                                                                          |
| `.github/workflows/build-and-push.yml`                                                            | 矩阵去掉 nginx，`verify-multiarch` 的 `names` 收窄为 `backend`                                                                                                                                                                                 |
| `docker-compose.yml`                                                                              | 删 nginx 服务与它的 bind-mount；改为 frontend 映 `3000:3000`、backend 映 `3001:3001`，`NEXT_PUBLIC_API_URL` 默认 `http://localhost:3001`                                                                                                       |
| `.env.compose.example`                                                                            | 删整个 st-backend 段与 `ST_*` / `LLM_PROXY_TOKEN_SECRET` / `SIMULATION_SERVICE_KEY`（代码零引用），仍在用的 `DATABASE_ENV` / `LOG_LEVEL` / `CHARACTER_STORAGE_BUCKET` 归回 backend 段；`FRONTEND_URL` 与 `PAYMENT_*` 回调从 `:8080` 改到新端口 |
| `ops/env/vercel.env.production.example`                                                           | 删 `ST_PUBLIC_PROXY_URL`；`NEXT_PUBLIC_API_URL` 从「留空=同源」改成 **[必填] backend 公网域名**                                                                                                                                                |
| `frontend/src/app/api/lobby-characters/route.ts`                                                  | 去掉 `ST_PUBLIC_PROXY_URL` 兜底，只留 `NEXT_PUBLIC_API_URL` 与本地默认值                                                                                                                                                                       |
| `ops/README.md` / `ops/env/README.md` / `ops/railway/README.md`                                   | 三服务拓扑改写为单服务；`ops/README.md` 顺带删掉整段 st-bundle 镜像文档与 backend 环境变量表里零引用的 `ST_*` / `LLM_PROXY_TOKEN_SECRET` 行                                                                                                    |
| `ops/docker/Dockerfile.frontend`、`ops/git/prompts/diff_review.md`、`conversations/sse.ts` + 测试 | 注释与审查规则里的 nginx 措辞收尾（`X-Accel-Buffering: no` 头保留，任何反代都可能缓冲）                                                                                                                                                        |

### 9.2 代价与手动收尾

前端与 backend 变成跨域直连，`NEXT_PUBLIC_API_URL`（Vercel，build 期固化）与 `FRONTEND_URL`
（backend CORS）必须成对配好，任一侧错即浏览器侧请求全挂。

仓库改动不会自动同步 Railway（IaC 需手动 `config apply`），因此控制台侧还需人工执行：
确认 Vercel 已指向 backend 公网域名 → 删 `nginx-pro` / `nginx` → 导出后删 `st-bundle-pro` /
`st-bundle` 与卷 `st-data-pro` / `st-bundle-data`。步骤见 `ops/railway/README.md`
「网关收敛的手动收尾」。
