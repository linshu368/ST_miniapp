# ST_miniAPP 架构说明

> 本文档描述项目当前架构（2026-08-29 更新，基于 2026-08-12 自研引擎版重写）。
> 自研 prompt 引擎替换 SillyTavern 的动机与决策见 `docs/ST_remove.md`；数据库八域划分的归属与割接记录见 `docs/schema归属地图.md` 与 `docs/schema划分-批次A进度交接.md`。
>
> **状态口径**（每条能力都带标注，不标注即为 ✅）：
>
> | 标注 | 含义                    |
> | ---- | ----------------------- |
> | ✅   | 已落地并有测试/回归覆盖 |
> | ⏳   | 在建或待建              |
> | ❌   | 明确不做 / 已删除       |
>
> 当前进度：**自研引擎已全量上线，ST 链路（代码、schema、部署单元）已全部退场**；M5 自研聊天 UI、M6 切换（`chat_engine_mode` 开关已用完即删，083）、上下文水位线泄洪（077）均已交付。
> **Schema 划分一阶段已在生产落地**（2026-08-28 C3 割接完成，099 执行 9.4 秒、API 停机约 38 分钟）：原 `miniapp` schema 的 22 表 + 1 视图 + 24 函数已按归属域分布到 `app_core` / `miniapp_features` / `experience` / `billing` / `cs_platform`，`miniapp` 只剩空壳待批次 D 删除。
> 语音消息生成链路已上线（080），但**按次计费已整体回退**（PR #293 → #298 revert，test 库用 104 清理，生产从未执行）。

---

## 1. 架构铁律（违反即拦截）

1. **对外数据形状先定义在 `packages/shared/`**，再写 handler。backend 不得在包内私定对外类型（backend CLAUDE.md 硬规则）。
2. **每条路由注册上方必须有 `@frontend-ready: true|false — 原因`**，半成品要写出带业务含义的原因。
3. **应用包互不 import**：`frontend` / `backend` / `cs-platform` / `admin` 之间没有 import 关系，跨进程一律走 HTTP。
4. **DB 类型不进前端**：前端与运营台只消费 `shared/api/*` 契约，不接触数据库行类型。
5. **前端不在组件里 fetch**：服务端数据统一走 `frontend/src/lib/api/` 的 React Query hooks；跨组件状态用 Zustand，局部状态用 `useState`（frontend CLAUDE.md）。
6. **生成与计费只有一个出口**：任何要调 LLM 的路径都必须走 `backend/src/features/generation/`。禁止在别处另起一套"转发 + 扣费 + 落库"，否则计费口径必然漂移。
7. **`runtime_config` 只有一个读取入口**：`backend/src/platform/runtime-config.ts`（表在 `app_core.runtime_config`）。模型目录、定价、平台规则模板都从这里取，不允许并行实现第二套读法。
8. **数据库按八个归属域划分，新表必须声明归属域**（迁移文件头部注释 `-- domain: xxx`）；**跨域访问只准走 RPC / repository / API**，不得直接 SELECT/JOIN 另一个域的表（存量豁免清单见 `docs/schema归属地图.md` §四）。
9. **迁移不随部署自动执行**：`packages/shared/migrations/*.sql` 由 GitHub Actions `Database Migration` 手动逐个触发。历史存在重号（见 §7.4），**不要按序号推断内容**。
10. **TypeScript 严格模式，禁止 `any`**。

---

## 2. 架构总览

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ 用户（Telegram Mini App WebView）              内部运营                          │
│ ┌──────────────────────────────────────┐ ┌──────────────┬───────────────────┐  │
│ │ packages/frontend  Next.js App Router │ │ cs-platform  │ admin             │  │
│ │  (main) 大厅 / 聊天 / 创作 / 我的      │ │ 回访 + 客服   │ 运营配置/角色卡/   │  │
│ │  /chat/[characterId] 会话页（自研 UI） │ │ (Vite :3002) │ 公告/发布历史      │  │
│ │    ├ 消息区：SSE 流式 / markdown /     │ └──────┬───────┴─────────┬─────────┘  │
│ │    │ 重生成 / 语音气泡                 │        │                 │            │
│ │    └ 工具箱：生成偏好 / 模型 / 语音     │        │ X-CS-Admin-     │ Supabase   │
│ │  lib/api + React Query + Zustand      │        │ Token           │ session    │
│ └───────────────┬──────────────────────┘        │                 │            │
└─────────────────┼───────────────────────────────┼─────────────────┼────────────┘
                  │ ① REST + SSE（X-Init-Data）    │ ④              │ ④
                  ▼                                ▼                 ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │ packages/backend（Fastify 5，Railway stminiapp）                  │
        │                                                                   │
        │  对话链路（核心）                                                  │
        │   routes/conversations.ts  /api/v1/conversations/*  REST + SSE    │
        │     └ features/conversations  编排：预建轮次 → 窗口泄洪 →          │
        │         │                     组 prompt → 生成                    │
        │         ├ features/engine      prompt 组装（纯函数）              │
        │         └ features/generation  免费额度 → 余额预检 → 上游 → 落库  │
        │   routes/voice.ts  语音消息生成（features/voice，本期不扣费）      │
        │                                                                   │
        │  平台业务：characters / favorites / wallet / payment / wishes /   │
        │            settings / models / notifications / support            │
        │  运营与增长：/api/cs/* · /api/growth/miniapp-entry ·              │
        │             /api/telegram/webhook                                 │
        │  进程内任务：chat-history-sync（30s）· 大厅排序重算（24h）         │
        └──────┬──────────────────────────┬───────────────┬────────────────┘
               │ ③ Prisma + supabase-js   │ ② HTTPS(SSE)  │ ⑥ HTTPS
               ▼                          ▼               ▼
┌────────────────────────────────────┐ ┌──────────────┐ ┌──────────────────┐
│ Supabase（PostgreSQL + Storage）    │ │ OpenRouter   │ │ MiniMax TTS      │
│  八域布局（099 之后）：              │ │ （LLM 上游）  │ │ DeepSeek（写稿）  │
│  ├ app_core      用户/角色卡/配置   │ │ 平台真实 key │ │ （语音链路上游）  │
│  ├ experience    会话/chat_history/ │ │ 只在 backend │ └──────────────────┘
│  │               语音元数据          │ └──────────────┘
│  ├ billing       钱包/订单/计费/额度 │
│  ├ miniapp_features 收藏/签到/许愿/  │      ⑤ Telegram Bot webhook
│  │               通知/排序分         │      → /api/telegram/webhook
│  ├ cs_platform   回访画像/客服       │
│  ├ miniapp_traffic  渠道归因         │  Railway 另有两个支付任务服务：
│  ├ miniapp_analytics 看数视图        │   · payment-reconcile-cron（常驻对账）
│  ├ admin         运营台账号/审计     │   · payment-cron（*/5 过期任务）
│  └ miniapp       空壳（待删）        │
│  Storage: character-assets /        │
│           miniapp-chat-voice        │
└────────────────────────────────────┘
```

### 链路编号

| 编号 | 方向                          | 用途                                                                                               |
| ---- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| ①    | frontend → backend（HTTP/SSE) | 全部业务 REST；对话发消息与重生成是 `text/event-stream`                                            |
| ②    | backend → OpenRouter          | 唯一的 LLM 出口，平台真实 key 只在 backend 进程内                                                  |
| ③    | backend ⇆ Supabase            | Prisma（`app_core` / `miniapp_features` / `billing`）+ supabase-js 按域客户端（RPC / 其余 schema） |
| ④    | cs-platform / admin → backend | 运营台 REST；CS 走 `X-CS-Admin-Token`，admin 走 Supabase 会话                                      |
| ⑤    | Telegram → backend            | Bot `/start` 归因、用户回复回流 CS                                                                 |
| ⑥    | backend → MiniMax / DeepSeek  | 语音链路：DeepSeek 写台词稿，MiniMax 合成音频落 Storage                                            |

---

## 3. 包清单

### 3.1 契约层

`shared` 是跨包唯一契约来源：`src/api/*` 的 **18 个 REST 契约文件**、`migrations/`（SQL 迁移）、纯工具与常量。所有应用包都消费它。

`shared/src/api/` 逐个文件：`envelope`（统一响应包络 `ok()` / `fail()`）、`characters`、`favorites`、**`conversations`**（对话链路契约，含 SSE 事件）、**`voice`**（语音消息契约）、`models`、`settings`、`wallet`、`payment`（含 `PaymentSettlementSource`）、`wishes`、`notifications`、`support`、`cs-platform`、`growth`（仅入口归因）、`health`、`lobby-pinned-characters`、`lobby-ranking-params`、`word-count-tiers`。

> ST 时代的 `chats` / `st-session` / `simulation` 契约已随 ST 清理删除。曾计划的独立 `api-contract` 包不建 ❌，职责留在 `shared/api`。
> `db-types` 包（Supabase schema 镜像）已随 ST 清理整包删除 ❌，当前 `packages/` 只有 5 个包。

### 3.2 应用层

| 包            | 职责                                                                                                                                                    | dev 端口 | 部署                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------- |
| `frontend`    | Next.js 14 App Router：大厅 / 会话页（自研聊天 UI）/ 充值 / 许愿池 / 消息中心；React Query + Zustand；Telegram Mini App SDK                             | 3000     | Vercel                  |
| `backend`     | Fastify 5：对话 REST + SSE、prompt 引擎、生成与计费出口、语音生成、平台业务 REST、CS / 归因 / Bot webhook                                               | 3001     | Railway（容器内 :8080） |
| `admin`       | 运营后台：运营配置（14 个 managed key，含模型目录 / 平台规则 / 大厅置顶与排序参数）、角色卡、公告、发布历史、回访星尘赠送。Vite + React + AntD + Refine | 3003     | Vercel                  |
| `cs-platform` | 内部运营平台：CS 回访工作台（画像簇 / Telegram 1V1 SOP / 特殊标记 / 等待状态 / 群发 / 导出）+ 站内客服。Vite + React + React Query                      | 3002     | Vercel                  |

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

这是本项目唯一的"业务执行引擎"：角色切换、会话管理、消息生成全部发生在 backend 进程里。

### 4.1 分层

| 层             | 位置                                                      | 性质                                                                                   |
| -------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 路由与鉴权     | `routes/conversations.ts`                                 | 统一 `requireTelegramAuth`；ownership 落在仓库层                                       |
| 编排           | `features/conversations/`                                 | `generate.ts`（一轮生成）/ `history.ts` / `context-window.ts` / `sse.ts` / `errors.ts` |
| Prompt 组装    | `features/engine/`                                        | 纯函数，无 IO（唯一有 IO 的是读平台规则的 `platform-instructions.ts`）                 |
| 生成与计费出口 | `features/generation/`                                    | 免费额度 → 余额预检 → 上游转发 + SSE tap → 终态落库与实扣                              |
| 持久化         | `ChatSessionRepository` / `ConversationHistoryRepository` | supabase-js（`experience` 域）+ 原子 RPC                                               |

### 4.2 接口清单（`/api/v1`）

| 方法 / 路径                                 | 职责                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `POST /api/v1/conversations`                | 建会话，返回 session + 虚拟 turn 0 开场白，不写 chat_history                 |
| `GET /api/v1/conversations`                 | 会话列表（跨角色，支持 `character_id` 过滤 + 分页，置顶优先），直读 DB       |
| `GET /api/v1/conversations/:id`             | 会话详情 + 消息分页（`before_turn_index` 向前翻页）                          |
| `PATCH /api/v1/conversations/:id`           | 重命名（`title: null` = 恢复角色名默认）与**置顶**（`pinned: boolean`）      |
| `DELETE /api/v1/conversations/:id`          | 软删（`deleted_at`）                                                         |
| `POST /api/v1/conversations/:id/messages`   | **发消息 + SSE 流式回复**                                                    |
| `POST /api/v1/conversations/:id/regenerate` | 重生成最后一轮，同样 SSE                                                     |
| `GET` · `PATCH /api/v1/generation-config`   | 用户生成配置读写（三个 `pref_*` + 档位表；改模型走 `/api/v1/models/select`） |

SSE 事件契约定义在 `shared/src/api/conversations.ts`：`start`（带 message id / turn_index / revision）→ `delta`（增量片段，非累积）→ `done`（终态 + finish_reason），流开始后才发生的错误走 `error` 事件。

语音消息端点在 `routes/voice.ts`（见 §4.6）。

### 4.3 一轮生成的执行序列

```
1. requireTelegramAuth → userId；校验 session 归属
2. 并行取数：模型解析 / 角色卡 / 用户生成配置 / 昵称 / 平台规则模板 / 窗口水位配置
3. RPC start_chat_history_turn（或 start_chat_history_regeneration）
   → 会话行锁内分配 turn_index、必要时执行窗口泄洪（更新 context_window_start_turn）、
     插入 status='streaming' 的 chat_history 行
4. 读窗口内（turn_index ∈ [窗口起点, 本轮)）各轮最大 revision 展开历史；
   首轮用角色卡开场白，之后从首轮 prompt 快照恢复（开场白不计水位、始终保留）
5. features/engine 组 messages，把完整 prompt 快照写回本轮 history 字段
6. features/generation execute()：免费额度预留 → 定档扣费额 → 余额预检
   · 预检不过 → 收口成 insufficient_balance，路由返回 HTTP 402 JSON
   · 上游非 2xx / 连不上 → 路由返回 HTTP 502 JSON
   · 上游 2xx → onStreamOpen 回调，此时才写 SSE 响应头并下发 start 事件
7. 边转发 delta 边累积；客户端断开不终止后端，继续 drain 到 [DONE]
8. 终态：同步更新同一条 chat_history 的正文与状态；实扣与 OpenRouter 元数据异步补齐
   （chat-history-logger 即时写 + chat-history-sync-job 30 秒轮询回捞 24h 内不全的行）
```

**硬约束**：SSE 首字节写出之前不能有任何可能失败的判定。402（余额不足）、409（会话忙 / 不可重生成）、404 全部以 HTTP 状态码 + JSON 返回；响应头一旦发出就只能降级成流内 `error` 事件。所以响应头推迟到上游已 2xx 的 `onStreamOpen` 才写——不是等第一个 token，否则客户端要白等一整个上游首 token 延迟才能挂上占位气泡。

### 4.4 Prompt 组装（`features/engine`）

v1 是旧 bot `SimplePromptEngine` 的忠实移植，最终形状：

```
[system: 角色卡 system_prompt] + 历史（含虚拟 turn 0 开场白） + [user: 平台规则 + 本轮输入]
```

- **上下文长度管理已落地（077）**：双水位线泄洪，窗口在 [A, B] 轮之间增长，超过高水位 B（`max_context_turns`，默认 75）一次性收缩到低水位 A（`retain_context_turns`，默认 50）。窗口起点持久化在 `chat_sessions.context_window_start_turn`，由开轮 RPC 在会话行锁内更新（`apply_context_window_flood`）；**不删** `chat_history`，只决定本轮 prompt 带哪些轮。引擎不二次裁剪，`truncatedTurns` 回填真实观测值。双水位（而非滑动窗口）是为了给 Anthropic prompt cache 制造稳定前缀，设计见 `docs/context-window-and-prompt-cache.md`。
- **不消费预设**：ST 酒馆格式的 `platform_presets` 已随 088 整体删除（数据留档在库外）。自建预设格式是待办（M4，见 §10）。
- **不注入 `first_mes`**：开场白由编排层放进 history，引擎再注入会每轮重复一条。
- **不做酒馆语义适配**：宏、世界书、正则、卡内嵌资源一律不支持，表现质量由 system prompt 与组装逻辑承担。
- 角色卡只取 `system_prompt`；`description` / `personality` / `scenario` / `mes_example` / `post_history_instructions` 已在接缝里占位但 v1 不进 prompt。

平台规则来自 `app_core.runtime_config` 三个 key，5 分钟 TTL 缓存、按 `version` 判活，缺失或格式损坏时降级到内置兜底并打 `degraded` 标记。三件套与档位表均可在 admin 运营配置里编辑发布：

| key                       | 内容                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `system_instructions`     | 平台规则模板，含 `{{WORD_COUNT}}` / `{{INTERACTION_MODE}}` / `{{USER_CUSTOM_INSTRUCTIONS}}` 三个占位符 |
| `interaction_mode_blocks` | `pref_show_options` 二选一的正文块                                                                     |
| `pref_word_count_tiers`   | 字数档位表（076 起可增删档位；`pref_word_count` 未选时跟随平台 default_tier）                          |

### 4.5 生成与计费出口（`features/generation`）

| 文件                | 职责                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------- |
| `resolve-model.ts`  | 权威模型解析：用户 `selected_model_id` → 模型目录 → `ResolvedModel`                     |
| `quota.ts`          | 角色免费额度 `reserve` / `finalize` 两阶段                                              |
| `precheck.ts`       | 定档扣费额与计费快照、余额预检（402 判定，不构造响应）                                  |
| `upstream.ts`       | 上游转发原语 + SSE tap（逐字节透传、抓 `generation_id` / `finish_reason`、判 `[DONE]`） |
| `prompt-caching.ts` | Anthropic `cache_control` 断点注入（system + 窗口内历史最后一条，不打本轮输入）         |
| `execute.ts`        | `GenerationService`：把上面串成一条出口，供对话链路直调                                 |

计费要点：

- 定档扣费（`billing_mode: 'fixed_tier'`，配置在 `runtime_config.llm_pricing_config`；084/085 之后模型目录用 `is_free` 标免费模型，不再有展示价与 markup）。
- 免费额度按**用户 × 角色**计轮，上限来自 `runtime_config.miniapp_character_free_chat_quota_limit`（默认 40）。
- 实扣走 RPC `billing.charge_llm_usage`，幂等键是 `charge_id`。
- **finish_reason 计费闸门（081/082）**：只有 `status=success` 且 `finish_reason='stop'` 的自然收尾才扣星尘；finish_reason 未到时挂 `pending` 等 sync-job 回捞后结算；截断（length）、中断、上游错误一律不扣费。消费明细带 `reply_outcome`（complete / incomplete / empty）体验口径标签。

### 4.6 语音消息（`features/voice`）✅ 生成链路 / ❌ 计费（已回退）

| 方法 / 路径                                                       | 职责                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `GET` · `PATCH /api/v1/voice/config`                              | 用户语音偏好（音色 `pref_voice_id`、倍速）                    |
| `GET /api/v1/conversations/:sessionId/voice`                      | 会话内语音状态批量查询（前端轮询）                            |
| `POST /api/v1/conversations/:sessionId/messages/:messageId/voice` | 生成语音（202 受理，异步执行；可带 `custom_text` 自定义台词） |

流水线：受理落 `experience.chat_message_audio` pending 行 → DeepSeek 写台词稿（有 `custom_text` 则跳过）→ MiniMax TTS 合成 → 音频落 Storage `miniapp-chat-voice` 桶 → markReady。前端在气泡底部提供生成 / 播放 / 再生成，另有自定义台词页 `/chat/[characterId]/voice/[messageId]`。

**计费状态**：按次扣费曾以 PR #293（迁移 101/102）上到 test，2026-08-28 整体 revert（PR #298）；test 库用 `104_rollback_voice_billing.sql` 清理（生产从未执行 101/102，**不要在生产跑 104**）。当前每次生成都留一行元数据但不扣费；重启计费需另开评审。

---

## 5. 数据模型与真相归属

### 5.1 数据库八域布局（099 之后，test 与生产一致）

| Schema              | 归属域       | 内容                                                                                                                                               |
| ------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_core`          | 跨模块根数据 | `users` / `miniapp_user_settings` / `characters` / `runtime_config`                                                                                |
| `experience`        | 核心互动内容 | `chat_sessions` / `chat_history` / `chat_message_audio` / 视图 `current_chat_history`                                                              |
| `billing`           | 钱           | `payment_orders` / `wallet_ledger` / `user_wallets` / `llm_usage_charges` / `llm_usage_charge_dedup` / `character_free_chat_quotas` / `_decisions` |
| `miniapp_features`  | 产品功能状态 | `character_favorites` / `character_ranking_scores` / `daily_checkins` / `wish_roles` / `notifications` / `notification_reads`                      |
| `cs_platform`       | 客服与触达   | CS 回访画像与会话 + 迁入的 `support_conversations` / `support_messages`                                                                            |
| `admin`             | 运营管理     | 运营台账号、草稿 / 发布 / 审计（边界不变）                                                                                                         |
| `miniapp_traffic`   | 渠道归因     | `botlinks` 等（acquisition 域，名称不改）                                                                                                          |
| `miniapp_analytics` | 看数         | 只读视图；红线：不得成为任何运行时依赖                                                                                                             |
| `miniapp`           | —            | **空壳**，批次 D 观察期后删除 ⏳                                                                                                                   |
| `public`            | —            | 旧 bot 残留函数（数据已迁出本库；函数存废另开评审）                                                                                                |

已删除的 schema：`st_platform` / `st_users` / `st_infra`（088，含酒馆格式平台预设）、`growth`（089，归因功能收敛进 `miniapp_traffic`）、`miniapp_simulation`（090，保留 `characters.is_test`）。

三张钱表的口径纪律：**支付金额以订单为准，星尘变动以流水为准，钱包余额只是可重建的当前状态。**

### 5.2 会话存储

```
experience.chat_sessions  1 ─── N  experience.chat_history
```

- `chat_sessions`：一行一个会话，支持同一用户 × 同一角色多会话。`title` 创建时默认写角色名（079）；`pinned_at` 置顶（078）；`context_window_start_turn` 窗口起点（077）；`message_count` / `last_message_at` / `last_message_preview` 由触发器维护；软删用 `deleted_at`。
- `chat_history`：一行 = 某 session 内一个逻辑 turn 的一个生成 revision，同时是**上下文、计费与审计的唯一事实来源**（097 列级瘦身后 29 列）。`history` 字段保存本次实际发给模型的完整 messages 快照——它也是表体积（~10 GB）97% 的来源，列级瘦身主战场。
- `turn_index`：用户主动发起的轮次，从 1 递增，重生成不增加。`revision`：同一轮的生成版本，首次 0，重生成 +1，**最大 revision 即当前版本**。唯一索引 `(session_id, turn_index, revision)`。
- 开场白不单独落行：新会话由 API 返回虚拟 turn 0；首轮生成时进入 prompt 快照，之后从快照恢复。
- `current_chat_history`（073 视图）：数据库侧固化每轮最大 revision，分页不必把全部旧版本拉回应用层。

四个原子 RPC（`experience` 域）以 `chat_sessions FOR UPDATE` 为串行点：

| RPC                               | 作用                                                                      |
| --------------------------------- | ------------------------------------------------------------------------- |
| `start_chat_history_turn`         | 锁 session、清理陈旧 streaming、分配 `max(turn_index)+1`、插入 revision 0 |
| `start_chat_history_regeneration` | 锁 session、校验是最后一轮、复用 `user_input`、插入 `max(revision)+1`     |
| `guard_chat_session_idle`         | 有 120 秒内的 `streaming` 行则抛 `55006`（→ 409）；陈旧行先收口再放行     |
| `apply_context_window_flood`      | 窗口超高水位 B 时把起点跳到只留低水位 A 轮（077）                         |

> ST 存量聊天记录**不迁移**：存量行只有 user_id + character_id 两维、没有 session 三元组，留档供运营与审计，不对用户呈现。

### 5.3 数据真相归属

| 数据                 | 权威源                                                                                         | 备注                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 用户身份             | `app_core.users`                                                                               | TG 身份 + 归因字段（`st_handle` 为遗留列，列级瘦身待办）       |
| 角色卡元数据         | `app_core.characters`（Prisma）                                                                | 大厅展示 + 引擎取数；`raw_card` 保留原始 JSON                  |
| 角色卡资源           | Supabase Storage `character-assets`                                                            | PNG / 头像；前端只读                                           |
| **会话**             | **`experience.chat_sessions`**                                                                 | 置顶 / 标题 / 窗口起点 / 统计缓存                              |
| **对话内容与轮次**   | **`experience.chat_history`**                                                                  | 上下文 / 计费 / 审计三用；ST 存量行 `session_id` 为 NULL       |
| 语音消息             | `experience.chat_message_audio` + Storage `miniapp-chat-voice`                                 | 每条 assistant 回复的 TTS 产物元数据                           |
| 用户生成配置         | `app_core.miniapp_user_settings`                                                               | `selected_model_id` + 三个 `pref_*` + 语音偏好；用户级生效     |
| 钱包 / 订单 / 签到   | `billing.user_wallets` / `payment_orders` / `wallet_ledger`、`miniapp_features.daily_checkins` | `payment_orders.settled_by` 记录入账路径（103）                |
| LLM 计费明细         | `billing.llm_usage_charges`（+ `_dedup` 幂等墓碑）                                             | 每用户保留最近 100 条完整行，更早压缩进 dedup                  |
| 免费额度             | `billing.character_free_chat_quotas`                                                           | 用户 × 角色计轮                                                |
| 收藏 / 许愿 / 排序分 | `miniapp_features.character_favorites` / `wish_roles` / `character_ranking_scores`             | 排序分由 lobby 定时任务从 `chat_history` 聚合重算（074）       |
| 消息中心 / 站内客服  | `miniapp_features.notifications` / `notification_reads`、`cs_platform.support_*`               | —                                                              |
| 平台运行时配置       | `app_core.runtime_config`（+ Upstash Redis 缓存）                                              | 模型目录、定价、平台规则三件套、充值套餐、大厅置顶与排序参数等 |
| CS 回访              | `cs_platform.*`                                                                                | `user_metrics` / `persona_users_detail` 视图（094 补效率字段） |
| 渠道归因             | `miniapp_traffic.*`                                                                            | Bot `/start` 与 miniapp 进入上报                               |

**Prisma vs supabase-js 边界**：`schema.prisma` 只声明 `app_core` / `miniapp_features` / `billing` 三个 schema 共 11 个 model（用户、角色卡、runtime_config、签到、许愿、订单、钱包、流水、计费）；`experience`、`cs_platform`、`admin`、`miniapp_traffic`、`miniapp_analytics` 以及所有 RPC 走 supabase-js **按域客户端**（`lib/supabase.ts` 的 `getDomainDb(域)`）或 raw SQL 全限定名。统一 `.schema('miniapp')` 的旧写法已废弃。

---

## 6. 路由清单（backend，dev :3001 / prod :8080）

`src/app.ts` 注册全部路由插件，均使用完整路径字面量（不用 Fastify prefix）。CORS 允许 `FRONTEND_URL` / `CS_PLATFORM_URL` / `ADMIN_PLATFORM_URL`。

| 路由文件                  | 主要路径                                                                                                                                                                         | 鉴权                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `conversations.ts`        | `/api/v1/conversations*`、`/api/v1/generation-config`（见 §4.2）                                                                                                                 | `X-Init-Data`        |
| `voice.ts`                | `/api/v1/voice/config`、`/api/v1/conversations/:sessionId/voice`、`.../messages/:messageId/voice`（见 §4.6）                                                                     | `X-Init-Data`        |
| `characters.ts`           | `GET /api/characters` · `/:id` · `/latest-badge` · `POST /latest-seen`                                                                                                           | 列表公开，红点需鉴权 |
| `favorites.ts`            | `GET /api/favorites` · `/ids`、`PUT`/`DELETE /api/favorites/:characterId`                                                                                                        | `X-Init-Data`        |
| `models.ts`               | `GET /api/platform/models` · `/openrouter/models`、`GET /api/v1/models/config`、`POST /api/v1/models/select`                                                                     | 部分公开             |
| `settings.ts`             | `GET`/`PATCH /api/users/settings`、`POST /api/users/avatar`                                                                                                                      | `X-Init-Data`        |
| `wallet.ts`               | `/api/wallet/balance` · `/spending` · `/free-quota/:characterId` · `/checkin`                                                                                                    | `X-Init-Data`        |
| `payment.ts`              | `/api/payment/plans` · `/orders*` · `/return` · `/webhook/zqpay`                                                                                                                 | RSA 回调验签         |
| `wishes.ts`               | `/api/wishes/status` · `POST /api/wishes` · `/:id/complete`                                                                                                                      | `X-Init-Data`        |
| `notifications.ts`        | `/api/notifications` · `/unread-count` · `/read`                                                                                                                                 | `X-Init-Data`        |
| `support.ts`              | `/api/support/conversation` · `/messages` · `/unread` · `/read`                                                                                                                  | `X-Init-Data`        |
| `cs-platform.ts`          | `/api/cs/*`：画像簇 CRUD/refresh、簇内用户、回访 session（advance/snooze/skip）、消息收发/重试、特殊标记、按等待状态群发、XLSX 导出、审计日志、CS 侧客服会话、CS 专用 TG webhook | `X-CS-Admin-Token`   |
| `growth.ts`               | `POST /api/growth/miniapp-entry`（089 之后仅剩入口归因；渠道链接管理与 click 重定向已下线）                                                                                      | `X-Init-Data`        |
| `bot.ts`                  | `POST /api/internal/bot/start`、`POST /api/telegram/webhook`                                                                                                                     | 内部密钥 / TG secret |
| `admin-supabase-proxy.ts` | `POST /api/admin/character-assets/:characterId`、`ALL /api/admin/supabase/*`                                                                                                     | Supabase session     |
| `app.ts`                  | `GET /health`                                                                                                                                                                    | 公开                 |

frontend 自有 Route Handler：`GET /api/lobby-characters`（白名单 sort 参数后代理 backend 角色卡列表）。

**鉴权机制**：用户侧统一 `requireTelegramAuth`（`middleware/auth.ts`，读 `X-Init-Data` 做 HMAC-SHA256 校验；非生产可用 `MOCK_AUTH=1` / `DEV_AUTH_BYPASS=1` 旁路）。运营侧 CS 用 `X-CS-Admin-Token` + `X-CS-Operator-Id`，admin 用 Supabase 会话，Bot 用 `X-Bot-Internal-Secret` 与 Telegram webhook secret。

**进程内定时任务**（`app.ts` 启动，不走 HTTP）：`chat-history-sync-job`（30 秒轮询，回捞 24h 内 OpenRouter 元数据不全的行并结算 pending 计费）、`lobby-ranking-refresh-job`（24 小时一轮重算大厅推荐排序分）。支付对账与过期是独立 Railway 服务（见 §8）。

---

## 7. 工程约定

### 7.1 前端

- Next.js 14 App Router，`src/app/` 下 `(main)` 分组承载底部四 Tab（大厅 `/` / 聊天 `/chats` / 创作 `/create` / 我的 `/profile`），会话页是 **`/chat/[characterId]?session=...`**（不在分组内，无底部导航），另有自定义语音台词页 `/chat/[characterId]/voice/[messageId]`。
- 自研聊天 UI（M5 已交付）：`components/chat/` 下消息列表 / 气泡 / markdown（showdown + DOMPurify）/ 输入区 / 重生成 / 语音播放条 / 会话抽屉 / 工具箱；SSE 客户端是 `lib/api/conversation-stream.ts` 的 `streamConversationTurn()`（旧 `apiStreamClient` 已删除）。
- 用户生成配置有编辑界面：会话页工具箱（`chat-tools-sheet.tsx`）内含生成偏好（三个 `pref_*`）、模型切换、语音设置三块；图片设置为占位 ⏳。
- 服务端数据一律 React Query，封装在 `src/lib/api/`；`client.ts` 是唯一 REST 客户端。
- 跨组件状态 Zustand：`ui-store` / `user-profile-store` / `font-scale-store`（会话列表走 React Query，不进 store）。
- 表单 React Hook Form + Zod；UI 用 Tailwind + shadcn/ui。

### 7.2 后端目录

```
packages/backend/src/
├── app.ts / server.ts      # Fastify 组装与启动（含进程内定时任务）
├── instrumentation.ts      # Sentry 初始化
├── middleware/auth.ts      # requireTelegramAuth
├── routes/                 # 路由（见 §6）
├── features/               # conversations / engine / generation / voice /
│                           # billing / lobby / payment
├── infrastructure/         # repositories / payment 网关 / redis
├── platform/               # config, runtime-config, model-tiers, openrouter-models
├── lib/                    # supabase(getDomainDb), user, chat-history-logger,
│                           # chat-history-sync-job, lobby-ranking-refresh-job,
│                           # chat-voice-storage, logger, sentry, notifications…
└── scripts/                # 回归与运维脚本（含支付对账/过期/回调日报）
```

### 7.3 测试与回归

- 单元 / 集成：Vitest。`conversations.integration.test.ts` 打真库验证会话、轮次、重生成、并发、软删除。
- 端到端回归：`pnpm --filter @miniapp/backend mvp:regression` 在随机端口起真实 Fastify app、假上游，覆盖建会话 / 发消息 / 计费对拍 / 免费额度 / 402 / 重生成 / 客户端断开 / 冲突守卫等场景，断言落库与扣费。schema 割接（C2/C3）以它全绿作为交付门之一。
- 本地验不到的部分：真实上游的流式时序、中间层对 SSE 的缓冲（已按惯例下发 `X-Accel-Buffering: no`），需真机验。

### 7.4 迁移

- 位置 `packages/shared/migrations/`，当前最大编号 **104**，共 113 个 SQL 文件（`archive/` 另存 087 删除的 admin RPC 定义备查）。
- **编号规则必须小心**：
  - 021 / 030 / 031 / 032 / 053 / 065 历史重号，同号无依赖，按文件名字母序执行；
  - 086 / 088 / 092 / 093 / 095 也各有两个文件，来自 `main` 与 `dev` 两条并行发布线，**同号但含义不同，不要按序号推断内容**；
  - 101 / 102 缺号：语音计费迁移已随 PR #298 revert 从仓库删除，test 库用 104 回滚（生产从未执行，**不要在生产跑 104**）；
  - 099 有配套 `_rollback` 文件，是正向 + 回滚，不是撞号。
- 执行方式：GitHub Actions → `Database Migration` → 选环境 → 填文件路径；生产需在 `confirm_production` 填 `RUN_PRODUCTION_MIGRATION`。workflow 会校验连接串 project ref（test = `zoqelpfhurwehlvypryl`，production = `wbtsfzozlmurljvglhpn`）。
- **099 不是普通迁移**：执行前必读 `docs/schema划分-一阶段执行计划.md`（停流量、前置 097/098、事务外三步收尾）。test 与生产均已执行完毕。

---

## 8. 部署

| 单元         | 包 / 镜像                       | 说明                                                                                                              | 平台           |
| ------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------- |
| 平台前端     | `packages/frontend`             | Vercel 构建部署，对外域名绑定 Vercel                                                                              | Vercel         |
| CS 运营平台  | `packages/cs-platform`          | 独立 Vercel 项目（Vite 静态构建）                                                                                 | Vercel         |
| 运营后台     | `packages/admin`                | 独立 Vercel 项目（Vite 静态构建）                                                                                 | Vercel         |
| miniapp 后端 | `ops/docker/Dockerfile.backend` | Railway 服务 **`stminiapp`**（唯一对外 HTTP），容器内 :8080                                                       | Railway        |
| 支付快速对账 | 同上镜像                        | Railway 服务 `stminiapp-payment-reconcile-cron`：常驻 worker，进程内约 30 秒一轮按 `next_reconcile_at` 领单查厂商 | Railway        |
| 支付过期任务 | 同上镜像                        | Railway Cron `stminiapp-payment-cron`：`*/5 * * * *` 跑过期前回溯对账 + 判过期                                    | Railway        |
| 数据与存储   | 托管                            | PostgreSQL + Storage；test 与 production 两个项目                                                                 | Supabase Cloud |

**流量路径**：用户 → Vercel（页面）→ backend 公网域名 → Supabase / OpenRouter / MiniMax。浏览器直接把 `/api/*` 发往 backend 域名，中间**没有任何反代**（ST 时代的 nginx 网关已随收敛退场）。

> 跨域直连要求两个变量成对配好，任一侧配错即浏览器侧请求全挂：Vercel 的 `NEXT_PUBLIC_API_URL` = backend 公网域名（build 期固化，改后需 redeploy），backend 的 `FRONTEND_URL` = Vercel 对外域名（CORS allow-origin）。

**Railway IaC**：`.railway/railway.ts` 声明 `development`（跟 `dev` 分支）与 `production`（跟 `main` 分支）两套环境 × 上述三个服务；改动需 `railway config plan/apply`，且渲染 production 必须显式 `RAILWAY_CONFIG_ENV=production`。**`main` 分支自动部署生产**（三个服务的 deployment trigger 均为 `branch=main`）——合并进 `main` 即上线，数据库迁移需在合并前按 §7.4 手动执行。对 `dev` 的 PR 会由 `railway-pr-env.yml` 拉起 `pr-{N}` 临时环境（变量继承 development，指向 test 库）。

**支付入账的四条路径**（唯一出口 `features/payment/usecases/PaymentSettlement.settlePaidOrder`，幂等靠 `credits_added`，先到者写 `payment_orders.settled_by`）：`webhook`（网关异步回调）→ `return`（同步回跳）→ `query`（订单页轮询时对账）→ `cron`（上述两个 Railway 任务兜底）。四路兜底的由来见 `docs/payment-missing-credits-remediation.md`（生产曾因 cron 未部署漏账）。

**CI/CD**（`.github/workflows/`）：`ci.yml`（typecheck / lint / import guard / 测试 / Docker 构建，矩阵仅 backend）、`build-and-push.yml`（GHCR 镜像：backend 跟 `dev` 推送；frontend 仅 `staging-*` tag）、`db-migrate.yml`（手动迁移）、`pr-review.yml`、`railway-pr-env.yml`（PR 临时环境）。生产不走 GHCR，Railway 直接从 GitHub `main` 构建。

> 运维遗留（需人工处理）：Railway production 控制台的 `nginx-pro` / `st-bundle-pro` / 卷 `st-data-pro` 与两侧 `ST_*` 变量待手动删除（见 `ops/railway/README.md`）；废弃的 `pr-276` 环境仍挂着一条 `branch=main` 的 trigger；`Dockerfile.frontend` 仍是隐式 pnpm 取包写法（backend 已在 PR #295 修复构建卡死）。

---

## 9. 边界与例外

- **旧 bot 体系**：`public.*` 的 bot 数据已迁出本库；残留的 `public` 函数（`compute_daily_metrics` 等）只改了限定名、存废另开评审。
- **simulation 测卡系统**：`miniapp_simulation` schema 已随 090 删除（保留 `characters.is_test` 标记），`shared/api/simulation` 契约已删。测卡系统自身的规划不由本项目裁决。
- **`miniapp_analytics`**：看数专用，任何域不得把它变成运行时依赖（归属地图红线）。
- **平台预设**：ST 酒馆格式预设（`st_platform.platform_presets`）连同 admin 管理通路已全部删除（087/088），数据执行删除前已导出留档。自建预设格式见 §10 的 M4。

---

## 10. 完成度与待办

### 10.1 已落地

| 能力                                                                 | 位置                                                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 会话数据模型 + 轮次/重生成语义 + 原子 RPC                            | migrations 069~073 / 077~079、`ChatSessionRepository`、`ConversationHistoryRepository` |
| Prompt 引擎（含平台规则三件套与降级）                                | `features/engine/`                                                                     |
| 上下文双水位线泄洪 + Anthropic prompt cache                          | 077、`features/conversations/context-window.ts`、`prompt-caching.ts`                   |
| 生成与计费出口（含 finish_reason 计费闸门）                          | `features/generation/` + 081/082                                                       |
| 对话 REST + SSE（含置顶 / 标题 / 分页）                              | `routes/conversations.ts` + `features/conversations/`                                  |
| 自研聊天 UI（M5：气泡 / markdown / 流式 / 重生成 / 工具箱）          | `frontend/src/app/chat/` + `components/chat/`                                          |
| 语音消息生成（DeepSeek 写稿 + MiniMax TTS，不扣费）                  | `routes/voice.ts` + `features/voice/` + 080                                            |
| 大厅推荐排序 v3 + 运营置顶 + 排序参数运营化                          | 074 / 088 / 093、`features/lobby/`                                                     |
| 支付四路入账 + 快速对账 + `settled_by` 溯源                          | `features/payment/` + 100/103 + Railway 双任务服务                                     |
| Schema 划分一阶段（八域物理布局，test + 生产）                       | 097~099、`getDomainDb`、Prisma 多 schema                                               |
| 端到端回归 + 数据库集成测试                                          | `scripts/mvp-regression/`、`*.integration.test.ts`                                     |
| 大厅 / 收藏 / 钱包 / 签到 / 许愿 / 消息中心 / 站内客服               | `routes/*` + `frontend/(main)/*`                                                       |
| 运营后台（14 个 managed 配置 / 角色卡 / 公告 / 发布历史 / 回访赠送） | `packages/admin` + backend admin 通路                                                  |
| CS 回访工作台（画像簇 / 特殊标记 / 等待状态 / 群发 / 导出）          | `packages/cs-platform` + 094                                                           |

### 10.2 待办

| 项                           | 状态 | 说明                                                                                                                |
| ---------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| Schema 划分批次 D 收口       | ⏳   | 观察期后删空壳 `miniapp` schema；补做需登录态的 7 项应用层验证（交接文档 §一）                                      |
| chat_history 列级瘦身        | ⏳   | `history` 列（TOAST ~10 GB）处置方案另立项；A 档 `llm_usage_cache`、B 档观测列待删（`docs/schema划分专项.md` §2.5） |
| 语音按次计费重启             | ⏳   | 101/102 已回退，重做需重新评审计费口径与部署顺序                                                                    |
| M4 自建预设格式              | ⏳   | 明确不沿用 ST 格式；旧预设数据已删（088），从零设计                                                                 |
| 角色卡人设字段进 prompt      | ⏳   | v1 只用 `system_prompt`，待新卡写法定稿后决定                                                                       |
| 支付 remediation 遗留        | ⏳   | 补账护栏与审计项见 `docs/payment-missing-credits-remediation.md`                                                    |
| Railway 控制台遗留清理       | ⏳   | `nginx-pro` / `st-bundle-pro` / `st-data-pro` / `ST_*` 变量 / `pr-276` 环境，人工确认删除                           |
| `users.st_handle` 等遗留列   | ⏳   | 归列级瘦身专项                                                                                                      |
| `Dockerfile.frontend` 取包层 | ⏳   | 与 backend 同款的构建卡死隐患，仅 `staging-*` 构建受影响                                                            |
| `api-contract` 独立包        | ❌   | 不建，职责留在 `shared/api`                                                                                         |

---

## 11. 环境变量（backend 主要项）

| 变量                                                                     | 用途                                                                 |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `DATABASE_ENV` + `PROD_*` / `TEST_*` 变量组                              | 选择环境并注入下面的标准名；非 prod 连生产库需 `ALLOW_PROD_DATABASE` |
| `DATABASE_URL` / `DIRECT_URL`                                            | Prisma 连接                                                          |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_PROJECT_REF`    | supabase-js 与环境隔离校验                                           |
| `LLM_UPSTREAM_URL` / `LLM_API_KEY`                                       | LLM 上游（默认 OpenRouter）与平台真实 key，仅 backend 持有           |
| `MINIMAX_API_KEY` / `MINIMAX_TTS_URL` / `MINIMAX_TIMEOUT_MS`             | 语音合成上游                                                         |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_URL` / `DEEPSEEK_MODEL`                   | 语音台词写稿上游                                                     |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN`                                      | 运行时配置缓存                                                       |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` / `BOT_INTERNAL_SECRET` | InitData 验签、webhook 与 Bot 内部端点鉴权                           |
| `CS_PLATFORM_URL` / `CS_ADMIN_TOKEN` / `CS_TELEGRAM_WEBHOOK_SECRET`      | CS 平台 CORS / 工作台鉴权 / CS webhook                               |
| `ADMIN_PLATFORM_URL`                                                     | 运营后台 CORS                                                        |
| `FRONTEND_URL`                                                           | CORS 与支付回跳                                                      |
| `PAYMENT_*`                                                              | 子千易 V2 RSA 商户配置、支付开关、异步回调与同步回跳地址             |
| `CHARACTER_STORAGE_BUCKET`                                               | 角色卡资源 bucket（默认 `character-assets`）                         |
| `DEFAULT_USER_AVATAR_URL`                                                | 平台默认头像                                                         |
| `CHAT_HISTORY_SYNC_ENABLED`                                              | OpenRouter 用量回捞定时任务开关                                      |
| `LOBBY_RANKING_REFRESH_ENABLED`                                          | 大厅推荐排序分每日重算开关                                           |
| `SENTRY_DSN` / `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE`                   | 异常上报（release 缺省回退 `RAILWAY_GIT_COMMIT_SHA`）                |
| `MOCK_AUTH` / `DEV_AUTH_BYPASS` / `LOG_LEVEL` / `LOG_PRETTY`             | 本地开发与回归脚本旁路                                               |

Vercel 侧关键变量：`NEXT_PUBLIC_API_URL`（backend 公网域名）。权威解析在 `packages/backend/src/platform/config.ts`；`ops/env/*.example` 示例文件比实际清单窄，以代码为准。

> ST 时代的 `ST_*` / `LLM_PROXY_TOKEN_SECRET` 等变量应用已不消费；Railway IaC 的 `preserve()` 与生产控制台可能仍留名，属待清理项（§10.2）。

---

## 12. 相关文档

| 文档                                          | 内容                                             |
| --------------------------------------------- | ------------------------------------------------ |
| `docs/ST_remove.md`                           | ST 替换总方案（代码侧清理已于 2026-08-19 收口）  |
| `docs/schema归属地图.md`                      | 八域归属与跨域访问规则（表和函数归属的权威来源） |
| `docs/schema划分专项.md`                      | miniapp 表盘点与 `chat_history` 字段级审计       |
| `docs/schema划分-一阶段执行计划.md`           | 八域物理划分的批次、验证与回滚纪律               |
| `docs/schema划分-批次A进度交接.md`            | **割接权威进度**：A/B/C0~C3 执行记录与遗留项     |
| `docs/context-window-and-prompt-cache.md`     | 双水位线泄洪与 prompt cache 设计（已落地）       |
| `docs/payment-zqpay-v2-integration.md`        | 子千易 V2 支付接入                               |
| `docs/payment-missing-credits-remediation.md` | 星尘不到账复盘：四路入账兜底的由来与待办         |
| `docs/fix-postgrest-schema-exposure.md`       | PostgREST schema 暴露的正确改法                  |
| `docs/log_system.md`                          | 日志分层与事件命名                               |
| `packages/backend/CLAUDE.md`                  | 后端硬规则                                       |
| `packages/frontend/CLAUDE.md`                 | 前端硬规则                                       |
