# ST_miniAPP 架构说明（自研引擎版）

> 本文档描述 **自研 prompt 引擎替换 SillyTavern 之后的目标架构**（2026-08-12 重写）。
> 替换的动机、12 项关键决策与删除清单见 `docs/ST_remove.md`；MVP 的实施细节与验收结论见 `docs/ST_remove-MVP实施方案.md`。
>
> 上一版（2026-07-13）描述的是"平台壳 + ST iframe + bridge + provision"的架构，已整体作废：
> vendor/sillytavern、bridge-protocol、st-extension、sync-engine provision/watcher、postMessage 协议、iframe 冷启动专项等内容不再是本项目的架构组成部分，本文档不再收录。
>
> **状态口径**（每条能力都带标注，不标注即为 ✅）：
>
> | 标注 | 含义                                                                    |
> | ---- | ----------------------------------------------------------------------- |
> | ✅   | 已落地并有测试/回归覆盖                                                 |
> | ⏳   | 在建或待建（M5 自研聊天 UI、M6 切换与账号链路）                         |
> | 🔜   | 代码已就绪，但要等 M6 打开全局开关、生产库执行 069~073 之后才在生产生效 |
> | ❌   | 明确不做 / 尚未创建                                                     |
>
> 当前进度：M1 / M2 / M3a / M3b / M5 已交付，测试与生产已切到自研引擎。ST 旧路径先归档到 `legacy/st-removed/`，2026-08-18 连同 `chat_engine_mode` 全局开关、first-chat 埋点、ST 专用 seed 生成器与根 `.dockerignore` 一并硬删除（取回用 `git show 6206f3a:<原路径>`；migration 083 待手动执行），过程见 `docs/ST_remove-整包清理清单.md` 与 `docs/ST_remove-混用清理清单.md`。仍暂缓：nginx `/tavern` 与 Railway `st-bundle`（等网关收敛定稿）、`users.st_handle` 与 `st_*` schema（归 Supabase 瘦身专项）。

---

## 1. 架构铁律（违反即拦截）

1. **对外数据形状先定义在 `packages/shared/`**，再写 handler。backend 不得在包内私定对外类型（backend CLAUDE.md 硬规则 4）。
2. **每条路由注册上方必须有 `@frontend-ready: true|false — 原因`**，半成品要写出带业务含义的原因（硬规则 1、2）。
3. **应用包互不 import**：`frontend` / `backend` / `cs-platform` / `admin` 之间没有 import 关系，跨进程一律走 HTTP。
4. **DB 类型不进前端**：前端与运营台只消费 `shared/api/*` 契约，不接触数据库行类型。
5. **前端不在组件里 fetch**：服务端数据统一走 `frontend/src/lib/api/` 的 React Query hooks；跨组件状态用 Zustand，局部状态用 `useState`（frontend CLAUDE.md）。
6. **生成与计费只有一个出口**：任何要调 LLM 的路径都必须走 `backend/src/features/generation/`。禁止在别处另起一套"转发 + 扣费 + 落库"，否则计费口径必然漂移。
7. **`runtime_config` 只有一个读取入口**：`backend/src/platform/runtime-config.ts`。模型目录、定价、平台规则模板都从这里取，不允许并行实现第二套读法。
8. **迁移不随部署自动执行**：`packages/shared/migrations/*.sql` 由 GitHub Actions `Database Migration` 手动逐个触发，编号单调递增（历史有重号，见 §7.4）。
9. **TypeScript 严格模式，禁止 `any`**。

---

## 2. 架构总览

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ 用户（Telegram Mini App WebView）              内部运营                          │
│ ┌──────────────────────────────────────┐ ┌──────────────┬───────────────────┐  │
│ │ packages/frontend  Next.js App Router │ │ cs-platform  │ admin             │  │
│ │  (main) 大厅 / 聊天 / 创作 / 我的      │ │ 回访 + 客服   │ 运营配置/角色卡/   │  │
│ │  /tavern/[characterId] 会话页          │ │ (Vite :3002) │ 预设/分析(:3003)  │  │
│ │    ├ 消息区（自研，接 SSE）  ⏳M5      │ └──────┬───────┴─────────┬─────────┘  │
│ │    └ 侧边栏=会话列表 / 模型切换         │        │                 │            │
│ │  lib/api + React Query + Zustand      │        │ X-CS-Admin-     │ Supabase   │
│ └───────────────┬──────────────────────┘        │ Token           │ session    │
└─────────────────┼───────────────────────────────┼─────────────────┼────────────┘
                  │ ① REST + SSE（X-Init-Data）    │ ④              │ ④
                  ▼                                ▼                 ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │ packages/backend（Fastify 5，Railway）                            │
        │                                                                   │
        │  对话链路（核心）                                                  │
        │   routes/conversations.ts  /api/v1/conversations/*  REST + SSE    │
        │     └ features/conversations  编排：预建轮次 → 组 prompt → 生成    │
        │         ├ features/engine      prompt 组装（纯函数）              │
        │         └ features/generation  免费额度 → 余额预检 → 上游 → 落库  │
        │                                                                   │
        │  平台业务：characters / favorites / wallet / payment / wishes /   │
        │            settings / models / notifications / support            │
        │  运营与增长：/api/cs/* · /api/growth/* · /api/telegram/webhook     │
        └──────┬────────────────────────────────────────┬──────────────────┘
               │ ③ Prisma + supabase-js                 │ ② HTTPS（SSE）
               ▼                                        ▼
┌────────────────────────────────────────────┐  ┌───────────────────────────┐
│ Supabase（PostgreSQL + Storage）            │  │ OpenRouter（LLM 上游）     │
│  ├ miniapp.*     用户 / 角色卡 / 会话 /      │  │  平台真实 key 只在 backend │
│  │               chat_history / 钱包 / 计费  │  └───────────────────────────┘
│  ├ cs_platform.* 回访画像与会话              │
│  ├ growth.*      渠道归因                    │       ⑤ Telegram Bot webhook
│  └ public.*      旧 bot 体系（隔离，仍运行）  │       → /api/telegram/webhook
│  Storage: character-assets / 头像            │
└────────────────────────────────────────────┘
```

### 链路编号

| 编号 | 方向                          | 用途                                                                 |
| ---- | ----------------------------- | -------------------------------------------------------------------- |
| ①    | frontend → backend（HTTP/SSE) | 全部业务 REST；对话发消息与重生成是 `text/event-stream`              |
| ②    | backend → OpenRouter          | 唯一的 LLM 出口，平台真实 key 只在 backend 进程内                    |
| ③    | backend ⇆ Supabase            | Prisma（`miniapp.*` / `public.*`）+ supabase-js（RPC / 其他 schema） |
| ④    | cs-platform / admin → backend | 运营台 REST；CS 走 `X-CS-Admin-Token`，admin 走 Supabase 会话        |
| ⑤    | Telegram → backend            | Bot `/start` 归因、用户回复回流 CS                                   |

**与旧架构的关键差别**：不再有 iframe、不再有跨进程 postMessage、不再有 provision 下行与文件系统回流。**会话的运行时真相直接落在 PostgreSQL**，而不再是某个容器里的 ST 数据目录，因此不需要网关做 `/tavern/*` 分发，也不需要有状态的数据卷。

---

## 3. 包清单

### 3.1 契约层

| 包         | 职责                                                                                          | 消费者      |
| ---------- | --------------------------------------------------------------------------------------------- | ----------- |
| `shared`   | 跨包唯一契约来源：`src/api/*` 的 17 个 REST 契约文件、`migrations/`（SQL 迁移）、纯工具与常量 | 所有包      |
| `db-types` | Supabase schema 镜像（机器生成）。生成范围只覆盖 ST 同步层三个 schema，随 ST 一起退场 ❌      | —（未接线） |

`shared/src/api/` 逐个文件：`envelope`（统一响应包络 `ok()` / `fail()`）、`characters`、`favorites`、**`conversations`**（自研对话链路契约）、`models`、`settings`、`wallet`、`payment`、`wishes`、`notifications`、`support`、`cs-platform`、`growth`、`health`、`chats`（旧列表契约，随 ST 退场）、`st-session`（同上）、`simulation`（测卡系统，见 §9）。

> 计划中的独立 `api-contract` 包始终未创建 ❌，职责留在 `shared/api`，也没有拆分计划。

### 3.2 应用层

| 包            | 职责                                                                                                                    | dev 端口 | 部署                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------- |
| `frontend`    | Next.js 14 App Router：大厅 / 会话页 / 消息 / 充值 / 许愿池；React Query + Zustand；Telegram Mini App SDK               | 3000     | Vercel                  |
| `backend`     | Fastify 5：对话 REST + SSE、prompt 引擎、生成与计费出口、平台业务 REST、CS / 增长 / Bot webhook                         | 3001     | Railway（容器内 :8080） |
| `admin`       | 运营后台：运营配置发布、角色卡、平台预设、公告、数据分析（12 个 section）、发布历史、审计。Vite + React + AntD + Refine | 3003     | Vercel                  |
| `cs-platform` | 内部运营平台：CS 回访工作台（画像簇 / Telegram 1V1 SOP / 导出）+ 站内客服。Vite + React + React Query                   | 3002     | Vercel                  |

### 3.3 依赖方向（强制）

```
契约层：
  shared ──► 可被任意应用包 import

应用层：
  frontend     ──► shared
  backend      ──► shared, prisma-client, supabase-js
  admin        ──► shared
  cs-platform  ──► shared

禁止：
  ✗ 应用包 → 应用包（跨进程一律 HTTP）
  ✗ 契约层 → 应用包
  ✗ 前端 / 运营台 → 数据库行类型
  ✗ 任何 import 环
```

---

## 4. 对话链路（核心）

这是替换 ST 后新增的主链路，也是本项目唯一的"业务执行引擎"。ST 时代由 iframe 内部状态机承担的角色切换、会话管理、消息生成，现在全部发生在 backend 进程里。

### 4.1 分层

| 层             | 位置                                                      | 性质                                                                   |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| 路由与鉴权     | `routes/conversations.ts`                                 | 8 条路由，统一 `requireTelegramAuth`；ownership 落在仓库层             |
| 编排           | `features/conversations/`                                 | `generate.ts`（一轮生成）/ `history.ts` / `sse.ts` / `errors.ts`       |
| Prompt 组装    | `features/engine/`                                        | 纯函数，无 IO（唯一有 IO 的是读平台规则的 `platform-instructions.ts`） |
| 生成与计费出口 | `features/generation/`                                    | 免费额度 → 余额预检 → 上游转发 + SSE tap → 终态落库与实扣              |
| 持久化         | `ChatSessionRepository` / `ConversationHistoryRepository` | supabase-js + 原子 RPC                                                 |

### 4.2 接口清单（`/api/v1`）

| 方法 / 路径                                 | 职责                                                                |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `POST /api/v1/conversations`                | 建会话，返回 session + 虚拟 turn 0 开场白，不写 chat_history        |
| `GET /api/v1/conversations`                 | 会话列表（跨角色，支持 `character_id` 过滤 + 分页），直读 DB        |
| `GET /api/v1/conversations/:id`             | 会话详情 + 消息分页（`before_turn_index` 向前翻页）                 |
| `PATCH /api/v1/conversations/:id`           | 重命名（`title: null` = 恢复自动命名）                              |
| `DELETE /api/v1/conversations/:id`          | 软删（`deleted_at`）                                                |
| `POST /api/v1/conversations/:id/messages`   | **发消息 + SSE 流式回复**                                           |
| `POST /api/v1/conversations/:id/regenerate` | 重生成最后一轮，同样 SSE                                            |
| `GET` · `PATCH /api/v1/generation-config`   | 用户生成配置读写（三个 `pref_*`；改模型走 `/api/v1/models/select`） |

SSE 事件契约定义在 `shared/src/api/conversations.ts`：`start`（带 message id / turn_index / revision）→ `delta`（增量片段，非累积）→ `done`（终态 + finish_reason），流开始后才发生的错误走 `error` 事件。

### 4.3 一轮生成的执行序列

```
1. requireTelegramAuth → userId；校验 session 归属
2. 并行取数：模型解析 / 角色卡 / 用户生成配置 / 昵称 / 平台规则模板
3. RPC start_chat_history_turn（或 start_chat_history_regeneration）
   → 会话行锁内分配 turn_index，插入 status='streaming' 的 chat_history 行
4. 读本轮之前各轮的最大 revision 展开历史；首轮用角色卡开场白，之后从首轮 prompt 快照恢复
5. features/engine 组 messages，把完整 prompt 快照写回本轮 history 字段
6. features/generation execute()：免费额度预留 → 定档扣费额 → 余额预检
   · 预检不过 → 收口成 insufficient_balance，路由返回 HTTP 402 JSON
   · 上游非 2xx / 连不上 → 路由返回 HTTP 502 JSON
   · 上游 2xx → onStreamOpen 回调，此时才写 SSE 响应头并下发 start 事件
7. 边转发 delta 边累积；客户端断开不终止后端，继续 drain 到 [DONE]
8. 终态：同步更新同一条 chat_history 的正文与状态；实扣与 OpenRouter 元数据异步补齐
```

**硬约束**：SSE 首字节写出之前不能有任何可能失败的判定。402（余额不足）、409（会话忙 / 不可重生成）、404 全部以 HTTP 状态码 + JSON 返回；响应头一旦发出就只能降级成流内 `error` 事件。所以响应头推迟到上游已 2xx 的 `onStreamOpen` 才写——不是等第一个 token，否则客户端要白等一整个上游首 token 延迟才能挂上占位气泡。

### 4.4 Prompt 组装（`features/engine`）

v1 是旧 bot `SimplePromptEngine` 的忠实移植，最终形状：

```
[system: 角色卡 system_prompt] + 历史（含虚拟 turn 0 开场白） + [user: 平台规则 + 本轮输入]
```

- **不消费预设**：`st_platform.platform_presets` 是只有 ST 的 PromptManager 能消费的酒馆格式。自建预设格式后再一次性适配（M4，见 §10）。
- **不注入 `first_mes`**：开场白由编排层放进 history，引擎再注入会每轮重复一条。
- **不做上下文长度管理**：历史全量入 prompt，`truncatedTurns` 恒为 0。bot 的"水位线泄洪"机制待复现（§10）。
- **不做酒馆语义适配**：宏、世界书、正则、卡内嵌资源一律不支持，表现质量由 system prompt 与组装逻辑承担。
- 角色卡只取 `system_prompt`；`description` / `personality` / `scenario` / `mes_example` / `post_history_instructions` 已在接缝里占位但 v1 不进 prompt。

平台规则来自 `miniapp.runtime_config` 三个 key，5 分钟 TTL 缓存、按 `version` 判活，缺失或格式损坏时降级到内置兜底并打 `degraded` 标记：

| key                       | 内容                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `system_instructions`     | 平台规则模板，含 `{{WORD_COUNT}}` / `{{INTERACTION_MODE}}` / `{{USER_CUSTOM_INSTRUCTIONS}}` 三个占位符 |
| `interaction_mode_blocks` | `pref_show_options` 二选一的正文块                                                                     |
| `pref_word_count_tiers`   | 字数档位表，label 必须覆盖 `PreferredWordCount` 全部取值，否则静默回落                                 |

### 4.5 生成与计费出口（`features/generation`）

| 文件                | 职责                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------- |
| `resolve-model.ts`  | 权威模型解析：用户 `selected_model_id` → 模型目录 → `ResolvedModel`                     |
| `quota.ts`          | 角色免费额度 `reserve` / `finalize` 两阶段                                              |
| `precheck.ts`       | 定档扣费额与计费快照、余额预检（402 判定，不构造响应）                                  |
| `upstream.ts`       | 上游转发原语 + SSE tap（逐字节透传、抓 `generation_id` / `finish_reason`、判 `[DONE]`） |
| `prompt-caching.ts` | Anthropic `cache_control` 断点注入，打在历史最后一条而非包装后的本轮输入                |
| `execute.ts`        | `GenerationService`：把上面串成一条出口，供对话链路直调                                 |

计费要点：定档扣费（`billing_mode: 'fixed_tier'`，配置在 `runtime_config.llm_pricing_config`）；免费额度按**用户 × 角色**计轮，上限来自 `runtime_config.miniapp_character_free_chat_quota_limit`（默认 40）；实扣走 RPC `miniapp.charge_llm_usage`，幂等键是 `charge_id`；只有见到 `[DONE]` 才算成功，流中断与上游错误都不扣费。

---

## 5. 数据模型与真相归属

### 5.1 会话存储（072 收口）

```
miniapp.chat_sessions  1 ─── N  miniapp.chat_history
```

- `chat_sessions`：一行一个会话，支持同一用户 × 同一角色多会话；`title` 可空（空 = 前端按首条用户消息显示）；`message_count` / `last_message_at` / `last_message_preview` 由触发器维护，应用层不直接写；软删用 `deleted_at`。
- `chat_history`：一行 = 某 session 内一个逻辑 turn 的一个生成 revision，同时是**上下文、计费与审计的唯一事实来源**。`history` 字段保存本次实际发给模型的完整 messages 快照。
- `turn_index`：用户主动发起的轮次，从 1 递增，重生成不增加。`revision`：同一轮的生成版本，首次 0，重生成 +1，**最大 revision 即当前版本**（不需要 `is_active`）。唯一索引 `(session_id, turn_index, revision)`。
- 开场白不单独落行：新会话由 API 返回虚拟 turn 0；首轮生成时进入 prompt 快照，之后从快照恢复。
- `miniapp.current_chat_history`（073 视图）：数据库侧固化每轮最大 revision，分页不必把全部旧版本拉回应用层。

三个原子 RPC 以 `chat_sessions FOR UPDATE` 为串行点：

| RPC                               | 作用                                                                      |
| --------------------------------- | ------------------------------------------------------------------------- |
| `start_chat_history_turn`         | 锁 session、清理陈旧 streaming、分配 `max(turn_index)+1`、插入 revision 0 |
| `start_chat_history_regeneration` | 锁 session、校验是最后一轮、复用 `user_input`、插入 `max(revision)+1`     |
| `guard_chat_session_idle`         | 有 120 秒内的 `streaming` 行则抛 `55006`（→ 409）；陈旧行先收口再放行     |

> 存量聊天记录**不迁移**（总方案决策 1）：`chat_history` 存量行只有 user_id + character_id 两维、没有 session 概念，合并成单会话会把多段无关对话喂进 prompt 窗口。存量数据留档供运营与审计，不对用户呈现。

### 5.2 数据真相归属

| 数据                | 权威源                                                                         | 备注                                                            |
| ------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 用户身份            | `miniapp.users`                                                                | TG 身份 + 归因字段；与旧 bot 的 `public.users` 隔离             |
| 角色卡元数据        | `miniapp.characters`（Prisma）                                                 | 大厅展示 + 引擎取数；`raw_card` 保留原始 JSON                   |
| 角色卡资源          | Supabase Storage `character-assets`                                            | PNG / 头像；前端只读                                            |
| **会话**            | **`miniapp.chat_sessions`**                                                    | 替代 ST 文件系统的 `chats/`                                     |
| **对话内容与轮次**  | **`miniapp.chat_history`**                                                     | 上下文 / 计费 / 审计三用；ST 存量日志 `session_id` 为 NULL      |
| 用户生成配置        | `miniapp.miniapp_user_settings`                                                | `selected_model_id` + 三个 `pref_*`；用户级生效，不做会话级覆盖 |
| 钱包 / 订单 / 签到  | `miniapp.user_wallets` / `payment_orders` / `daily_checkins` / `wallet_ledger` | 含 `llm_usage_charges` 逐调用账单与幂等表                       |
| 免费额度            | `miniapp.character_free_chat_quotas`                                           | 用户 × 角色计轮                                                 |
| 收藏 / 许愿         | `miniapp.character_favorites` / `wish_roles`                                   | —                                                               |
| 消息中心 / 站内客服 | `miniapp.notifications` / `notification_reads` / `support_*`                   | —                                                               |
| 平台运行时配置      | `miniapp.runtime_config`（+ Upstash Redis 缓存）                               | 模型目录、定价、平台规则三件套、充值套餐、弹窗文案等            |
| CS 回访             | `cs_platform.*`                                                                | raw SQL 访问；`user_metrics` / `persona_users_detail` 视图      |
| 渠道归因            | `growth.*`                                                                     | 点击重定向 + miniapp 进入上报                                   |
| 平台预设            | `st_platform.platform_presets`                                                 | 引擎不消费，admin 管理通路保留，等 M4 适配                      |

**Prisma vs supabase-js 边界**：Prisma schema 只声明 `public.*` 与部分 `miniapp.*`（用户、角色卡、钱包、订单、许愿、runtime_config 等）；会话、chat_history、CS、growth 以及所有 RPC 走 supabase-js 或 raw SQL。

---

## 6. 路由清单（backend，dev :3001 / prod :8080）

`src/app.ts` 注册全部路由插件，均使用完整路径字面量（不用 Fastify prefix）。CORS 允许 `FRONTEND_URL` / `CS_PLATFORM_URL` / `ADMIN_PLATFORM_URL`。

| 路由文件                  | 主要路径                                                                                                                                               | 鉴权                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `conversations.ts`        | `/api/v1/conversations*`、`/api/v1/generation-config`（见 §4.2）                                                                                       | `X-Init-Data`        |
| `characters.ts`           | `GET /api/characters` · `/:id` · `/latest-badge` · `POST /latest-seen`                                                                                 | 列表公开，红点需鉴权 |
| `favorites.ts`            | `GET /api/favorites` · `/ids`、`PUT`/`DELETE /api/favorites/:characterId`                                                                              | `X-Init-Data`        |
| `models.ts`               | `GET /api/platform/models` · `/openrouter/models`、`GET /api/v1/models/config`、`POST /api/v1/models/select`                                           | 部分公开             |
| `settings.ts`             | `GET`/`PATCH /api/users/settings`、`POST /api/users/avatar`                                                                                            | `X-Init-Data`        |
| `wallet.ts`               | `/api/wallet/balance` · `/spending` · `/free-quota/:characterId` · `/checkin`                                                                          | `X-Init-Data`        |
| `payment.ts`              | `/api/payment/plans` · `/orders*` · `/return` · `/webhook/jlpay`                                                                                       | webhook 验签         |
| `wishes.ts`               | `/api/wishes/status` · `POST /api/wishes` · `/:id/complete`                                                                                            | `X-Init-Data`        |
| `notifications.ts`        | `/api/notifications` · `/unread-count` · `/read`                                                                                                       | `X-Init-Data`        |
| `support.ts`              | `/api/support/conversation` · `/messages` · `/unread` · `/read`                                                                                        | `X-Init-Data`        |
| `cs-platform.ts`          | `/api/cs/*`：画像簇 CRUD/refresh、簇内用户、回访 session（advance/snooze/skip）、消息收发/重试、XLSX 导出、审计日志、CS 侧客服会话、CS 专用 TG webhook | `X-CS-Admin-Token`   |
| `growth.ts`               | `/api/cs/growth/channel-links`、`GET /api/growth/click/:sourceId`、`POST /api/growth/miniapp-entry`                                                    | 混合                 |
| `bot.ts`                  | `POST /api/internal/bot/start`、`POST /api/telegram/webhook`                                                                                           | 内部密钥 / TG secret |
| `admin-supabase-proxy.ts` | `POST /api/admin/character-assets/:characterId`、`ALL /api/admin/supabase/*`                                                                           | Supabase session     |
| `app.ts`                  | `GET /health`                                                                                                                                          | 公开                 |

frontend 自有 Route Handler：`GET /api/lobby-characters`（白名单 sort 参数后代理 backend 角色卡列表）。

**鉴权机制**：用户侧统一 `requireTelegramAuth`（`middleware/auth.ts`，读 `X-Init-Data` 做 HMAC-SHA256 校验；非生产可用 `MOCK_AUTH=1` / `DEV_AUTH_BYPASS=1` 旁路）。运营侧 CS 用 `X-CS-Admin-Token` + `X-CS-Operator-Id`，admin 用 Supabase 会话，Bot 用 `X-Bot-Internal-Secret` 与 Telegram webhook secret。

---

## 7. 工程约定

### 7.1 前端

- Next.js 14 App Router，`src/app/` 下 `(main)` 分组承载底部四 Tab（大厅 `/` / 聊天 `/chats` / 创作 `/create` / 我的 `/profile`），`tavern/[characterId]` 是会话页（不在分组内，无底部导航）。
- 服务端数据一律 React Query，封装在 `src/lib/api/`；`client.ts` 是唯一 REST 客户端。同文件里的 `apiStreamClient()` 是零调用方的死代码，且与自研对话链路的 SSE 契约不兼容（见 `packages/shared/src/api/conversations.ts`），M5 会另写并删除它。
- 跨组件状态 Zustand：`ui-store` / `user-profile-store` / `chat-list` / `font-scale-store`。
- 表单 React Hook Form + Zod；UI 用 Tailwind + shadcn/ui；`showdown` + `dompurify` 已在依赖里，供消息区 markdown 渲染使用 ⏳。

### 7.2 后端目录

```
packages/backend/src/
├── app.ts / server.ts      # Fastify 组装与启动
├── middleware/auth.ts      # requireTelegramAuth
├── routes/                 # 路由（见 §6）
├── features/               # conversations / engine / generation / billing / lobby / payment
├── infrastructure/         # repositories / payment 网关 / redis
├── platform/               # config, runtime-config, model-tiers, openrouter-models, effective-presets
├── lib/                    # user, chat-history-logger, logger, sentry, supabase, db, notifications…
└── scripts/                # 回归与运维脚本
```

### 7.3 测试与回归

- 单元 / 集成：Vitest。`conversations.integration.test.ts` 打真库验证会话、轮次、重生成、并发、软删除。
- 端到端回归：`pnpm --filter @miniapp/backend mvp:regression -- --seed-free-model` 在随机端口起真实 Fastify app、假上游，跑八个场景（建会话 / 发消息 / 计费对拍 / 免费额度 / 402 / 重生成 / 客户端断开 / 冲突守卫），断言落库与扣费。**全程不经过 ST，这正是 MVP 判据本身。**
- 本地验不到的部分：真实上游的流式时序、中间层对 SSE 的缓冲（已按惯例下发 `X-Accel-Buffering: no`），需接上前端后在真机验。

### 7.4 迁移

- 位置 `packages/shared/migrations/`，当前最大编号 **073**，共 78 个 SQL 文件。021 / 030 / 031 / 032 / 053 / 065 历史重号，同号之间无依赖，按文件名字母序执行。
- 执行方式：GitHub Actions → `Database Migration` → 选环境 → 填文件路径；生产需在 `confirm_production` 填 `RUN_PRODUCTION_MIGRATION`。
- 🔜 **069 / 070 / 071 / 072 / 073 尚未在生产库执行**，必须按序执行后才能切换（072 会回填并删除中间表 `chat_messages`，073 建当前 revision 视图）。

---

## 8. 部署

| 单元         | 包 / 镜像                       | 说明                                   | 平台           |
| ------------ | ------------------------------- | -------------------------------------- | -------------- |
| 平台前端     | `packages/frontend`             | Vercel 构建部署，对外域名绑定 Vercel   | Vercel         |
| CS 运营平台  | `packages/cs-platform`          | 独立 Vercel 项目（Vite 静态构建）      | Vercel         |
| 运营后台     | `packages/admin`                | 独立 Vercel 项目（Vite 静态构建）      | Vercel         |
| miniapp 后端 | `ops/docker/Dockerfile.backend` | Railway 服务 `stminiapp`，容器内 :8080 | Railway        |
| 数据与存储   | 托管                            | PostgreSQL + Storage                   | Supabase Cloud |

**流量路径**：用户 → Vercel（页面 + `/api/*` rewrite）→ backend → Supabase / OpenRouter。

⏳ **网关收敛待 M6 定稿**：ST 时代的 Railway nginx 唯一职责是分发 `/tavern/*` 与 ST 静态资源、并把 `/api/*` 转给 backend。ST 退场后前者消失，剩下的只是一层可选反代——是让 Vercel rewrite 直连 backend、还是保留 nginx 作为唯一对外入口，属于切换预案的一部分，落定前不要按其中任一种写死配置。同时 st-bundle 单容器与其数据卷整体退场，Railway 收敛为以 backend 为主的简化拓扑。

**CI/CD**：`.github/workflows/ci.yml`（typecheck / lint / import guard / 测试 / 构建）、`build-and-push.yml`（GHCR 镜像）、`db-migrate.yml`（手动迁移）、`pr-review.yml`。切换完成后镜像矩阵同步收敛（st-backend / nginx 相关目标退场）。

---

## 9. 边界与例外

- **simulation 测卡链路不属于 miniapp 项目**（总方案决策 8）。它有独立的 Railway project、独立 schema `miniapp_simulation`，并共用 backend 的 `/api/platform/simulation/chat` 与旧 LLM 代理网关 `/api/platform/llm-proxy/v1/*`。这两条路径在 miniapp 侧没有消费方，但**其存废跟随 simulation 系统自身的规划**，不由本方案裁决。
- **旧 bot 体系**（`public.*` 及 `bot_*` 表）与 miniapp 隔离、仍在运行，本架构不涉及。
- **平台预设通路**（`st_platform.platform_presets` + admin 管理页 + 按模型分配 RPC）保留但引擎不消费，见 §10 的 M4。

---

## 10. 完成度与待办

### 10.1 已落地

| 能力                                                          | 位置                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 会话数据模型 + 轮次/重生成语义 + 原子 RPC                     | migrations 069~073、`ChatSessionRepository`、`ConversationHistoryRepository` |
| Prompt 引擎（bot 移植，含平台规则三件套与降级）               | `features/engine/`                                                           |
| 生成与计费出口服务化                                          | `features/generation/`                                                       |
| 对话 REST + SSE（8 条路由）                                   | `routes/conversations.ts` + `features/conversations/`                        |
| 端到端回归（8 场景 / 与旧链路计费逐字段对拍）                 | `scripts/mvp-regression/`                                                    |
| 大厅 / 收藏 / 钱包 / 支付 / 签到 / 许愿 / 消息中心 / 站内客服 | `routes/*` + `frontend/(main)/*`                                             |
| 运营后台（配置发布 / 角色卡 / 预设 / 分析 / 审计）            | `packages/admin` + backend admin 通路                                        |
| CS 回访工作台 + 渠道归因                                      | `packages/cs-platform` + `routes/{cs-platform,growth,bot}.ts`                |

### 10.2 待办

| 项                        | 状态 | 说明                                                                            |
| ------------------------- | ---- | ------------------------------------------------------------------------------- |
| M5 自研聊天 UI            | ⏳   | 消息区新写（气泡 / markdown / 流式 / 重生成），数据源接 `/api/v1/conversations` |
| M6 切换与账号链路         | ⏳   | `runtime_config` 全局开关、登录路径去 ST 化、切换预案与回滚窗口                 |
| 069~073 在生产库执行      | 🔜   | 切换前必须按序执行（§7.4）                                                      |
| 压测定容                  | ⏳   | 全量切换无灰度爬坡，SSE 长连接与会话写入的容量必须在切换前压出来                |
| 埋点对齐                  | ⏳   | 复用现有"点卡 → 呈现"耗时口径，切换后直接对比 P50 / P95                         |
| 上下文长度管理            | ⏳   | 复现 bot 的"水位线泄洪"机制；不做的话长会话会持续推高 prompt 成本               |
| M4 自建预设格式与适配     | ⏳   | 明确不沿用 ST 格式；改造时注意三个会打挂旧链路的耦合点（见 MVP 方案 §九）       |
| 用户生成配置 UI           | ⏳   | 三个 `pref_*` 至今无编辑界面，随 M5 一起做                                      |
| 角色卡人设字段进 prompt   | ⏳   | v1 只用 `system_prompt`，待新卡写法定稿后决定                                   |
| ST 链路代码与部署单元清退 | ⏳   | 回滚窗口关闭后按 `docs/ST_remove.md` §四 的删除清单执行                         |
| `api-contract` 独立包     | ❌   | 不建，职责留在 `shared/api`                                                     |

---

## 11. 环境变量

| 变量                                                                     | 用途                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `DATABASE_URL` / `DIRECT_URL`                                            | Prisma 连接                                                    |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `*_PROJECT_REF`           | supabase-js 与环境隔离校验                                     |
| `LLM_UPSTREAM_URL` / `LLM_API_KEY`                                       | LLM 上游（默认 OpenRouter）与平台真实 key，仅 backend 持有     |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN`                                      | 运行时配置缓存                                                 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` / `BOT_INTERNAL_SECRET` | InitData 验签、webhook 与 Bot 内部端点鉴权                     |
| `CS_PLATFORM_URL` / `CS_ADMIN_TOKEN` / `CS_TELEGRAM_WEBHOOK_SECRET`      | CS 平台 CORS / 工作台鉴权 / CS webhook                         |
| `ADMIN_PLATFORM_URL`                                                     | 运营后台 CORS                                                  |
| `FRONTEND_URL`                                                           | CORS 与支付回跳                                                |
| `PAYMENT_*`                                                              | JLPay 网关（商户号、密钥、回调与回跳地址、支付宝 scheme 开关） |
| `CHARACTER_STORAGE_BUCKET`                                               | 角色卡资源 bucket（默认 `character-assets`）                   |
| `DEFAULT_USER_AVATAR_URL`                                                | 平台默认头像                                                   |
| `CHAT_HISTORY_SYNC_ENABLED`                                              | OpenRouter 用量回捞定时任务开关                                |
| `SENTRY_DSN` / `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE`                   | 异常上报                                                       |
| `MOCK_AUTH` / `DEV_AUTH_BYPASS` / `LOG_LEVEL`                            | 本地开发与回归脚本旁路                                         |

> ST 时代的 `ST_BASE_URL` / `ST_USER_PASSWORD_SECRET` / `ST_PROVISION_URL` / `LLM_PROXY_TOKEN_SECRET` / `ST_PUBLIC_PROXY_URL` 等变量随 ST 链路一并退场；`SIMULATION_*` 归 simulation 系统。

---

## 12. 相关文档

| 文档                            | 内容                                       |
| ------------------------------- | ------------------------------------------ |
| `docs/ST_remove.md`             | 替换总方案：12 项决策、阶段划分、删除清单  |
| `docs/ST_remove-MVP实施方案.md` | MVP 实施细节、模块产出、偏离记录与验收结论 |
| `docs/DECISIONS.md`             | 历史架构决策（含 schema 切分）             |
| `docs/QUICKSTART.md`            | 本地起服务                                 |
| `docs/llm-api-call-config.md`   | LLM 调用与计费配置                         |
| `docs/log_system.md`            | 日志分层与事件命名                         |
| `packages/backend/CLAUDE.md`    | 后端硬规则                                 |
| `packages/frontend/CLAUDE.md`   | 前端硬规则                                 |
