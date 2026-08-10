# 自研引擎替换 ST：MVP 对话链路实施方案

> 状态：**批次 0 已交付**（2026-08-10）。三份接缝见 §四；读到旧 bot 代码后 §二决策 7 已再次修正，§六 M2 随之重写。
> 上游文档：`docs/ST_remove.md`（总体方案与 12 项决策）
> 目标：**先跑通 MVP 对话路径**。不在 MVP 关键路径上的模块一律后置。
>
> 本文自带调研结论与执行细节，可直接作为新会话的交接输入。
> ⚠️ 不要参考 `docs/ARCHITECTURE.md` 的数据层描述——该文档停留在 migration 030，实际已到 068，严重滞后。

---

## 一、MVP 定义与验收

**MVP = 一条端到端可验证的自研对话链路**：

```
建会话（落开场白）→ 发消息 → 读会话历史 → 组装 prompt → 调上游 LLM
→ SSE 流式回传 → 落库（chat_messages + chat_history）→ 计费
→ 重生成（最后一轮）
```

MVP 完成的判据：不经过 ST、不经过 iframe、不经过 bridge，用 HTTP 客户端（curl / 集成测试）就能跑完上面全流程，且计费与 `chat_history` 落库结果与 ST 链路口径一致。

**MVP 不包含**：自研聊天 UI（M5）、灰度切换（M6）、预设载体改造（M4）、用户配置编辑界面、埋点对齐、压测。

---

## 二、本轮已确认的决策（2026-08-10）

| #   | 事项                                           | 结论                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 原则 1 措辞                                    | 改为"**不改变 ST 链路的运行时行为**"。采用方案 A：把生成执行与计费出口从 `llm-proxy` handler 抽成服务（行为零变化），新引擎复用同一服务                                                                                                                                            |
| 2   | `chat_history.assistant_message_id`            | **不加**。只加 `session_id`                                                                                                                                                                                                                                                        |
| 3   | 开场白 `first_mes`                             | 入库，但**不设专用标记字段**。就是 turn 0 的一条普通 assistant 消息，天然作为上下文的一部分参与 prompt 组装与 `chat_history.history` 序列化                                                                                                                                        |
| 4   | 会话删除                                       | **软删**（`deleted_at`）                                                                                                                                                                                                                                                           |
| 5   | 重生成范围                                     | **只允许对最后一轮操作**                                                                                                                                                                                                                                                           |
| 6   | `pref_word_count` / `pref_custom_instructions` | M2 设计时纳入 prompt 组装；M1 只负责把读取通道建好                                                                                                                                                                                                                                 |
| 7   | 预设格式（二次修正决策 3）                     | **MVP 不消费预设，后续自建格式**。读码后确认旧 bot 没有任何一处读预设，`preset_payload` 是只有 ST PromptManager 能消费的酒馆格式。平台规则改由 `runtime_config` 的模板承载（见 §六）；自建格式明确不沿用 ST，定稿后一次性适配 payload 与消费方，故无返工                           |
| 8   | 旧 bot 参照物                                  | **已获取**，移植源三处见 §六                                                                                                                                                                                                                                                       |
| 9   | M2 路线（2026-08-10 追加）                     | 三选一中取"忠实移植 bot"：丢弃 `preset_payload`，system 段只用角色卡 `system_prompt`，不传采样参数。两处看似的代价都已被排除——预设体系将自建新格式后一次性适配，miniapp 现有的 ST 生态角色卡将下架，因此 `description` / `personality` / `scenario` 不进 prompt 不构成人设丢失风险 |
| 10  | 上下文长度管理                                 | **MVP 不做**。bot 侧已有一套"水位线泄洪式"机制，后续需在 miniapp 复现；不是从零设计，不进 MVP 只是排期取舍                                                                                                                                                                         |
| 11  | prompt 缓存                                    | bot 给 Anthropic Claude 注入的 `cache_control` 断点**要进 MVP**，但归 M3a 的 request body 层，且以开关控制：ST 链路传 `false` 保住 M3a"行为零变化"的回归判据，自研链路传 `true`                                                                                                    |

---

## 三、调研结论（新会话必读的现状事实）

以下均为对 `packages/` 的实测，不是文档转述。

### 3.1 用户配置层已存在，但从未被消费

`miniapp.miniapp_user_settings` 已有全部字段：

| 字段                       | 类型 / 默认                                                            | 现状                                                                    |
| -------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `selected_model_id`        | TEXT                                                                   | ✅ 已接线，`llm-proxy` 每次生成前以它为权威覆盖 `body.model`            |
| `pref_word_count`          | TEXT，默认 `'300-500'`，取值 `'100-300'\|'300-500'\|'500-800'\|'800+'` | ⚠️ 有表、有 shared 契约、有 PATCH 接口，**无 UI、无任何 prompt 侧消费** |
| `pref_show_options`        | BOOLEAN，默认 `true`                                                   | ⚠️ 同上                                                                 |
| `pref_custom_instructions` | TEXT                                                                   | ⚠️ 同上                                                                 |

全仓库检索确认这三个 pref 字段只出现在 migration 015 / `shared/src/api/settings.ts` / `MiniappUserSettingsRepository` / `prisma/schema.prisma` 四处。

**结论**：M1 不需要为用户配置新增任何列，只需建读取通道。

### 3.2 生成与计费全部内联在 `llm-proxy` 单 handler 内

`packages/backend/src/routes/llm-proxy.ts` 是约 660 行的单个 `app.all()` handler，顺序内联：

1. `requirePlatformToken` — platformToken JWT 验签 → `userId`（或 simulation 的 `conversationId`）
2. 权威模型解析 — 读 `selected_model_id` → `fetchModelCatalogSnapshot()` → 覆盖 `body.model`
3. 免费额度预留 — `freeQuotas.reserve()` → `resolveEffectiveModelMarkup()`
4. 定档扣费额 — `resolveFixedDeduction()`
5. 余额预检 — 不足返回 **402**（`InsufficientBalanceErrorResponse`）
6. 转发上游（OpenRouter）+ `Transform` SSE tap：累积 `replyChunks`、抓 `generation_id`、判 `data: [DONE]`
7. 终态 — `finalizeFreeQuota(streamCompleted)` + `saveChatHistory()`（内部再做 `charge_llm_usage` 实扣与 OpenRouter generation 元数据回捞）

这些能力**没有一个是可复用函数**，全是 handler 局部变量与闭包。这就是 M3a 存在的原因。

### 3.3 预设与模型目录现状

- 预设表 `st_platform.platform_presets`：`id / display_name / preset_payload(JSONB) / is_default / sort_order / enabled`
- 预设按**模型 stable id** 绑定：`st_platform.platform_preset_model_assignments(model_id PK, preset_id)`
- 运行时解析 RPC：`st_platform.resolve_effective_preset_for_model(p_model_id, p_include_payload)`，返回 `effective_preset_id / preset_payload / preset_source('model'|'default') / config_code / degraded`，永不阻断生成
- 模型目录**不是表**，是 `miniapp.runtime_config` 里 key = `llm_model_catalog` 的 JSONB 文档；`packages/backend/src/platform/model-tiers.ts` 负责读取与回退
- 存在一个方案文档未提及的包 **`packages/admin`**（Vite + React + AntD + Refine 的运营后台，端口 3003），预设池 / 版本历史 / 模型目录分配 / payload 分析面板均已建成

**结论**（按决策 7 二次修正）：以上预设通路在 MVP 阶段只服务 ST 链路——新引擎不读 `preset_payload`，也不调 `resolve_effective_preset_for_model`。表与 admin 管理通路保留，等自建预设格式定稿后再整体适配（见 §九 M4）。MVP 需要的是 `miniapp.runtime_config` 里新增的平台规则模板三件套，同样不需要 schema 改动。

### 3.4 计费链路要点

- 定档扣费（`billing_mode: 'fixed_tier'`），配置在 `runtime_config.llm_pricing_config` 的 `fixedDeduction.{freeQuotaExhausted,light,standard,premium}`
- 免费额度按 **用户 × 角色** 计轮，上限来自 `runtime_config.miniapp_character_free_chat_quota_limit`（默认 40），走 `reserve` / `finalize` 两阶段
- 实扣走 RPC `miniapp.charge_llm_usage`，幂等键是 `charge_id`
- 关键模块：`features/billing/usage-pricing.ts`、`features/billing/free-quota.ts`、`platform/model-tiers.ts`、`MiniappWalletRepository`、`MiniappCharacterFreeQuotaRepository`

### 3.5 其他实测点

- 前端路由是 `/tavern/[characterId]`，参数名不是 `id`
- `packages/frontend/src/lib/api/client.ts` 已有 `apiStreamClient()`（SSE `data:` 解析），**当前零调用方**，M5 可直接用
- `showdown` + `dompurify` 已在前端 `package.json`，**当前零 import**
- 侧边栏会话列表用 Zustand（`stores/chat-list.ts`）而非 React Query，是前端唯一例外
- 迁移编号有历史冲突（021 / 030 / 031 / 032 / 053 / 065 各出现两次），**当前最大为 068**
- `packages/shared/migrations/README.md` 索引只列到 063，已滞后
- `chat_history.user_id` 在 migration 026 中 FK 到 `public.users(id)`，而身份已于 028 迁至 `miniapp.users`——**M1 建表前必须实测确认当前 FK 的实际指向**，新表跟随实际情况

---

## 四、批次安排

### 依赖图

```
批次 0  三个接缝类型定义（✅ 已交付）
          │
          ├──────────────┬──────────────┐
          ▼              ▼              ▼
批次 1   M1 数据模型    M2 引擎核心    M3a 生成出口服务化
        （无依赖）  （需 runtime_config  （纯重构 llm-proxy）
                      平台规则正文）
          └──────────────┴──────────────┘
                         ▼
批次 2              M3b 对话 REST + SSE   ← ★ MVP 达成
                         ▼
批次 3              M5 自研聊天 UI
                         ▼
批次 4              M6 切换与账号链路

后置：M4 自建预设格式与适配、上下文长度管理（水位线泄洪）、用户配置 UI、埋点对齐、压测定容
```

### 批次 0：接缝先行（已交付，2026-08-10）

批次 1 三个模块要并行，前提是先把它们之间的接缝钉死。产出是纯类型，无运行时代码、无 DB 改动，合并后生产行为不变。

| 文件                                                | 内容                                                                                                                                                                                                                                 | 归属     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `packages/shared/src/api/conversations.ts`          | 对外 REST 契约：`ChatSession` / `ChatMessage` / `UserGenerationConfig` / `ConversationErrorCode` / 各请求响应 DTO / SSE 事件契约。已在 `shared/src/index.ts` 注册导出。**backend CLAUDE.md 硬规则 4：先定义在 shared，再写 handler** | M3b 消费 |
| `packages/backend/src/features/engine/types.ts`     | 引擎接缝：`EngineInput` / `EngineOutput` / `PromptEngine`。后端内部类型，不进 shared                                                                                                                                                 | M2 拥有  |
| `packages/backend/src/features/generation/types.ts` | 生成出口接缝：`ResolvedModel` / `GenerationRequest` / `GenerationHooks` / `GenerationResult` / `GenerationService`                                                                                                                   | M3a 拥有 |

**相对初稿的偏离**（以文件为准，此处只记原因）：

| 偏离                                                                                                     | 原因                                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `EngineInput` 去掉 `presetPayload`，加 `instructions`（`runtime_config` 的模板 + 选项模式块 + 字数档位） | 决策 7 二次修正，引擎不消费预设                                                                                           |
| `EngineInput` 加独立的 `userInput`，`history` 约定不含本轮输入                                           | 对齐 bot：平台规则包装的是当前用户输入；重生成路径也要把历史尾部的 user 消息摘出来单独传，混在 `history` 里两条路径会打架 |
| `EngineInput.history` 已含开场白，引擎**不得**注入 `first_mes`                                           | bot 因开场白不入库才动态注入，本方案决策 3 是入库成 turn 0，前提相反，照搬会每轮重复一条                                  |
| `EngineOutput.sampling` / `truncatedTurns` 保留但 v1 恒为空 / 恒为 0                                     | bot 请求体只有 `model / messages / stream`，也无截断逻辑。留字段是为了后续接入时不必改 M3a 入参                           |
| `GenerationRequest` 加 `model: ResolvedModel`                                                            | 模型解析前置成独立函数。自研链路两处各解析一次会漂移                                                                      |
| `GenerationRequest` 加 `promptCaching: boolean`                                                          | `cache_control` 对 ST 链路是行为变更，用开关隔离，保住 M3a 的纯重构判据（决策 11）                                        |
| `GenerationResult.status` 加 `insufficient_balance`，`chargeId` 改可空，加 `balance`                     | 402 预检与上游失败共用一条返回通道，调用方一处 switch 收口                                                                |
| shared 新增 `ConversationStreamEvent` / `ConversationErrorCode`                                          | 初稿未定义 SSE 事件负载，不定会让 M5 现编一套。402 / 409 在首字节写出前判定，仍走 HTTP 状态码而非 stream 事件             |

### 批次 1：M1 / M2 / M3a 并行

三者互不依赖，接缝已定、依赖已齐，可分给三条线同时做，各自独立 PR。详见 §五 / §六 / §七。

文件面几乎不相交——M1 落在两个新 migration 加两个新 repository，M2 落在全新的 `features/engine/` 加 `runtime_config` 建 key，M3a 落在 `routes/llm-proxy.ts` 加新建的 `features/generation/`。只有三个共同触点，按下面的归属约定执行即可避免互相踩：

| 触点                              | 归属约定                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MiniappUserSettingsRepository`   | 只有 M1 改（新增 `getGenerationConfig`）。M3a 的 `resolveModel` 读 `selected_model_id` 时只调现有方法，不动这个文件 |
| `runtime_config` 读取             | M2 复用既有读法（`platform/model-tiers.ts` 读 `llm_model_catalog` 的那套），不另起一套并行实现                      |
| 上下文切片（谁去掉尾部本轮 user） | M1 的 `getContextMessages` 只返回有序全量（重生成也要用这个原始形态）；切片归 M3b，在调 `build()` 前做              |

> 并行的瓶颈会转移到 review：三个 PR 同时到位，其中 M3a 需要对着 §7.3 的回归清单逐项验。建议 M3a 优先启动——它纪律最严（只搬不改、diff 要逐行可对照原 handler），也是三者中唯一直接威胁 ST 线上链路的。

### 批次 2：M3b 集成，MVP 达成

详见 §八。

---

## 五、M1 — 对话数据模型与会话管理

### 5.1 设计取舍

| 决策点                 | 结论                                                       | 理由                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| schema 归属            | `miniapp.*`                                                | 与 `chat_history` / `characters` / `miniapp_user_settings` 同域；`st_*` 三个 schema 是 ST 同步层，替换后要归档                                          |
| 访问层                 | supabase-js Repository                                     | 与最近的 `MiniappUserSettingsRepository` / `MiniappWalletRepository` / `MiniappCharacterFreeQuotaRepository` 一致。迁移后可选跑 `prisma db pull` 补类型 |
| system prompt 是否入库 | **不入库**                                                 | 只存 user / assistant。system 段每次生成现场组装，预设更新后历史会话自动跟随，无需回填                                                                  |
| 开场白                 | turn 0 的普通 assistant 消息，**无特殊标记**（本轮决策 3） | 天然作为上下文一部分；不可重生成由"最后一轮必须含 user 消息"的规则自然保证                                                                              |
| 会话标题               | `title` 可空                                               | 空 = 前端按首条用户消息截断显示；重命名后写实值。把今天侧边栏靠正则猜"是否自动名"的逻辑换成显式字段                                                     |

### 5.2 迁移：`069_miniapp_chat_sessions.sql`

> 执行前确认 069 未被占用（当前最大 068）。

```sql
-- ─── 会话表 ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS miniapp.chat_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES miniapp.users(id) ON DELETE CASCADE,
  character_id         UUID NOT NULL REFERENCES miniapp.characters(id) ON DELETE RESTRICT,

  -- NULL = 未重命名，前端按首条用户消息生成显示名
  title                TEXT,

  -- 侧边栏列表用的冗余字段，避免每次聚合 messages
  last_message_at      TIMESTAMPTZ,
  last_message_preview TEXT,
  message_count        INTEGER NOT NULL DEFAULT 0,

  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_recent
  ON miniapp.chat_sessions(user_id, last_message_at DESC NULLS LAST)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_character_recent
  ON miniapp.chat_sessions(user_id, character_id, last_message_at DESC NULLS LAST)
  WHERE deleted_at IS NULL;

GRANT ALL ON miniapp.chat_sessions TO service_role, postgres;

COMMENT ON TABLE miniapp.chat_sessions IS
  '自研引擎对话会话。用户 × 角色可多会话（决策 9）。运行时真相，替代 ST 文件系统 chats/。';
```

```sql
-- ─── 消息表 ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS miniapp.chat_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID NOT NULL REFERENCES miniapp.chat_sessions(id) ON DELETE CASCADE,

  -- 一问一答共用同一个 turn_index；开场白独占 turn_index=0 且该轮无 user 行
  turn_index          INTEGER NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('user', 'assistant')),

  -- 重生成版本：assistant 行从 0 递增；user 行恒为 0
  revision            INTEGER NOT NULL DEFAULT 0,
  -- 每个 (session, turn, role) 恰有一行 is_active = true
  is_active           BOOLEAN NOT NULL DEFAULT true,

  content             TEXT NOT NULL DEFAULT '',

  status              TEXT NOT NULL DEFAULT 'complete'
                      CHECK (status IN ('streaming', 'complete', 'interrupted', 'failed')),
  error_code          TEXT,
  finish_reason       TEXT,

  -- ─── 生成配置快照（决策 10）：仅 assistant 行填充 ───────────────────
  model_id            TEXT,    -- 目录 stable id
  model_openrouter_id TEXT,    -- 实际路由到的上游模型
  preset_id           UUID,    -- st_platform.platform_presets.id
  gen_config          JSONB,   -- UserGenerationConfig 快照

  charge_id           UUID,    -- miniapp.llm_usage_charges.charge_id
  generation_id       TEXT,    -- OpenRouter generation id

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一轮同一角色只能有一个生效版本
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_messages_active_turn
  ON miniapp.chat_messages(session_id, turn_index, role)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_turn
  ON miniapp.chat_messages(session_id, turn_index, role)
  WHERE is_active;

GRANT ALL ON miniapp.chat_messages TO service_role, postgres;

COMMENT ON TABLE miniapp.chat_messages IS
  '自研引擎对话消息。system 段不入库，每次生成由角色卡+预设+用户配置现场组装。'
  '重生成保留历史版本（revision 递增），仅 is_active 行参与展示与上下文。';
```

```sql
-- ─── chat_history 升维（决策 2）───────────────────────────────────────
ALTER TABLE miniapp.chat_history
  ADD COLUMN IF NOT EXISTS session_id UUID
    REFERENCES miniapp.chat_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_chat_history_session
  ON miniapp.chat_history(session_id, created_at DESC)
  WHERE session_id IS NOT NULL;

COMMENT ON COLUMN miniapp.chat_history.session_id IS
  '自研引擎会话 id。存量行（ST 链路产生）为 NULL，切换后新写入必填。';
```

> **不动 `user_character_round` 触发器**：语义保持"用户 × 角色累计轮次"、跨会话累加。`cs_platform.user_metrics` 视图与首页推荐排序（migration 060）都依赖它，改成 per-session 会破坏线上。

### 5.3 迁移：`070_chat_session_rpc.sql`

需要原子性的两个操作做成 RPC，避免应用层两步写产生违反唯一索引的中间态：

| RPC                                                              | 作用                                                                                                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `miniapp.append_chat_turn(p_session_id, p_user_content)`         | 计算下一个 `turn_index`、插入 user 消息、更新会话冗余字段（`last_message_at` / `last_message_preview` / `message_count`），返回 `turn_index` 与 message id |
| `miniapp.start_message_regeneration(p_session_id, p_turn_index)` | 校验该轮是最后一轮且含 user 消息 → 把当前 active assistant 置 `is_active=false` → 插入 `revision+1` 的新 assistant 行（`status='streaming'`），全程单事务  |

### 5.4 重生成语义（版本留存、只展示最新）

```
turn_index=3, role=user      revision=0  is_active=true   "然后呢？"
turn_index=3, role=assistant revision=0  is_active=false  "（第一次生成）"
turn_index=3, role=assistant revision=1  is_active=false  "（第二次生成）"
turn_index=3, role=assistant revision=2  is_active=true   "（当前展示）"
```

- 展示与上下文一律 `WHERE is_active`，旧版本对用户和模型都不可见
- **只允许对最后一轮重生成**（本轮决策 5）：`turn_index = max(turn_index)` 且该轮存在 user 消息。后者顺带保证了开场白不可重生成
- 旧版本保留用于审计与质量回溯

### 5.5 上下文读取

```sql
SELECT role, content
  FROM miniapp.chat_messages
 WHERE session_id = $1 AND is_active
 ORDER BY turn_index ASC,
          CASE role WHEN 'user' THEN 0 ELSE 1 END ASC;
```

M1 只保证顺序稳定可读，返回**有序全量**：不做截断（MVP 无上下文长度管理，见决策 10），也不切掉尾部本轮 user 消息——后者由 M3b 在调 `build()` 前处理，因为 `EngineInput` 把本轮输入拆成了独立的 `userInput` 字段。重生成路径同样依赖这份原始形态。

### 5.6 流式落库与断线语义

- 生成开始：插入 assistant 行，`status='streaming'`，`content=''`
- 流结束：一次性 UPDATE 完整 `content` + `status='complete'` + `finish_reason` + `generation_id` + `charge_id`
- 流中断：写入已累积的 partial content + `status='interrupted'`（对齐 `llm-proxy` 现有的 `stream_interrupted` 语义）
- **客户端断开不终止上游**：SSE tap 继续跑到 `[DONE]` 并落库，用户切后台/断网回来能看到完整回复。这是相对 ST 的净改进
- 并发保护：同一 session 若存在 `status='streaming'` 且 `updated_at` 在 120s 内的 assistant 行，新发送请求返回 **409**；超时则先标 `interrupted` 再放行

### 5.7 产出清单

| 文件                                                                        | 内容                                                                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/migrations/069_miniapp_chat_sessions.sql`                  | §5.2 全部 DDL                                                                                                                         |
| `packages/shared/migrations/070_chat_session_rpc.sql`                       | §5.3 两个 RPC                                                                                                                         |
| `packages/shared/src/api/conversations.ts`                                  | 批次 0 起草，M1 落实类型                                                                                                              |
| `packages/backend/src/infrastructure/repositories/ChatSessionRepository.ts` | `createSession`（含开场白播种）/ `listSessions` / `getSession`（带 ownership 校验）/ `rename` / `softDelete` / `touchLastMessage`     |
| `packages/backend/src/infrastructure/repositories/ChatMessageRepository.ts` | `appendUserTurn` / `startAssistantMessage` / `finalizeAssistantMessage` / `listMessages` / `getContextMessages` / `startRegeneration` |
| `MiniappUserSettingsRepository.ts`（改）                                    | 新增 `getGenerationConfig(userId)` → `UserGenerationConfig`                                                                           |
| `packages/shared/migrations/README.md`（改）                                | 补 064~070 索引，修 §3.5 的滞后                                                                                                       |

### 5.8 验收（集成测试，M1 不出 HTTP 接口）

1. 建会话 → 自动落一条 turn 0 的 assistant 开场白（内容 = `characters.first_mes`），`message_count = 1`
2. 追加 user + assistant 各一条 → `turn_index` 正确递增，会话三个冗余字段同步更新
3. 对最后一轮重生成 3 次 → 该轮有 4 条 assistant 行（rev 0~3），`is_active` 恰好一条
4. 对非最后一轮发起重生成 → 被拒
5. 只有开场白的会话发起重生成 → 被拒（该轮无 user 消息）
6. 上下文查询顺序稳定：开场白在最前，其后 user/assistant 严格交替
7. 并发重生成同一轮 → 唯一索引拦截，无双 active
8. 跨用户访问他人 session → repository 层 ownership 校验拒绝
9. 软删会话后不出现在列表，`chat_history` 关联行仍可查

---

## 六、M2 — Prompt 引擎核心

### 6.1 性质

**这是一次移植，不是重新设计。** 移植源共三处（路径相对 bot 仓库根）：

| 文件                                                                   | 提供什么                                                                                      |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/infrastructure/ai/SimplePromptEngine.ts` 的 `_buildMessages()`    | messages 组装骨架，全文约 30 行                                                               |
| `src/features/chat/usecases/SimpleChat.ts` 的 `_buildEnhancedPrompt()` | 平台规则包装用户输入的格式：`##系统指令：以下为最高优先级指令。\n{指令}\n##用户指令:{输入}\n` |
| `src/features/chat/rules/renderSystemInstructions.ts`                  | 三个占位符的渲染与字数档位查找，已是纯函数，可近乎照抄                                        |

bot 的最终形状是：

```
[system: 角色卡 system_prompt] + [assistant: 开场白] + 历史 + [user: 平台规则 + 本轮输入]
```

据此产生三条与初稿不同的事实：**bot 不读预设**（决策 7 二次修正）、**bot 的上下文长度管理是另一套机制**（水位线泄洪，不在 `_buildMessages` 里，MVP 不复现，见决策 10）、**bot 只用角色卡的 `system_prompt` 一个字段**——`description` / `personality` / `scenario` / `mes_example` / `post_history_instructions` 全部未使用。

> 第三条不构成质量风险：miniapp 现有的 ST 生态角色卡将下架，新卡的人设写法跟随新引擎的取数方式。接缝仍保留完整字段组，日后要把人设并入 system 段只需改引擎实现，不影响 M1 / M3b。

### 6.2 输入来源映射

| `EngineInput` 字段    | 来源                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `character.*`         | `miniapp.characters`（Prisma model `Character`）。v1 只消费 `system_prompt`，其余字段照常取出备用                                                       |
| `history`             | M1 的 `getContextMessages(sessionId)`，由 **M3b** 去掉尾部本轮 user 消息后传入。开场白作为 turn 0 的 assistant 消息包含在内，引擎不得再注入 `first_mes` |
| `userInput`           | 本轮用户输入原文（重生成时为该轮已存在的 user 消息内容）                                                                                                |
| `userConfig`          | `MiniappUserSettingsRepository.getGenerationConfig(userId)`                                                                                             |
| `persona.displayName` | `miniapp_user_settings.display_name`                                                                                                                    |
| `instructions`        | `miniapp.runtime_config` 新增的三个 key：平台规则模板 / 选项模式块 / 字数档位                                                                           |

### 6.3 任务清单

1. 在 `miniapp.runtime_config` 建平台规则模板三件套。正文取自 bot 侧生产库 `wbtsfzozlmurljvglhpn` 的 `public.runtime_config` 表，key 为 `system_instructions` / `interaction_mode_blocks` / `pref_word_count_tiers`
2. 字数档位的 label 按 miniapp 的 `PreferredWordCount` 枚举（`100-300` / `300-500` / `500-800` / `800+`）重写——bot 侧文案是 `150以内` / `800以上`，直接沿用会匹配失败并静默回落到默认档
3. 移植为 `packages/backend/src/features/engine/` 下的纯函数模块（无 IO、无 DB、可单测）
4. 实现 `PromptEngine.build(input): EngineOutput`
5. 接入用户配置（本轮决策 6）：`pref_word_count` → `{{WORD_COUNT}}`；`pref_show_options` → `{{INTERACTION_MODE}}` 二选一；`pref_custom_instructions` → `{{USER_CUSTOM_INSTRUCTIONS}}`，空值注入"暂无"

### 6.4 验收

- 纯函数单测：给定固定的角色卡 + 历史 + 用户输入 + 用户配置 + 模板，`build()` 输出的 messages 数组稳定可断言
- **对拍**：同一组输入下，新引擎输出的 messages 与旧 bot 的 `trace.finalContext` 逐条比对一致（M2 最重要的验收项）
- 三个 `pref_*` 字段的不同取值确实改变输出；`pref_word_count` 取 miniapp 枚举的每个值都能命中档位、不回落
- 历史里的开场白只出现一次（回归"引擎重复注入 `first_mes`"这个坑）

---

## 七、M3a — 生成执行与计费出口服务化

### 7.1 性质与纪律

**纯重构，行为零变化。** 把 §3.2 列出的第 3~7 步从 `llm-proxy` handler 里搬进 `packages/backend/src/features/generation/`，`llm-proxy` 改为调用它。

铁律：

- 只搬不改。任何"顺手优化"都不允许在这个 PR 里做
- diff 必须逐行可对照到原 handler
- ST 链路的生产表现是唯一回归判据
- 独立 PR，不与 M1 / M2 混

### 7.2 抽出边界

**抽出**（新引擎与 ST 链路共用）：

| 能力                          | 原位置                                         | 目标                                                                       |
| ----------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| 权威模型解析                  | handler 第 234~278 行                          | `features/generation/resolve-model.ts`                                     |
| 免费额度预留 / 终结           | `freeQuotas.reserve()` / `finalizeFreeQuota()` | `features/generation/quota.ts`                                             |
| 定档扣费额 + 余额预检（402）  | `resolveFixedDeduction()` + 钱包检查           | `features/generation/precheck.ts`                                          |
| 上游转发 + SSE tap + 终态回调 | handler 第 529~761 行                          | `features/generation/execute.ts`                                           |
| chat_history 落库 + 实扣      | `saveChatHistory()`                            | 已是独立模块，`features/generation` 只负责调用；新增可选 `session_id` 入参 |

**不抽出**（ST 链路专有，留在 `llm-proxy`）：

- `requirePlatformToken` JWT 验签
- `X-ST-Character-Id` / `X-ST-Preset-Id` / `X-ST-User-Input` / `X-ST-Preset-Config-Warning` 等 header 解析
- simulation 模式的全部分支（决策 8：simulation 不属于本方案范围）
- OpenAI 兼容的请求/响应透传外壳

### 7.3 验收

1. `llm-proxy` 重构后，ST 链路端到端行为不变：正常生成、余额不足 402（含 `statusMessage = 'MiniApp Insufficient Credits'`）、上游 5xx 不扣费、流中断不扣费、免费额度耗尽
2. `chat_history` 落库字段与重构前逐字段一致
3. `charge_llm_usage` 的 `charge_id` 幂等行为不变
4. simulation 链路不受影响
5. 新增的 `session_id` 入参在 ST 链路调用时为 `null`，落库为 NULL

---

## 八、M3b — 对话 REST + SSE（MVP 收口）

依赖 M1 + M2 + M3a 全部就绪。

### 8.1 接口清单

契约先定义在 `packages/shared/src/api/conversations.ts`（backend CLAUDE.md 硬规则 4），每条路由上方必须写 `@frontend-ready` 注释（硬规则 1）。

| 方法 / 路径                                 | 职责                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /api/v1/conversations`                | 建会话（入参 `character_id`），落开场白，返回 session + 首条消息                                     |
| `GET /api/v1/conversations`                 | 会话列表（跨角色，支持 `character_id` 过滤 + 分页），直读 DB，替代 `GET /api/users/chats` 的 ST 反代 |
| `GET /api/v1/conversations/:id`             | 会话详情 + 消息分页                                                                                  |
| `PATCH /api/v1/conversations/:id`           | 重命名                                                                                               |
| `DELETE /api/v1/conversations/:id`          | 软删                                                                                                 |
| `POST /api/v1/conversations/:id/messages`   | **发消息 + SSE 流式回复**（核心）                                                                    |
| `POST /api/v1/conversations/:id/regenerate` | 重生成最后一轮，同样 SSE                                                                             |
| `GET /api/v1/generation-config` · `PATCH`   | 用户生成配置读写（复用 `miniapp_user_settings` 既有字段）                                            |

鉴权统一用现有的 `requireTelegramAuth`（`X-Init-Data` header）。

### 8.2 发消息的执行序列

```
1. requireTelegramAuth → userId
2. 校验 session 归属 + 无进行中的 streaming（否则 409）
3. RPC append_chat_turn → 落 user 消息，拿 turn_index
4. resolveModel(userId) → ResolvedModel（先于组装，避免两处各解析一次）
5. 读取：会话历史（M1，去掉尾部本轮 user）+ 角色卡 + 用户配置 + runtime_config 平台规则
6. M2 build() → messages + sampling
7. M1 startAssistantMessage(status='streaming') + 写入配置快照
8. M3a execute(request, hooks)：内部先做预检（免费额度 / 余额）
   - 预检不过 → 直接以 status='insufficient_balance' 收口，M3b 返回 HTTP 402 JSON
   - 预检通过 → 转发上游，首个 hook 回调时 M3b 才写 SSE 响应头，先发 start 事件（带 message id / turn_index / revision），再发 delta
9. SSE 边转发给客户端边累积
10. 终态：M1 finalizeAssistantMessage + M3a 的 chat_history 落库与实扣（带 session_id）
```

> 顺序的关键约束：**SSE 首字节写出之前不能有任何可能失败的判定**。402 与 409 都要以 HTTP 状态码返回 JSON，一旦响应头发出去就只能降级成 stream 的 error 事件，前端处理成本高一截。所以 M3b 推迟到 execute 的首个回调才写响应头。

### 8.3 MVP 验收

用 curl / 集成测试完成全流程，不经过 ST、iframe、bridge：

1. 建会话 → 返回开场白
2. 发消息 → 收到 SSE 流式 token → 流结束后 `chat_messages` 有完整 assistant 行、`chat_history` 有一行且 `session_id` 非空
3. 扣费金额与 ST 链路同口径（对同一模型档位比对 `llm_usage_charges`）
4. 免费额度用户前 N 轮不扣费，第 N+1 轮起按 `deduct_markup` 扣
5. 余额不足返回 402
6. 重生成最后一轮 → 新 revision 生效，旧版本保留
7. 中途断开客户端 → 后端仍跑完并落库完整内容
8. 会话列表直读 DB，不产生任何对 ST 的请求

---

## 九、后置事项（明确不在 MVP 路径）

| 事项                    | 说明                                                                                                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M4 自建预设格式与适配   | 明确不沿用 ST 预设格式。格式定稿后一次性改到位：payload 载体 + 引擎侧消费 + admin 管理通路。**注意**：改造时有三个耦合点会打挂线上 ST——`idx_platform_presets_one_default` 是全表唯一、`trg_preset_auto_promote` 会写 ST 专用的 `platform_settings`、`platform_preset_model_assignments` 主键是 `model_id` 单列 |
| 上下文长度管理          | 复现 bot 的"水位线泄洪式"机制（决策 10）。MVP 不做，长会话会持续增长 prompt 并推高成本，切换前需要落地                                                                                                                                                                                                         |
| 角色卡人设字段进 prompt | v1 只用 `system_prompt`。ST 生态卡下架后按新卡的写法决定是否把 `description` / `personality` / `scenario` 并入 system 段                                                                                                                                                                                       |
| 用户生成配置 UI         | 三个 `pref_*` 字段至今无编辑界面，随 M5 一起做                                                                                                                                                                                                                                                                 |
| 埋点对齐                | 新链路复用现有"点卡 → 呈现"耗时口径                                                                                                                                                                                                                                                                            |
| 压测定容                | 全量切换无灰度爬坡，切换前必须完成（阶段二）                                                                                                                                                                                                                                                                   |
| `ARCHITECTURE.md` 更新  | 已滞后 38 个 migration，建议在 M6 之后整体重写                                                                                                                                                                                                                                                                 |

---

## 十、执行注意事项

1. **shared 先行**：任何对外数据形状先定义在 `packages/shared/`，再写 handler（backend CLAUDE.md 硬规则 4）
2. **`@frontend-ready` 注释**：每条新路由注册上方必须有，半成品写 `false — <带业务含义的原因>`（硬规则 1、2）
3. **禁止 `any`**，TypeScript 严格模式
4. **迁移执行**：不会随部署自动跑。手动触发 GitHub Actions 的 `Database Migration` workflow，逐个指定 `packages/shared/migrations/*.sql`；生产需在 `confirm_production` 填 `RUN_PRODUCTION_MIGRATION`
5. **迁移编号**：当前最大 068，本方案占用 069 / 070。历史上有重号，落盘前再确认一次
6. **M3a 单独 PR**，PR 描述里附 ST 链路回归验证清单。`promptCaching` 在 ST 链路必须传 `false`，否则破坏"行为零变化"判据
7. 三个批次 1 模块各自独立 PR，互不阻塞 review
