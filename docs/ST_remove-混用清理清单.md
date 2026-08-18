# ST 旧路径清理：混用清单（已执行）

> 状态：**已执行。** 2026-08-14 按 §5 归档到 `legacy/st-removed/`（保留 git 历史，未硬删除）。
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
| `packages/backend/src/scripts/chat-engine-mode.ts` | 开关还在，本档留下                                                                                                   |

---

## 4. 本轮建议暂缓

| 项                                                                                                          | 原因                                                             |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `chat_engine_mode` 及 `platform/chat-engine.ts`、`routes/chat-engine.ts`、frontend `lib/api/chat-engine.ts` | ST 页清掉之前还是回滚开关；清完再改兜底 / 删分支                 |
| `users.st_handle` / `deriveStHandle` / `getOrCreateDbUser` 里写 handle                                      | 列还在；停写要单独 migration，不跟混用代码绑在一起               |
| `ChatSplash`、`first-chat-telemetry.ts`                                                                     | 自研聊天开屏 / 点卡耗时还在用                                    |
| `ops/nginx/nginx.conf`、`nginx.local.conf`                                                                  | 还在给 backend 反代；只能拆 `/tavern` 与 ST 静态分档，整文件不挪 |
| `.railway/railway.ts` 里的 `st-bundle` 服务                                                                 | 改的是生产拓扑，不跟代码归档同一 PR                              |
| 历史 SQL（`006_platform_presets` 等）                                                                       | 只记账，不改已执行的 migration                                   |

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
