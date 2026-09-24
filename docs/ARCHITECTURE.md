# ST_miniAPP 架构说明

> 本文档描述项目当前架构（2026-09-14 更新，基于 2026-08-12 自研引擎版重写）。
> 八域划分与跨域豁免以本文 §5.1 和铁律 8 为准。ST 替换动机、归属地图原稿、099 割接剧本已移出工作区，取回方式见 §12。
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
> 语音消息生成链路已上线（080）；按次计费首版（101/102）曾整体回退（PR #298，test 库用 104 清理），随后以 **105_voice_billing_atomic** 重做落地，由 `runtime_config.voice_billing_enabled` 开关控制（默认关，详见 §4.6）。
> 2026-09 新增两条增长链路：裂变邀请（105–109，`routes/invite.ts`）与官方社群入群奖励（108/109，`routes/community.ts`），发奖全部在数据库 RPC 内完成（见 §1 铁律 6）。
> 角色回复图片生成的代码与 test migration 已落地，但 `image_generation_enabled` 默认关闭；真实 DeepSeek/Grok、Telegram 真机及 production 发布尚未验收，不视为现网已开放。

---

## 1. 架构铁律（违反即拦截）

1. **对外数据形状先定义在 `packages/shared/`**，再写 handler。backend 不得在包内私定对外类型。
2. **每条路由注册上方必须有 `@frontend-ready: true|false — 原因`**，半成品要写出带业务含义的原因。
3. **应用包互不 import**：`frontend` / `backend` / `cs-platform` / `admin` 之间没有 import 关系，跨进程一律走 HTTP。根目录 `.eslintrc.json` 拦包名与相对路径；已退场包由 `pnpm lint:legacy` 拦截。
4. **DB 类型不进前端**：前端、运营台与内部 SPA 只消费 `shared/api/*` 契约，不接触数据库行类型。
5. **前端不在组件里 fetch**：服务端数据统一走 `frontend/src/lib/api/` 的 React Query hooks；跨组件状态用 Zustand，局部状态用 `useState`。
6. **生成与计费只有一个出口**：任何要调聊天 LLM 的路径都必须走 `backend/src/features/generation/`（**含实扣**：`settle.ts` 与 `sync-job.ts` 两条结算路径也都在这个模块里）。禁止在别处另起一套"转发 + 扣费 + 落库"，否则计费口径必然漂移。唯一的刻意例外是语音写稿（`features/voice/`）：不同供应商、非流式、抽取任务、按次计费，理由写在 `voice-draft.ts` 与 `voice/billing.ts` 头注释里。
   同类纪律还有三条，一并由 CI 的 legacy guard 拦（见 §7.5）：`experience.chat_history` 只由 `ConversationHistoryRepository` 读写；支付到账只由 `PaymentSettlement.settlePaidOrder` 入账；OpenRouter 用量统计只由 `generation/openrouter-metadata.ts` 读取。
   **星尘发放（注册 / 签到 / 许愿 / 运营赠送 / 邀请 / 社群）只发生在数据库 `SECURITY DEFINER` RPC 内**，且六个发奖 RPC 的「钱包 upsert + `bonus_credits` 加值 + `wallet_ledger` 记账」都收口在唯一入口 **`billing.grant_bonus_credits`**（`20260911_billing_grant_bonus_credits.sql`）；业务判定（配置、去重、上限、通知、审计）留在各 RPC。应用层只调 RPC、不做手动余额加减。CI 由 legacy guard `wallet-bonus-grant` 拦新迁移里再出现 `bonus_credits = bonus_credits + …`（见 §7.5）。充值入账（动 `main_credits` 与支付字段）是另一条已收口的路径，不走这个入口。发奖 RPC 的挂点：邀请「聊天轮数」在 `generation/settle.ts` 结算成功后触发，「首次付费」在 `PaymentSettlement.settlePaidOrder` 入账后触发（`lib/invite-rewards.ts`），社群入群在 `routes/community.ts`（webhook 自动 + 既有成员手动校验）。
7. **`runtime_config` 只有一个读取入口**：`backend/src/platform/runtime-config.ts`（表在 `app_core.runtime_config`）。模型目录、定价、平台规则模板都从这里取，不允许并行实现第二套读法。
8. **数据库按八个归属域划分，新表必须声明归属域**（迁移文件头部注释 `-- domain: xxx`）；**跨域访问只准走 RPC / repository / API**，不得直接 SELECT/JOIN 另一个域的表。允许的惯例：指向根实体（`users` / `characters`）的 FK；`miniapp_analytics` 只读其他域，任何域不得反向读它。存量豁免（收口前不再新增同类）：
   - `users.total_round` / `miniapp_user_settings.total_round` 由 experience 链路回写；
   - `miniapp_features.character_ranking_scores` 由 lobby 定时任务直接聚合 `experience.chat_history`；
   - `experience.chat_history.llm_charge_id` 软引用 `billing.llm_usage_charges`；
   - `notifications.created_by`、`support_messages.agent_user_id` FK → `admin.admin_users`。
9. **迁移不随部署自动执行**：`packages/shared/migrations/*.sql` 由 GitHub Actions `Database Migration` 手动逐个触发；`mode=inspect` 只读互证，`mode=apply` 查账本、执行、记账在同一次调用里。执行状态在 `supabase_migrations.repo_migrations`（首次）和 `repo_migration_events`（含 `force_rerun` 历史）。2026-09-10 起新迁移命名 `YYYYMMDD_描述.sql`（CI 拦旧式编号）；历史存量存在重号（见 §7.4），**不要按序号推断内容**。改库只有仓库迁移一条路，禁止 Management API / Studio 直改。生产禁止跑 `104_rollback_voice_billing.sql`。
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
│ │    └ 工具箱：生成偏好 / 模型 / 语音 / 图片│        │ X-CS-Admin-     │ Supabase   │
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
        │   routes/voice.ts  语音消息生成（features/voice，开关控计费）      │
        │   routes/images.ts 图片描述/异步出图（DB 租约 worker，默认关闭）   │
        │                                                                   │
        │  平台业务：characters / favorites / wallet / payment / wishes /   │
        │            settings / models / notifications / support            │
        │  运营与增长：/api/cs/* · /api/growth/miniapp-entry ·              │
        │             /api/telegram/webhook · invite/* · community/*        │
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
│  ├ miniapp_traffic  渠道归因         │  Railway 另有支付任务；development 另有提醒 Cron：
│  ├ miniapp_analytics 看数视图        │   · payment-reconcile-cron（常驻对账）
│  ├ admin         运营台账号/审计     │   · payment-cron（*/5 过期任务）
│                                    │   · vip-reminder-cron（仅 development）
│  └ miniapp       空壳（待删）        │
│  Storage: character-assets /        │
│           miniapp-chat-voice / images │
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

`shared/src/api/` 包含 `envelope`（统一响应包络）、`characters`、`favorites`、**`conversations`**（含 SSE）、**`voice`**、**`images`**（配置、中文描述、attempt 与会话聚合）、`models`、`settings`、`wallet`、`payment`（含 `PaymentSettlementSource`）、`wishes`、`notifications`、`support`、`cs-platform`、`growth`（仅入口归因）、`invite`（裂变邀请）、`community`（官方社群奖励）、`health`、`lobby-pinned-characters`、`lobby-ranking-params`、`word-count-tiers`。

> ST 时代的 `chats` / `st-session` / `simulation` 契约已随 ST 清理删除。曾计划的独立 `api-contract` 包不建 ❌，职责留在 `shared/api`。
> `db-types` 包（Supabase schema 镜像）已随 ST 清理整包删除 ❌；`batch-lab` 内部调试包已退场 ❌，当前 `packages/` 有 5 个包。

### 3.2 应用层

| 包            | 职责                                                                                                                                                                                                     | dev 端口 | 部署                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------- |
| `frontend`    | Next.js 14 App Router：大厅 / 会话页（自研聊天 UI）/ 充值 / 许愿池 / 消息中心；React Query + Zustand；Telegram Mini App SDK                                                                              | 3000     | Vercel                  |
| `backend`     | Fastify 5：对话 REST + SSE、prompt 引擎、生成与计费出口、语音生成、平台业务 REST、CS / 归因 / Bot webhook                                                                                                | 3001     | Railway（容器内 :8080） |
| `admin`       | 运营后台：运营配置（17 个 managed key，含模型目录 / 平台规则 / 大厅置顶与排序参数 / 邀请规则与邀请中心）、角色卡、公告、发布历史、回访星尘赠送、邀请海报上传与邀请明细查询。Vite + React + AntD + Refine | 3003     | Vercel                  |
| `cs-platform` | 内部运营平台：CS 回访工作台（画像簇 / Telegram 1V1 SOP / 特殊标记 / 等待状态 / 群发 / 导出）+ 站内客服。Vite + React + React Query                                                                       | 3002     | Vercel                  |

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
图片消息端点在 `routes/images.ts`（见 §4.7）。

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
   （`generation/settle.ts` 即时写 + `generation/sync-job.ts` 30 秒轮询回捞 24h 内元数据不全或结算未完成的行）
```

**硬约束**：SSE 首字节写出之前不能有任何可能失败的判定。402（余额不足）、409（会话忙 / 不可重生成）、404 全部以 HTTP 状态码 + JSON 返回；响应头一旦发出就只能降级成流内 `error` 事件。所以响应头推迟到上游已 2xx 的 `onStreamOpen` 才写——不是等第一个 token，否则客户端要白等一整个上游首 token 延迟才能挂上占位气泡。

### 4.4 Prompt 组装（`features/engine`）

v1 是旧 bot `SimplePromptEngine` 的忠实移植，最终形状：

```
[system: 角色卡 system_prompt] + 历史（含虚拟 turn 0 开场白） + [user: 平台规则 + 本轮输入]
```

- **上下文长度管理已落地（077）**：双水位线泄洪，窗口在 [A, B] 轮之间增长，超过高水位 B（`max_context_turns`，默认 75）一次性收缩到低水位 A（`retain_context_turns`，默认 50）。窗口起点持久化在 `chat_sessions.context_window_start_turn`，由开轮 RPC 在会话行锁内更新（`apply_context_window_flood`）；**不删** `chat_history`，只决定本轮 prompt 带哪些轮。引擎不二次裁剪，`truncatedTurns` 回填真实观测值。双水位（而非滑动窗口）是为了给 Anthropic prompt cache 制造稳定前缀；设计原稿：`git show b4491cd^:docs/context-window-and-prompt-cache.md`。
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

| 文件                     | 职责                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve-model.ts`       | 权威模型解析：用户 `selected_model_id` → 模型目录 → `ResolvedModel`                                                                                                                                     |
| `quota.ts`               | 角色免费额度 `reserve` / `finalize` 两阶段                                                                                                                                                              |
| `precheck.ts`            | 定档扣费额与计费快照、余额预检（402 判定，不构造响应）                                                                                                                                                  |
| `upstream.ts`            | 上游转发原语 + SSE tap（逐字节透传、抓 `generation_id` / `finish_reason`、判 `[DONE]`）                                                                                                                 |
| `prompt-caching.ts`      | Anthropic `cache_control` 断点注入（system + 窗口内历史最后一条，不打本轮输入）                                                                                                                         |
| `execute.ts`             | `GenerationService`：把上面串成一条出口，供对话链路直调                                                                                                                                                 |
| `apply-charge.ts`        | settle / sync-job 共用的定档扣费拼装：闸门标签 → `charge_llm_usage` → 免费额度收口（不回写 `chat_history`）。已 charged / free 的行可重入：RPC 幂等，补额度收口                                         |
| `settle.ts`              | 先落请求时定价快照 → 补用量元数据 → `applyLlmCharge` → 回写计费列与 `llm_billing_settled_at`；fire-and-forget。成功结算后顺带调 `check_invite_chat_rounds_reward`（邀请聊天轮数发奖判定，失败只打日志） |
| `sync-job.ts`            | 计费的第二条到达路径：30 秒轮询回捞 24h 内用量元数据不全**或结算未完成**的行。无 charge 行按快照补建；定档 pending / charged / free 都走 `applyLlmCharge`（历史 usage 对账仍走 `reconcileLlmUsage`）    |
| `openrouter-metadata.ts` | OpenRouter 用量统计（`/generation?id=`）的唯一读取与字段映射入口，settle / sync-job 共用                                                                                                                |

`settle.ts` 是 fire-and-forget 的：它第一步要等 OpenRouter 的异步用量统计（约 1.5 秒起），挂在请求里会让用户在回复已经流完之后继续等。它与请求内同步的 `finalizeTurn` 写同一行 `chat_history` 的**不同列**，列归属见 `ConversationHistoryRepository` 头注释，因此谁先落地都不会互相覆盖。

计费要点：

- 定档扣费（`billing_mode: 'fixed_tier'`，配置在 `runtime_config.llm_pricing_config`；084/085 之后模型目录用 `is_free` 标免费模型，不再有展示价与 markup）。
- 免费额度按**用户 × 角色**计轮，上限来自 `runtime_config.miniapp_character_free_chat_quota_limit`（默认 40）。
- 实扣走 RPC `billing.charge_llm_usage`，幂等键是 `charge_id`。
- **finish_reason 计费闸门（081/082）**：只有 `status=success` 且 `finish_reason='stop'` 的自然收尾才扣星尘；finish_reason 未到时挂 `pending` 等 sync-job 回捞后结算；截断（length）、中断、上游错误一律不扣费。消费明细带 `reply_outcome`（complete / incomplete / empty）体验口径标签。
- **VIP 文本折扣与钱包分配**：有效会员的折扣在受理时写入计费快照，按模型原价 × 已发布 `vip_text_discount_rate` 四舍五入为整数；之后改配置不重算该快照。免费额度仍优先。轻量模型先扣 `main_credits`，不足再扣 `bonus_credits`；标准/旗舰只扣 `main_credits`。余额不够则整笔拒绝。已扣费后的失败按原拆分走 `billing.wallet_refunds` 幂等退回，不在 route 里直接改余额。
- **完成态拆开**：用量元数据补齐 ≠ 结算完成。`experience.chat_history.llm_billing_snapshot` 保存请求时定价快照；`llm_billing_settled_at` 有值才表示扣费行存在、额度已收口、金额已回写。短暂扣费 / 额度 / 回写失败时元数据仍可先落，回捞按快照补建，不重新定价。

### 4.6 语音消息（`features/voice`）✅ 生成链路 / ✅ 按次计费链路（开关默认关）

| 方法 / 路径                                                       | 职责                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `GET` · `PATCH /api/v1/voice/config`                              | 用户语音偏好（音色 `pref_voice_id`、倍速）                    |
| `GET /api/v1/conversations/:sessionId/voice`                      | 会话内语音状态批量查询（前端轮询）                            |
| `POST /api/v1/conversations/:sessionId/messages/:messageId/voice` | 生成语音（202 受理，异步执行；可带 `custom_text` 自定义台词） |

流水线：受理落 `experience.chat_message_audio` pending 行 → DeepSeek 写台词稿（有 `custom_text` 则跳过）→ MiniMax TTS 合成 → 音频落 Storage `miniapp-chat-voice` 桶 → markReady。前端在气泡底部提供生成 / 播放 / 再生成，另有自定义台词页 `/chat/[characterId]/voice/[messageId]`。

**计费状态**：首版按次扣费（PR #293，迁移 101/102）2026-08-28 整体 revert（PR #298），test 库用 `104_rollback_voice_billing.sql` 清理（生产从未执行 101/102，**不要在生产跑 104**）。随后以 `105_voice_billing_atomic.sql` 重做：`billing.charge_voice_usage` RPC 在 Storage 已有可播 URL 之后、`markReady` 之前原子扣费，幂等键 `charge_key = audio_id`，结果写回 `chat_message_audio.credits_charged / debit_ledger_id / charged_at`。应用侧入口是 `features/voice/billing.ts`（`precheckVoiceCredits` / `settleVoiceGeneration`），与聊天 LLM 计费刻意平行、不共用 `applyLlmCharge`。**是否真扣**由 `runtime_config.voice_billing_enabled` 决定（`voice-billing-config.ts` 读七个 `voice_*` key，默认 `enabled: false`、15 星尘/次）；这些 key **不在 admin 的 managed key 清单里**，目前只能走迁移改。语音成功免费次数另由已发布 `feature_free_trial_limits.voice` 控制，和初级图片分开计数；失败释放预留，不计成功次数。超过上限后只扣充值钱包。

### 4.7 角色回复图片（代码已落地，runtime 开关默认关）

| 方法 / 路径                                   | 职责                                     |
| --------------------------------------------- | ---------------------------------------- |
| `GET /api/v1/images/config`                   | 安全展示配置、价格、尺寸与提示           |
| `GET /api/v1/conversations/:sessionId/images` | 会话内图片 current/latest 聚合与轮询恢复 |
| `POST .../:messageId/image-description`       | DeepSeek 免费生成中文分镜描述            |
| `POST .../:messageId/image`                   | 确认中文稿并创建 pending attempt（202）  |

流水线：角色视觉锚点与回复资格校验 → 默认 DeepSeek 写稿或保留自定义中文稿 → `experience.chat_message_images` pending → `claim_chat_image_jobs` 租约领取 → DeepSeek 直译英文 → Grok/Liaobots（失败后以相同内容降级 Replicate Z）→ 下载 URL 的 HTTPS/私网/大小/MIME 防护 → Storage `miniapp-chat-images` → `billing.settle_image_generation` 原子扣款、ledger 与 current ready。provider 写请求不自动重投；Replicate 仅轮询同一个 prediction。余额竞争明确失败时删除对象，结算响应未知时保留对象和状态等待幂等对账。

初级图片成功免费次数读取已发布 `feature_free_trial_limits.basic_image`，与语音隔离；高级图片没有免费额度，且非有效 VIP 时后端拒绝。已展示内容使用本次 attempt 快照，发起或重试按钮使用下一次可用额度。图片 runtime 开关仍默认关闭；真实 provider、Storage 与生产开放不因 VIP 验收通过而视为已打开。

### 4.8 VIP 会员、策略与到期提醒

资格真相在 `billing.vip_memberships`。`GET /api/vip/status` 与 `POST /api/vip/entry-viewed` 由 `routes/vip.ts` 提供；`active` 只比较服务端 `valid_until` 与当前时间。`benefits` 把已发布折扣、签到基础值和 VIP 加成给未开通用户展示，缺字段时前端不补数字。一次性角标由 `entry-viewed` 在服务端记住。

商品、折扣、签到加成和媒体免费上限都在 Admin「VIP策略」里草稿/发布，经 `platform/runtime-config.ts` 读取。配置键是 `vip_purchase_enabled`、`vip_reminders_enabled`、`vip_plans_config`、`vip_text_discount_rate`、`vip_checkin_bonus_config`、`feature_free_trial_limits`。代码损坏回退是周卡 100 分 / 7 天、月卡 200 分 / 31 天 / 3000 专项星尘、折扣 0.95、签到加成为与基础值相同的额外星尘、语音和初级图片各 3 次。周卡赠送固定为 0。已创建订单、已受理生成和已领取签到继续用各自快照。

`20260924_vip_plans_price_1_and_2_yuan.sql` 只改已发布配置和未发布草稿的 `price_cents`。任务日志没有记录该文件在 test 或 Production 的 apply；未执行前，页面价格仍是当时已发布值。T8 不补执行。

支付仍走现有四路，进入 `complete_payment_order`。VIP 订单履约延长会员并按商品快照发放专项星尘；同一订单重复确认只履约一次。购买开关关闭时不能新建 VIP 订单，已履约会员继续有效。

到期提醒脚本是 `packages/backend/src/scripts/send-vip-expiry-reminders.ts`。`--dry-run` 只计数。`--write` 还要求已发布 `vip_reminders_enabled` 恰好为 true。窗口是 Asia/Shanghai 的到期当天和提前 3 天，同一周期不重复插入。Railway development 的 `stminiapp-vip-reminder-cron` 以 `--write` 运行；production IaC 不声明该 Cron。消息详情是 `GET /api/notifications/:id`；`POST /api/notifications/read` 必须带具体 id，只提交 scope 会 400。历史通知正文不因续费改写。

2026-09-24 产品确认 TEST 真机 VIP 验收通过。当时任务日志中的 TEST 状态是 `vip_purchase_enabled=true`、`vip_reminders_enabled=true`。Production 购买、提醒和数据都未按本任务打开，上线仍等 T9 的明确批准。

---

## 5. 数据模型与真相归属

### 5.1 数据库八域布局（099 之后，test 与生产一致）

| Schema              | 归属域       | 内容                                                                                                                                                                                                                                      |
| ------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_core`          | 跨模块根数据 | `users` / `miniapp_user_settings` / `characters` / `runtime_config`                                                                                                                                                                       |
| `experience`        | 核心互动内容 | `chat_sessions` / `chat_history` / `chat_message_audio` / `chat_message_images`（图片 attempt 与租约）/ 视图 `current_chat_history`                                                                                                       |
| `billing`           | 钱           | `payment_orders` / `wallet_ledger` / `user_wallets` / `llm_usage_charges` / `llm_usage_charge_dedup` / `character_free_chat_quotas` / `vip_memberships` / `vip_purchase_grants` / `feature_free_trials` / `wallet_refunds` / `_decisions` |
| `miniapp_features`  | 产品功能状态 | `character_favorites` / `character_ranking_scores` / `daily_checkins` / `wish_roles` / `notifications` / `notification_reads` / `community_reward_claims` / `telegram_community_update_receipts`（108）                                   |
| `cs_platform`       | 客服与触达   | CS 回访画像与会话 + 迁入的 `support_conversations` / `support_messages`                                                                                                                                                                   |
| `admin`             | 运营管理     | 运营台账号、草稿 / 发布 / 审计（边界不变）                                                                                                                                                                                                |
| `miniapp_traffic`   | 渠道归因     | `botlinks` + 裂变邀请三表 `invite_codes` / `invite_relations` / `invite_reward_logs`（105，acquisition 域，名称不改）                                                                                                                     |
| `miniapp_analytics` | 看数         | 只读视图；红线：不得成为任何运行时依赖                                                                                                                                                                                                    |
| `miniapp`           | —            | **空壳**，批次 D 观察期后删除 ⏳                                                                                                                                                                                                          |
| `public`            | —            | 旧 bot 残留函数（数据已迁出本库；函数存废另开评审）                                                                                                                                                                                       |

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

| 数据                 | 权威源                                                                                         | 备注                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 用户身份             | `app_core.users`                                                                               | TG 身份 + 归因字段，身份一律用 `tg_id`（`st_handle` 退场中，见 §10.2） |
| 角色卡元数据         | `app_core.characters`（Prisma）                                                                | 大厅展示 + 引擎取数；`raw_card` 保留原始 JSON                          |
| 角色卡资源           | Supabase Storage `character-assets`                                                            | PNG / 头像；前端只读                                                   |
| **会话**             | **`experience.chat_sessions`**                                                                 | 置顶 / 标题 / 窗口起点 / 统计缓存                                      |
| **对话内容与轮次**   | **`experience.chat_history`**                                                                  | 上下文 / 计费 / 审计三用；ST 存量行 `session_id` 为 NULL               |
| 语音消息             | `experience.chat_message_audio` + Storage `miniapp-chat-voice`                                 | 每条 assistant 回复的 TTS 产物元数据                                   |
| 图片消息             | `experience.chat_message_images` + Storage `miniapp-chat-images`                               | 每条 assistant 回复的图片 attempts、current 与内部任务状态             |
| 用户生成配置         | `app_core.miniapp_user_settings`                                                               | `selected_model_id` + 三个 `pref_*` + 语音偏好；用户级生效             |
| 钱包 / 订单 / 签到   | `billing.user_wallets` / `payment_orders` / `wallet_ledger`、`miniapp_features.daily_checkins` | `payment_orders.settled_by` 记录入账路径（103）                        |
| VIP 资格与免费体验   | `billing.vip_memberships` / `vip_purchase_grants` / `feature_free_trials`                      | 权益配置在 `runtime_config`；订单快照和已消费次数不随配置回滚改写      |
| LLM 计费明细         | `billing.llm_usage_charges`（+ `_dedup` 幂等墓碑）                                             | 每用户保留最近 100 条完整行，更早压缩进 dedup                          |
| 免费额度             | `billing.character_free_chat_quotas`                                                           | 用户 × 角色计轮                                                        |
| 收藏 / 许愿 / 排序分 | `miniapp_features.character_favorites` / `wish_roles` / `character_ranking_scores`             | 排序分由 lobby 定时任务从 `chat_history` 聚合重算（074）               |
| 消息中心 / 站内客服  | `miniapp_features.notifications` / `notification_reads`、`cs_platform.support_*`               | —                                                                      |
| 平台运行时配置       | `app_core.runtime_config`（+ Upstash Redis 缓存）                                              | 模型目录、定价、平台规则三件套、充值套餐、大厅置顶与排序参数等         |
| CS 回访              | `cs_platform.*`                                                                                | `user_metrics` / `persona_users_detail` 视图（094 补效率字段）         |
| 渠道归因             | `miniapp_traffic.*`                                                                            | Bot `/start` 与 miniapp 进入上报                                       |

**Prisma vs supabase-js 边界**：`schema.prisma` 只声明 `app_core` / `miniapp_features` / `billing` 三个 schema 共 11 个 model（用户、角色卡、runtime_config、签到、许愿、订单、钱包、流水、计费）；`experience`、`cs_platform`、`admin`、`miniapp_traffic`、`miniapp_analytics` 以及所有 RPC 走 supabase-js **按域客户端**（`lib/supabase.ts` 的 `getDomainDb(域)`）或 raw SQL 全限定名。统一 `.schema('miniapp')` 的旧写法已废弃。

---

## 6. 路由清单（backend，dev :3001 / prod :8080）

`src/app.ts` 注册全部路由插件，均使用完整路径字面量（不用 Fastify prefix）。CORS 允许 `FRONTEND_URL` / `CS_PLATFORM_URL` / `ADMIN_PLATFORM_URL`。

| 路由文件                  | 主要路径                                                                                                                                                                         | 鉴权                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `conversations.ts`        | `/api/v1/conversations*`、`/api/v1/generation-config`（见 §4.2）                                                                                                                 | `X-Init-Data`             |
| `voice.ts`                | `/api/v1/voice/config`、`/api/v1/conversations/:sessionId/voice`、`.../messages/:messageId/voice`（见 §4.6）                                                                     | `X-Init-Data`             |
| `images.ts`               | `/api/v1/images/config`、会话图片查询、`.../image-description`、`.../image`（见 §4.7）                                                                                           | `X-Init-Data`             |
| `characters.ts`           | `GET /api/characters` · `/:id` · `/latest-badge` · `POST /latest-seen`                                                                                                           | 列表公开，红点需鉴权      |
| `favorites.ts`            | `GET /api/favorites` · `/ids`、`PUT`/`DELETE /api/favorites/:characterId`                                                                                                        | `X-Init-Data`             |
| `models.ts`               | `GET /api/platform/openrouter/models`、`GET /api/v1/models/config`、`POST /api/v1/models/select`（旧 tiers 端点 `/api/platform/models` 已删）                                    | 部分公开                  |
| `settings.ts`             | `GET`/`PATCH /api/users/settings`、`POST /api/users/avatar`                                                                                                                      | `X-Init-Data`             |
| `wallet.ts`               | `/api/wallet/balance` · `/spending` · `/free-quota/:characterId` · `/checkin`                                                                                                    | `X-Init-Data`             |
| `payment.ts`              | `/api/payment/plans` · `/orders*` · `/return` · `/webhook/zqpay`                                                                                                                 | RSA 回调验签              |
| `vip.ts`                  | `GET /api/vip/status` · `POST /api/vip/entry-viewed`                                                                                                                             | `X-Init-Data`             |
| `wishes.ts`               | `/api/wishes/status` · `POST /api/wishes` · `/:id/complete`                                                                                                                      | `X-Init-Data`             |
| `notifications.ts`        | `/api/notifications` · `/unread-count` · `/:id` · `/read`（已读必须带消息 id）                                                                                                   | `X-Init-Data`             |
| `support.ts`              | `/api/support/conversation` · `/messages` · `/unread` · `/read`                                                                                                                  | `X-Init-Data`             |
| `cs-platform.ts`          | `/api/cs/*`：画像簇 CRUD/refresh、簇内用户、回访 session（advance/snooze/skip）、消息收发/重试、特殊标记、按等待状态群发、XLSX 导出、审计日志、CS 侧客服会话、CS 专用 TG webhook | `X-CS-Admin-Token`        |
| `growth.ts`               | `POST /api/growth/miniapp-entry`（089 之后仅剩入口归因；渠道链接管理与 click 重定向已下线）                                                                                      | `X-Init-Data`             |
| `invite.ts`               | `GET /api/invite/entry-status` · `POST /api/invite/center-view` · `POST /api/invite/bind` · `GET /api/invite/stats`（裂变邀请；发奖全在 `miniapp_traffic` RPC 内）               | `X-Init-Data`             |
| `community.ts`            | `GET /api/community/entry` · `POST /api/community/verify-membership`（既有成员手动领奖）· `POST /api/telegram/community-webhook`（新成员入群自动发奖）                           | `X-Init-Data` / TG secret |
| `bot.ts`                  | `POST /api/internal/bot/start`、`POST /api/telegram/webhook`                                                                                                                     | 内部密钥 / TG secret      |
| `admin-supabase-proxy.ts` | `POST /api/admin/character-assets/:characterId`、`POST /api/admin/invite-poster`（107 桶）、`ALL /api/admin/supabase/*`                                                          | Supabase session          |
| `app.ts`                  | `GET /health`                                                                                                                                                                    | 公开                      |

frontend 自有 Route Handler：`GET /api/lobby-characters`（白名单 sort 参数后代理 backend 角色卡列表）。

**鉴权机制**：用户侧统一 `requireTelegramAuth`（`middleware/auth.ts`，读 `X-Init-Data` 做 HMAC-SHA256 校验；非生产可用 `MOCK_AUTH=1` / `DEV_AUTH_BYPASS=1` 旁路）。运营侧 CS 用 `X-CS-Admin-Token` + `X-CS-Operator-Id`，admin 用 Supabase 会话，Bot 用 `X-Bot-Internal-Secret` 与 Telegram webhook secret。

**进程内定时任务**（`app.ts` 启动，不走 HTTP）：`features/generation/sync-job.ts`（OpenRouter 计费回捞）、`features/image/job.ts`（图片 DB 租约 worker，可由 `IMAGE_WORKER_ENABLED` 关闭）、`lib/lobby-ranking-refresh-job.ts`（大厅排序重算）。支付对账与过期是独立 Railway 服务（见 §8）。

---

## 7. 工程约定

### 7.1 前端

- Next.js 14 App Router，`src/app/` 下 `(main)` 分组承载底部四 Tab（大厅 `/` / 聊天 `/chats` / 创作 `/create` / 我的 `/profile`），会话页是 **`/chat/[characterId]?session=...`**（不在分组内，无底部导航），另有自定义语音台词页 `/chat/[characterId]/voice/[messageId]`。
- 自研聊天 UI（M5 已交付）：`components/chat/` 下消息列表 / 气泡 / markdown（showdown + DOMPurify）/ 输入区 / 重生成 / 语音播放条 / 会话抽屉 / 工具箱；SSE 客户端是 `lib/api/conversation-stream.ts` 的 `streamConversationTurn()`（旧 `apiStreamClient` 已删除）。会话页编排：`hooks/use-chat-session.ts` 管创建 / URL `?session=` / 失效重建，`hooks/use-conversation-turn.ts` 管发消息、重生成、abort、流式临时态与失败分流；语音生成仍留在 page。余额不足跳充值统一走 `lib/recharge-redirect.ts`（同时认 `insufficient_balance` 与 `INSUFFICIENT_CREDITS`）；`apiClient` 会把对话/语音的 402 裸形状收成带金额的 `ApiClientError`。
- 用户生成配置有编辑界面：模型档位在 `ChatTopBar` 的引擎胶囊里，由 `ChatModelSwitcher` 展开；工具箱不再放模型入口。角色回复图片通过消息操作行与独立 Sheet 交互。VIP 详情在 `/vip`，和星尘套餐在充值页互斥选择。
- 服务端数据一律 React Query，封装在 `src/lib/api/`；`client.ts` 是唯一 REST 客户端。
- 跨组件状态 Zustand：仅 `user-profile-store`（会话列表走 React Query，不进 store）。
- 表单 React Hook Form + Zod；UI 用 Tailwind + shadcn/ui。

### 7.2 后端目录

```
packages/backend/src/
├── app.ts / server.ts      # Fastify 组装与启动（含进程内定时任务）
├── instrumentation.ts      # Sentry 初始化
├── middleware/auth.ts      # requireTelegramAuth
├── routes/                 # 路由（见 §6）
├── features/               # conversations / engine / generation / voice / image /
│                           # billing / lobby / payment / community
├── infrastructure/         # repositories / payment 网关 / redis
├── platform/               # config, runtime-config, model-tiers, openrouter-models
├── lib/                    # supabase(getDomainDb), user, ranking job, voice/image storage,
│                           # logger, sentry, notifications…
└── scripts/                # 运维脚本（支付对账/过期/回调日报）
```

**`lib/` 的边界**：只放跨 feature 的技术设施（DB 客户端、日志、存储、用户身份）。**带业务决策的代码一律进 `features/`**——尤其是花钱、扣费、落业务表的。历史上 LLM 实扣曾经藏在 `lib/chat-history-logger.ts` 里，照着链路读下来根本找不到钱在哪扣，现已收回 `features/generation/settle.ts`。

### 7.3 测试与回归

- 单元测试：Vitest，无凭证。CI `quality-gate` 跑 shared / backend / frontend / admin 的适用 `pnpm test`。backend 默认排除 `*.integration.test.ts`。
- 真库集成：`pnpm --filter @miniapp/backend test:integration`（`conversations.integration.test.ts`：会话、轮次、重生成、并发、软删除）。缺凭证时 skip，不把 skip 当成真库通过。
- 本地验不到的部分：真实上游的流式时序、中间层对 SSE 的缓冲（已按惯例下发 `X-Accel-Buffering: no`），需真机验。

### 7.4 迁移

- 位置 `packages/shared/migrations/`（`archive/` 另存 087 删除的 admin RPC 定义备查）。
- **命名规则（2026-09-10 起）**：新迁移一律 `YYYYMMDD_描述.sql`。三位数字编号已停用并由 CI 拦截（`pnpm lint:migrations`，冻结清单在 `scripts/check-migration-filenames.mjs`）——历史上 021/030/031/032/053/065/086/088/092/093/095 撞号，100 号立规后 105/108/109 又各撞一对。
- **迁移账本**：`supabase_migrations.repo_migrations` 记录每个环境实际执行过的文件（filename / checksum / applied_by / applied_at）。这是平台 schema 上的仓库账本，不是八个业务域的表，也不是 CLI 的 `schema_migrations`。`Database Migration` workflow 的 `apply` 把查账本、执行 SQL、写账本放在同一次调用（`scripts/apply-repo-migration.sh`）：已记录且 checksum 一致则拒绝重跑；checksum 不一致报 `MIGRATION_CHECKSUM_DRIFT`（不要改旧文件再跑，写新迁移）；账本表不存在时除 `20260910_schema_migrations_ledger.sql` 外直接失败，不再静默放行。`force_rerun` 只允许文件未改时再执行一遍 SQL，**不覆盖**首次 `applied_at` / checksum，历史写在 `repo_migration_events`（`20260914_repo_migration_ledger_events.sql`）。Apply 与 Record 之间用 `repo_migration_claims` 认领，避免「库已变、账本没有」。`mode=inspect` 用仓库日期命名文件的 sha256 对账本，并探 R3 `grant_bonus_credits`、111 `st_handle` 可空、A 的结算两列。账本只覆盖 2026-09-10 后的新迁移，存量不回填。生产环境拒绝 `104_rollback_voice_billing.sql`。本地协议回归：`pnpm test:migration-ledger`。
- **历史存量编号必须小心**（均已冻结，仅供查档）：
  - 021 / 030 / 031 / 032 / 053 / 065 历史重号，同号无依赖，按文件名字母序执行；
  - 086 / 088 / 092 / 093 / 095 与 105 / 108 / 109 也各有两个文件，来自并行发布线，**同号但含义不同，不要按序号推断内容**；
  - 105–112 按文件名对号（两条并行线：裂变邀请 vs 语音计费 / 社群奖励）：`105_invite_program`（邀请三表 + RPC）/ `105_voice_billing_atomic`（语音扣费 RPC）；`106_invite_admin_query`；`107_invite_poster_bucket`；`108_invite_chat_round_reward` / `108_official_community_reward`；`109_invite_first_paid_reward` / `109_community_existing_member_reward`（整体替换 108 的 `grant_community_join_reward`）；`110_characters_add_persona_and_style`；`111` / `112` 为 `st_handle` 退场两步；
  - 101 / 102 缺号：语音计费迁移已随 PR #298 revert 从仓库删除，test 库用 104 回滚（生产从未执行，**不要在生产跑 104**）；
  - 099 有配套 `_rollback` 文件，是正向 + 回滚，不是撞号。
- 执行方式：GitHub Actions → `Database Migration` → 选 `mode`（`inspect` 只读 / `apply` 执行）→ 选环境 → `apply` 时填文件路径；生产需在 `confirm_production` 填 `RUN_PRODUCTION_MIGRATION`。workflow 会校验连接串 project ref（test = `zoqelpfhurwehlvypryl`，production = `wbtsfzozlmurljvglhpn`）。**改库只有这一条路**：禁止 Supabase Management API / Studio 直改表结构。
- **099 不是普通迁移**：test 与生产均已执行完毕。当时的停流量 / 前置 097/098 / 事务外收尾剧本是历史文档：`git show b4491cd^:docs/schema划分-一阶段执行计划.md`。

### 7.5 legacy guard（禁止旧链路的新引用）

`scripts/check-legacy-references.mjs`，本地跑 `pnpm lint:legacy`，CI 在 import guard 之后强制执行。

它解决的问题是：本仓经历过 ST 退场、schema 拆八域、growth 下线、支付方案变更等多轮迁移，靠人 review 记不住哪条链路已经死了。每条规则都对应一个**已经收口完成**的决定，命中即说明有人又开了第二条：

| 规则                          | 拦什么                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `miniapp-schema-client`       | `.schema('miniapp')` / `getDomainDb('miniapp')`                                                            |
| `miniapp-schema-sql`          | `FROM/JOIN/INTO/UPDATE/TABLE miniapp.*`                                                                    |
| `dropped-schema-sql`          | `st_platform` / `st_users` / `st_infra` / `growth` / `miniapp_simulation` 限定名                           |
| `deleted-packages`            | `@miniapp/db-types` / `sync-engine` / `st-extension`、`@repo/bridge-protocol`                              |
| `retired-identifiers`         | `apiStreamClient` / `platform_presets` / `chat_engine_mode` / `routes/llm-proxy` / `deduct_wallet_credits` |
| `chat-history-writer`         | `ConversationHistoryRepository` 之外读写 `chat_history`                                                    |
| `llm-chat-upstream`           | `upstream.ts` 之外打 `/chat/completions`                                                                   |
| `openrouter-generation-api`   | `openrouter-metadata.ts` 之外读 OpenRouter 用量统计                                                        |
| `payment-settlement`          | `PaymentSettlement` 之外调 `complete_payment_order`                                                        |
| `llm-usage-charge`            | `apply-charge.ts` 之外调 `chargeLlmUsage`（settle / sync-job 必须走 `applyLlmCharge`）                     |
| `legacy-model-tiers-contract` | 旧模型档位契约与 `llm_model_tiers` 回退（模型目录只有 catalog 一种形状）                                   |
| `wallet-bonus-grant`          | `grant_bonus_credits` 之外出现 `bonus_credits = bonus_credits + …`（发奖 RPC 必须调唯一入口）              |

**扫描范围只含活代码**（`packages/*/src`、`scripts/`，以及 `packages/shared/migrations/` 下 **日期命名的新迁移**）。三位编号的历史迁移 SQL、`docs/`、`ops/` 快照按定义就是留档，刻意不扫——改已执行过的迁移比留着它更危险；新迁移在 PR 阶段尚未执行，正是拦「新迁移又开一条旧链路」的时机。

每条规则的 `allow` 清单就是「这条主路径本人 + 测试夹具」。**往 `allow` 里加文件等于宣布又多了一个出口**，必须在 PR 描述里写清业务上为什么必须独立。

---

## 8. 部署

| 单元         | 包 / 镜像                       | 说明                                                                                                                                                       | 平台           |
| ------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 平台前端     | `packages/frontend`             | Vercel 构建部署，对外域名绑定 Vercel                                                                                                                       | Vercel         |
| CS 运营平台  | `packages/cs-platform`          | 独立 Vercel 项目（Vite 静态构建）                                                                                                                          | Vercel         |
| 运营后台     | `packages/admin`                | 独立 Vercel 项目（Vite 静态构建）                                                                                                                          | Vercel         |
| miniapp 后端 | `ops/docker/Dockerfile.backend` | Railway 服务 **`stminiapp`**（唯一对外 HTTP），容器内 :8080                                                                                                | Railway        |
| 支付快速对账 | 同上镜像                        | Railway 服务 `stminiapp-payment-reconcile-cron`：常驻 worker，进程内约 30 秒一轮按 `next_reconcile_at` 领单查厂商                                          | Railway        |
| 支付过期任务 | 同上镜像                        | Railway Cron `stminiapp-payment-cron`：`*/5 * * * *` 跑过期前回溯对账 + 判过期                                                                             | Railway        |
| VIP 到期提醒 | 同上镜像                        | Railway Cron `stminiapp-vip-reminder-cron`：仅 development，`20 * * * *` 执行 `--write`；production IaC 不声明。写入还要 TEST `vip_reminders_enabled=true` | Railway        |
| 数据与存储   | 托管                            | PostgreSQL + Storage；test 与 production 两个项目                                                                                                          | Supabase Cloud |

**流量路径**：用户或内部使用者 → Vercel（页面 / SPA）→ backend 公网域名 → Supabase / OpenRouter / MiniMax。浏览器直接把 `/api/*` 发往 backend 域名，中间**没有任何反代**（ST 时代的 nginx 网关已随收敛退场）。

> 跨域直连要求变量成对配好，任一侧配错即浏览器侧请求全挂：Frontend Vercel 的 `NEXT_PUBLIC_API_URL` = backend 公网域名（build 期固化，改后需 redeploy）；backend 的 `FRONTEND_URL` allowlist 对应 Vercel origin。

**Railway IaC**：`.railway/railway.ts` 声明 `development`（跟 `dev` 分支）与 `production`（跟 `main` 分支）。production 是上述三个常驻/支付服务；development 额外声明 VIP 提醒 Cron，以 `--write` 运行但仍受 TEST `vip_reminders_enabled` 开关保护。改动需 `railway config plan/apply`，且渲染 production 必须显式 `RAILWAY_CONFIG_ENV=production`。**`main` 分支自动部署生产**（三个服务的 deployment trigger 均为 `branch=main`）——合并进 `main` 即上线，数据库迁移需在合并前按 §7.4 手动执行。对 `dev` 的 PR 会由 `railway-pr-env.yml` 拉起 `pr-{N}` 临时环境（变量继承 development，指向 test 库），复制完成后删除 VIP 提醒 Cron，保证 TEST 只有 development 的单一调度器。

**支付入账的四条路径**（唯一出口 `features/payment/usecases/PaymentSettlement.settlePaidOrder`，幂等靠 `credits_added`，先到者写 `payment_orders.settled_by`）：`webhook`（网关异步回调）→ `return`（同步回跳）→ `query`（订单页轮询时对账）→ `cron`（上述两个 Railway 任务兜底）。四路兜底的由来见历史文档 `git show 7541a54^:docs/payment-missing-credits-remediation.md`（生产曾因 cron 未部署漏账）。

**CI/CD**（`.github/workflows/`）：`ci.yml`（typecheck / lint / import guard / **legacy guard** / 测试 / Docker 构建，矩阵仅 backend）、`build-and-push.yml`（GHCR 镜像：backend 跟 `dev` 推送；frontend 仅 `staging-*` tag）、`db-migrate.yml`（手动迁移）、`pr-review.yml`、`railway-pr-env.yml`（PR 临时环境）。生产不走 GHCR，Railway 直接从 GitHub `main` 构建。

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

| 能力                                                                                   | 位置                                                                                                                                         |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话数据模型 + 轮次/重生成语义 + 原子 RPC                                              | migrations 069~073 / 077~079、`ChatSessionRepository`、`ConversationHistoryRepository`                                                       |
| Prompt 引擎（含平台规则三件套与降级）                                                  | `features/engine/`                                                                                                                           |
| 上下文双水位线泄洪 + Anthropic prompt cache                                            | 077、`features/conversations/context-window.ts`、`prompt-caching.ts`                                                                         |
| 生成与计费出口（含 finish_reason 计费闸门）                                            | `features/generation/` + 081/082                                                                                                             |
| 对话 REST + SSE（含置顶 / 标题 / 分页）                                                | `routes/conversations.ts` + `features/conversations/`                                                                                        |
| 自研聊天 UI（M5：气泡 / markdown / 流式 / 重生成 / 工具箱）                            | `frontend/src/app/chat/` + `components/chat/`                                                                                                |
| 角色回复图片（代码/test migration 已落地，开关默认关，真实验收待完成）                 | `routes/images.ts` + `features/image/` + `features/generation/image-upstream.ts` + 20260914                                                  |
| 语音消息生成（DeepSeek 写稿 + MiniMax TTS）+ 按次计费链路（开关默认关）                | `routes/voice.ts` + `features/voice/` + 080 / 105                                                                                            |
| 裂变邀请（邀请码 / 绑定 / 三条发奖规则 / 运营台明细与海报）                            | `routes/invite.ts` + `lib/invite-rewards.ts` + 105~109 + admin                                                                               |
| 官方社群入群奖励（webhook 自动 + 既有成员手动校验）                                    | `routes/community.ts` + `features/community/` + 108 / 109                                                                                    |
| 大厅推荐排序 v3 + 运营置顶 + 排序参数运营化                                            | 074 / 088 / 093、`features/lobby/`                                                                                                           |
| 支付四路入账 + 快速对账 + `settled_by` 溯源                                            | `features/payment/` + 100/103 + Railway 双任务服务                                                                                           |
| VIP 会员、策略、折扣计费、媒体免费次数与到期提醒（TEST 真机已验收；Production 未开通） | `routes/vip.ts`、`features/vip/`、`features/payment/`、`features/generation/`、Admin `VipStrategyView`、`20260921`–`20260924` VIP migrations |
| Schema 划分一阶段（八域物理布局，test + 生产）                                         | 097~099、`getDomainDb`、Prisma 多 schema                                                                                                     |
| 数据库集成测试                                                                         | `*.integration.test.ts`                                                                                                                      |
| 大厅 / 收藏 / 钱包 / 签到 / 许愿 / 消息中心 / 站内客服                                 | `routes/*` + `frontend/(main)/*`                                                                                                             |
| 运营后台（14 个 managed 配置 / 角色卡 / 公告 / 发布历史 / 回访赠送）                   | `packages/admin` + backend admin 通路                                                                                                        |
| CS 回访工作台（画像簇 / 特殊标记 / 等待状态 / 群发 / 导出）                            | `packages/cs-platform` + 094                                                                                                                 |

### 10.2 待办

| 项                             | 状态 | 说明                                                                                                                                            |
| ------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| VIP Production 发布            | ⏳   | 代码与 TEST 验收已完成。Production migration、购买开关、提醒 Cron 和提醒开关仍关闭，需产品在 T9 明确批准后逐项打开                              |
| Schema 划分批次 D 收口         | ⏳   | 观察期后删空壳 `miniapp` schema；补做需登录态的 7 项应用层验证（交接文档 §一）                                                                  |
| chat_history 列级瘦身          | ⏳   | `history` 列（TOAST ~10 GB）处置方案另立项；A 档 `llm_usage_cache`、B 档观测列待删（历史盘点：`git show b4491cd^:docs/schema划分专项.md` §2.5） |
| 语音按次计费开启               | ⏳   | 链路已随 105 落地，`voice_billing_enabled` 默认关；开启是运营决定，且该 key 尚未纳入 admin managed key，目前只能走迁移改                        |
| `llm_model_tiers` 回退分支删除 | ✅   | R1-B 已删除旧 key、旧契约、端点和双缓存；`model-tiers.ts` 只读 `llm_model_catalog`，故障时退到内置 `DEFAULT_CATALOG`，不是旧 tiers 回退         |
| M4 自建预设格式                | ⏳   | 明确不沿用 ST 格式；旧预设数据已删（088），从零设计                                                                                             |
| 角色卡人设字段进 prompt        | ⏳   | v1 只用 `system_prompt`，待新卡写法定稿后决定                                                                                                   |
| 支付 remediation 遗留          | ⏳   | 补账护栏与审计项见历史文档 `git show 7541a54^:docs/payment-missing-credits-remediation.md`                                                      |
| Railway 控制台遗留清理         | ⏳   | `nginx-pro` / `st-bundle-pro` / `st-data-pro` / `ST_*` 变量 / `pr-276` 环境，人工确认删除                                                       |
| `users.st_handle` 等遗留列     | ⏳   | 代码侧已停止写入、`st-bridge` 已删；剩迁移 111（DROP NOT NULL，**须先于代码上线**）与 112（DROP COLUMN，观察期后）                              |
| `Dockerfile.frontend` 取包层   | ⏳   | 与 backend 同款的构建卡死隐患，仅 `staging-*` 构建受影响                                                                                        |
| `api-contract` 独立包          | ❌   | 不建，职责留在 `shared/api`                                                                                                                     |

---

## 11. 环境变量（backend 主要项）

| 变量                                                                               | 用途                                                                 |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `DATABASE_ENV` + `PROD_*` / `TEST_*` 变量组                                        | 选择环境并注入下面的标准名；非 prod 连生产库需 `ALLOW_PROD_DATABASE` |
| `DATABASE_URL` / `DIRECT_URL`                                                      | Prisma 连接                                                          |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_PROJECT_REF`              | supabase-js 与环境隔离校验                                           |
| `LLM_UPSTREAM_URL` / `LLM_API_KEY`                                                 | LLM 上游（默认 OpenRouter）与平台真实 key，仅 backend 持有           |
| `MINIMAX_API_KEY` / `MINIMAX_TTS_URL` / `MINIMAX_TIMEOUT_MS`                       | 语音合成上游                                                         |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_URL` / `DEEPSEEK_MODEL`                             | 语音台词写稿上游                                                     |
| `LIAOBOTS_AUTH` / `LIAOBOTS_BASE` / `GROK_MODEL`                                   | 图片 Grok/Liaobots 主上游；鉴权仅 backend secret                     |
| `REPLICATE_TOKEN` / `REPLICATE_BASE` / `Z_MODEL`                                   | Grok 失败后的 Replicate Z 图片降级通道                               |
| `IMAGE_GENERATION_TIMEOUT_MS` / `IMAGE_DOWNLOAD_TIMEOUT_MS`                        | 图片 provider 与下载超时                                             |
| `IMAGE_WORKER_ENABLED` / `IMAGE_WORKER_INTERVAL_MS` / `IMAGE_WORKER_LEASE_SECONDS` | 图片数据库任务 worker 与租约控制                                     |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN`                                                | 运行时配置缓存                                                       |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` / `BOT_INTERNAL_SECRET`           | InitData 验签、webhook 与 Bot 内部端点鉴权                           |
| `TELEGRAM_COMMUNITY_BOT_TOKEN`                                                     | 官方社群 Bot：成员校验 `getChatMember` 与 community-webhook 密钥派生 |
| `CS_PLATFORM_URL` / `CS_ADMIN_TOKEN` / `CS_TELEGRAM_WEBHOOK_SECRET`                | CS 平台 CORS / 工作台鉴权 / CS webhook                               |
| `ADMIN_PLATFORM_URL`                                                               | 运营后台 CORS                                                        |
| `FRONTEND_URL`                                                                     | CORS 与支付回跳                                                      |
| `PAYMENT_*`                                                                        | 子千易 V2 RSA 商户配置、支付开关、异步回调与同步回跳地址             |
| `POSTHOG_API_KEY` / `POSTHOG_HOST` / `POSTHOG_TIMEOUT_MS`                          | 服务端支付终态 capture（缺 key 时 no-op）；不是浏览器公开变量        |
| `CHARACTER_STORAGE_BUCKET`                                                         | 角色卡资源 bucket（默认 `character-assets`）                         |
| `DEFAULT_USER_AVATAR_URL`                                                          | 平台默认头像                                                         |
| `CHAT_HISTORY_SYNC_ENABLED`                                                        | OpenRouter 用量回捞定时任务开关                                      |
| `LOBBY_RANKING_REFRESH_ENABLED`                                                    | 大厅推荐排序分每日重算开关                                           |
| `SENTRY_DSN` / `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE`                             | 异常上报（release 缺省回退 `RAILWAY_GIT_COMMIT_SHA`）                |
| `MOCK_AUTH` / `DEV_AUTH_BYPASS` / `LOG_LEVEL` / `LOG_PRETTY`                       | 本地开发与回归脚本旁路                                               |

Vercel 侧关键变量：`NEXT_PUBLIC_API_URL`（用户端 backend 公网域名）。Backend CORS 对应变量由 `packages/backend/src/platform/config.ts` 解析；`ops/env/*.example` 示例文件比实际清单窄，以代码为准。

> ST 时代的 `ST_*` / `LLM_PROXY_TOKEN_SECRET` 等变量应用已不消费；Railway IaC 的 `preserve()` 与生产控制台可能仍留名，属待清理项（§10.2）。

---

## 12. 相关文档

**现行入口（当前 checkout 即可读）：**

| 文档                                   | 内容                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------- |
| 本文件                                 | 架构铁律、包边界、八域、迁移与验证；发布前运维见 `docs/重构实施方案.md` R4 |
| `docs/重构实施方案.md`                 | 2026-09 降复杂度重构进度（不是第二套架构权威）                             |
| `packages/shared/migrations/README.md` | 迁移执行通道、命名、账本（操作备忘）                                       |

各包 `CLAUDE.md` 已删除，后端/前端硬规则以本文铁律为准；后续模块上下文放到 spec，不要再在各包下恢复一份。

> **历史文档不在工作区。** 专项文档分两批清过：`b4491cd`（ST_remove / context-window / schema 划分计划）、`7541a54`（含 schema 归属地图等其余 14 份）。取回：`git show b4491cd^:docs/<文件名>` 或 `git show 7541a54^:docs/<文件名>`。下列条目只供追溯，**不是现行权威**。

| 历史文档                                                     | 当时内容                             | 取回                                                            |
| ------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------- |
| `docs/ST_remove.md`                                          | ST 替换总方案                        | `git show b4491cd^:docs/ST_remove.md`                           |
| `docs/schema归属地图.md`                                     | 八域归属原稿（豁免已收回本文铁律 8） | `git show 7541a54^:docs/schema归属地图.md`                      |
| `docs/schema划分专项.md`                                     | miniapp 表盘点                       | `git show b4491cd^:docs/schema划分专项.md`                      |
| `docs/schema划分-一阶段执行计划.md`                          | 099 批次与回滚纪律                   | `git show b4491cd^:docs/schema划分-一阶段执行计划.md`           |
| `docs/schema划分-批次A进度交接.md`                           | A/B/C0~C3 执行记录                   | `git show 7541a54^:docs/schema划分-批次A进度交接.md`            |
| `docs/context-window-and-prompt-cache.md`                    | 双水位线与 prompt cache              | `git show b4491cd^:docs/context-window-and-prompt-cache.md`     |
| `docs/payment-missing-credits-remediation.md`                | 支付四路入账复盘                     | `git show 7541a54^:docs/payment-missing-credits-remediation.md` |
| `docs/st_handle退场方案.md`                                  | st_handle 退场步骤                   | `git show 7541a54^:docs/st_handle退场方案.md`                   |
| `packages/backend/CLAUDE.md` / `packages/frontend/CLAUDE.md` | 已删除的包级 AI 规则                 | git 历史                                                        |
