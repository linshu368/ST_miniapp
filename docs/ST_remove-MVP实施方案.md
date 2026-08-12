# 自研引擎替换 ST：MVP 对话链路实施方案

> 状态：**MVP 达成**（2026-08-11）。批次 0、批次 1（M1 / M2 / M3a）、批次 2（M3b）全部交付并验收通过。
> §8.3 的八条 MVP 判据由 `mvp:regression` 全绿覆盖，一条不经过 ST / iframe / bridge 的对话链路已经跑通（§8.4）。
> §7.3 的 ST 回归改为本地脚本 + 重构前后对拍，两侧各 7/7 通过、逐字段 diff 一致（§7.3.3）。
> **下一步是 M5（自研聊天 UI）与 M6（灰度切换）；切换前必须先在生产库按序执行 069 / 070 / 071 / 072 / 073，见 §8.7。**
> M5 已拆出独立的模块交接文档：**`docs/ST_remove-M5-自研聊天UI.md`**（2026-08-12），说明目的、实现原则、依赖到位情况与现有代码状态。
> 三份接缝见 §四；读到旧 bot 代码后 §二决策 7 已再次修正，§六 M2 随之重写。
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
→ SSE 流式回传 → chat_history 轮次收口 → 计费
→ 重生成（最后一轮）
```

MVP 完成的判据：不经过 ST、不经过 iframe、不经过 bridge，用 HTTP 客户端（curl / 集成测试）就能跑完上面全流程，且计费与 `chat_history` 落库结果与 ST 链路口径一致。

> **2026-08-11：判据已达成。** `pnpm --filter @miniapp/backend mvp:regression -- --seed-free-model` 八个场景全绿，其中 `billing_parity` 直接把自研链路与 ST 链路的 `llm_usage_charges` 逐字段对拍。详见 §8.4。

**MVP 不包含**：自研聊天 UI（M5）、灰度切换（M6）、预设载体改造（M4）、用户配置编辑界面、埋点对齐、压测。

---

## 二、本轮已确认的决策（2026-08-10）

| #   | 事项                                           | 结论                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 原则 1 措辞                                    | 改为"**不改变 ST 链路的运行时行为**"。采用方案 A：把生成执行与计费出口从 `llm-proxy` handler 抽成服务（行为零变化），新引擎复用同一服务                                                                                                                                            |
| 2   | `chat_history.assistant_message_id`            | **不加**。只加 `session_id`                                                                                                                                                                                                                                                        |
| 3   | 开场白 `first_mes`（2026-08-11 修正）          | **不单独落行**。新会话由 API 返回虚拟 turn 0；首轮用户发言时进入 `chat_history.history` 完整 prompt 快照，后续从快照恢复                                                                                                                                                           |
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
- `packages/frontend/src/lib/api/client.ts` 已有 `apiStreamClient()`（SSE `data:` 解析），**当前零调用方**。~~M5 可直接用~~ **此结论已作废（2026-08-12）**：它按 OpenAI 风格解析 `{ content }` 分片、认 `[DONE]`、回调累积全文，而 M3b 下发的是 `ConversationStreamEvent`（`delta.text` 为增量、终态是 `done` 事件），且它对非 2xx 只抛状态码、丢掉 402 的特殊响应体。M5 须另写一个增量事件客户端，顺带删掉这个死函数
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
        （✅ 已交付）   （✅ 已交付）    （✅ 已交付，§7.3 回归已过）
          └──────────────┴──────────────┘
                         ▼
批次 2              M3b 对话 REST + SSE   ← ★ MVP 达成
                    （✅ 已交付，§8.3 八条判据全绿）
                         ▼
批次 3              M5 自研聊天 UI   ← 当前位置
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
| `EngineInput.history` 已含开场白，引擎**不得**再次注入 `first_mes`                                       | M3b 首轮使用角色卡值，后续从首轮 `chat_history.history` 快照恢复；引擎再注入会每轮重复一条                                |
| `EngineOutput.sampling` / `truncatedTurns` 保留但 v1 恒为空 / 恒为 0                                     | bot 请求体只有 `model / messages / stream`，也无截断逻辑。留字段是为了后续接入时不必改 M3a 入参                           |
| `GenerationRequest` 加 `model: ResolvedModel`                                                            | 模型解析前置成独立函数。自研链路两处各解析一次会漂移                                                                      |
| `GenerationRequest` 加 `promptCaching: boolean`                                                          | `cache_control` 对 ST 链路是行为变更，用开关隔离，保住 M3a 的纯重构判据（决策 11）                                        |
| `GenerationResult.status` 加 `insufficient_balance`，`chargeId` 改可空，加 `balance`                     | 402 预检与上游失败共用一条返回通道，调用方一处 switch 收口                                                                |
| shared 新增 `ConversationStreamEvent` / `ConversationErrorCode`                                          | 初稿未定义 SSE 事件负载，不定会让 M5 现编一套。402 / 409 在首字节写出前判定，仍走 HTTP 状态码而非 stream 事件             |

### 批次 1：M1 / M2 / M3a 并行（✅ 代码已交付，2026-08-10）

三者互不依赖，接缝已定、依赖已齐，可分给三条线同时做。详见 §五 / §六 / §七。

> **实际执行偏离**：三个模块最终由同一条线连续做完，合成**一个 PR** 提交，没有按 §十.6 / §十.7 拆成三个。
> 代价是 M3a 不再能独立回滚——若 §7.3 的 ST 回归发现问题，revert 会连带撤掉 M1 / M2。
> 缓解办法是提交按模块分开（M1 / M2 / M3a 各自成 commit），必要时可单独 revert commit 而不是整个 PR。
> 事后看这个代价没有兑现：§7.3 的对拍未发现任何差异（§7.3.3）。

文件面几乎不相交——M1 落在两个新 migration 加两个新 repository，M2 落在全新的 `features/engine/` 加 `runtime_config` 建 key，M3a 落在 `routes/llm-proxy.ts` 加新建的 `features/generation/`。只有三个共同触点，按下面的归属约定执行即可避免互相踩：

| 触点                              | 归属约定                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MiniappUserSettingsRepository`   | 只有 M1 改（新增 `getGenerationConfig`）。M3a 的 `resolveModel` 读 `selected_model_id` 时只调现有方法，不动这个文件 |
| `runtime_config` 读取             | M2 复用既有读法（`platform/model-tiers.ts` 读 `llm_model_catalog` 的那套），不另起一套并行实现                      |
| 上下文切片（谁去掉尾部本轮 user） | M1 的 `getContextMessages` 只返回有序全量（重生成也要用这个原始形态）；切片归 M3b，在调 `build()` 前做              |

> 第二条最终的落法是把 `model-tiers.ts` 里的两个私有读取函数提取到新建的 `platform/runtime-config.ts`，两边共用（见 §6.5）。约定的意图（不长出第二套读法）达成，但代价是 M2 改到了 `model-tiers.ts` 这个原本没列进触点表的文件。

> 并行的瓶颈会转移到 review：三个模块同时到位，其中 M3a 需要对着 §7.3 的回归清单逐项验。M3a 纪律最严（只搬不改、diff 要逐行可对照原 handler），也是三者中唯一直接威胁 ST 线上链路的。

### 批次 1 验收现状（2026-08-10 代码，2026-08-11 回归）

**已清零的部分**：

| 项                                    | 结果                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @miniapp/backend test` | 批次 1 当时 153 用例全绿；最终模型调整后为 **173/173**（含 8 条打真库会话集成测试）                                      |
| `pnpm typecheck`                      | 全 workspace 干净                                                                                                        |
| M1 §5.8 的九条                        | 全部由 `conversations.integration.test.ts` 覆盖并通过                                                                    |
| M2 §6.4 的对拍                        | 已落在 `prompt-engine.test.ts`：把 bot 的 `_buildMessages` / `_buildEnhancedPrompt` 逐字抄进测试当基准，多组输入逐条比对 |
| 069 / 070 / 071 / 072 / 073           | 已在 **test 库**执行；072 收口事实源，073 提供每轮最大 revision 的高效读取视图                                           |
| **§7.3 的 ST 回归**                   | 改为本地回归脚本 + 重构前后对拍（2026-08-11）：两侧各 **7/7 通过、逐字段 diff 完全一致**，见 §7.3.2 / §7.3.3             |

**尚未清零的部分**：

| 欠项                                     | 说明                                                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 402 `statusMessage` 的真机确认           | 本地只验到后端写进了状态行；HTTP/2 无 reason phrase，每一跳都可能抹掉。**不阻塞 M3b**：写法与重构前逐字相同，合到 `dev` 后点一次即可（§7.3.4） |
| simulation 链路的端到端确认              | 跑在独立 project 且连生产库，本地无法覆盖。**不阻塞 M3b**：`llm-proxy` 的 simulation 分支一行未动（§7.3.4）                                    |
| 069 / 070 / 071 / 072 / 073 在生产库执行 | 迁移不随部署自动跑（§十.4）。生产尚未执行；M6 前必须按序执行，072 会删除中间模型 `chat_messages`                                               |

> 为什么这道关卡在 M3b 之前：`llm-proxy.ts` 这次改了 415 行、净减 202 行，是批次 1 里唯一碰生产链路的改动。
> M3b 会直接调 `GenerationService`，等它长出来之后才发现 M3a 有行为偏差，修的时候两边都得动。
> 现在对拍已给出"行为零变化"的机器判据，这个理由不再成立，**M3b 可以开工**。

### 批次 2：M3b 集成，MVP 达成（✅ 已交付并验收通过，2026-08-11）

八条路由 + M1/M2/M3a 编排落地，§8.3 的八条判据由 `mvp:regression` 全绿覆盖。详见 §八。

---

## 五、M1 — 对话数据模型与会话管理

> 状态：**已交付**（2026-08-10）。产出与偏离见 §5.7 / §5.9，验收结果见 §四「批次 1 验收现状」。

### 5.1 设计取舍

| 决策点                 | 结论                     | 理由                                                                                                                                                    |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| schema 归属            | `miniapp.*`              | 与 `chat_history` / `characters` / `miniapp_user_settings` 同域；`st_*` 三个 schema 是 ST 同步层，替换后要归档                                          |
| 访问层                 | supabase-js Repository   | 与最近的 `MiniappUserSettingsRepository` / `MiniappWalletRepository` / `MiniappCharacterFreeQuotaRepository` 一致。迁移后可选跑 `prisma db pull` 补类型 |
| system prompt 是否入库 | **只存每轮 prompt 快照** | `chat_history.history` 保存本次实际发送的完整 messages；下一轮 system 段仍按最新角色卡与平台规则现场组装                                                |
| 开场白                 | **不单独落行**           | 新会话由 API 返回虚拟 turn 0；首轮生成后只存在于 `chat_history.history`，以后从该快照恢复                                                               |
| 会话标题               | `title` 可空             | 空 = 前端按首条用户消息截断显示；重命名后写实值。把今天侧边栏靠正则猜"是否自动名"的逻辑换成显式字段                                                     |

### 5.2 最终数据模型（072 收口）

069 / 070 最初引入了 `chat_messages`。M3b 验收后重新对齐职责：会话只需要两张基础表，
`chat_messages` 与已有 `chat_history` 重复，因此由 072 回填后删除。

```text
chat_sessions  1 ─── N  chat_history
```

- `chat_sessions`：一行一个用户创建的独立会话，保存用户、角色、标题、摘要、计数与软删除状态。
- `chat_history`：一行表示某个 session 内一个逻辑 turn 的一个生成 revision；同时是上下文、计费和审计的唯一事实来源。
- ST 链路继续写 `session_id = NULL` 的调用日志，`turn_index` / `revision` 同样为 NULL，行为不变。

072 只给现有 `chat_history` 补两个字段：

| 字段         | 业务含义                                                                               |
| ------------ | -------------------------------------------------------------------------------------- |
| `turn_index` | session 内由用户主动发起的逻辑轮次，从 1 递增；重生成不增加                            |
| `revision`   | 同一 `session_id + turn_index` 的生成版本，首次为 0，每次重生成 +1；最大值就是当前版本 |

唯一索引是 `(session_id, turn_index, revision)`；两个字段保持 nullable 以兼容 ST 存量和新增日志。

### 5.3 原子 RPC

| RPC                               | 作用                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `start_chat_history_turn`         | 锁 session、清理陈旧 streaming、分配 `max(turn_index)+1`，直接插入 revision 0 的 `chat_history` |
| `start_chat_history_regeneration` | 锁 session、校验最后一轮、复用 `user_input`，插入 `max(revision)+1` 的 `chat_history`           |
| `guard_chat_session_idle`         | 存在 120 秒内的 `status='streaming'` 行时抛 `55006`；陈旧行先收口为 `stream_interrupted` 再放行 |

两个 start RPC 都以 `chat_sessions FOR UPDATE` 为串行点，编号计算与插入在同一事务中完成。

### 5.4 重生成语义

```text
session=S, turn_index=3, revision=0  "第一次生成"
session=S, turn_index=3, revision=1  "第二次生成"
session=S, turn_index=3, revision=2  "当前版本"
```

- 当前版本是同一 turn 的 `max(revision)`，不需要 `is_active`。
- 只允许重生成 `max(turn_index)`。
- 旧 revision 保留用于审计、质量回溯和计费对账。

### 5.5 上下文与开场白

每轮先按 turn 取最大 revision，再按 `turn_index` 升序展开 `user_input` / `assistant_reply`。
开场白不单独落行：新会话由 API 返回虚拟 turn 0；首轮生成时写入完整 `history` prompt 快照，
后续从首轮快照中恢复。用户首次发送前角色卡若变化，显示当前 `first_mes`；首次发送后以快照为准。

### 5.6 流式落库与异步补全

- 调上游前同步插入 `chat_history(status='streaming')`，稳定 id、用户输入和轮次立即落库。
- prompt 组装完成后更新该行的 `history` 完整快照。
- 流结束同步更新 `assistant_reply` 与终态；客户端断开仍继续 drain 上游并收口。
- `saveChatHistory()` 在自研链路不再 INSERT 重复行，而是按预建 history id 异步补齐扣费和 OpenRouter 元数据；ST 链路仍按原行为 INSERT。
- PostgreSQL 当前既是持久化层也是跨请求事实来源；未来 Redis 只承接锁、streaming 状态与热点上下文缓存，不替代数据库唯一约束。

### 5.7 产出清单

| 文件                                                          | 内容                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `072_chat_history_conversation_source.sql`                    | 补 turn/revision、回填旧 M3b 数据、建立新 RPC/索引/统计触发器、删除 `chat_messages` |
| `073_current_chat_history_view.sql`                           | 数据库侧固化每轮最大 revision，分页不把全部旧版本拉回应用层                         |
| `ConversationHistoryRepository.ts`                            | start/finalize、重生成、最大 revision 查询、上下文恢复、API user/assistant 投影     |
| `ChatSessionRepository.ts`                                    | 建会话只写 session，开场白作为虚拟消息返回                                          |
| `generation/types.ts`、`execute.ts`、`chat-history-logger.ts` | 自研链路携带预建 history id，日志器更新原行；ST 链路保持新增日志                    |
| `conversations.integration.test.ts`                           | 8 条真库测试覆盖建会话、轮次、重生成、上下文、并发、ownership、软删除和配置读取     |

### 5.8 验收

1. 建会话不写 `chat_history`，但 API 返回虚拟开场白，`message_count = 0`。
2. 用户发言后 `turn_index` 从 1 递增，session 摘要与消息计数同步。
3. 重生成三次保留 revision 0~3，最大 revision 为当前版本。
4. 非最后一轮与空会话不可重生成。
5. 上下文只取每轮最大 revision，并从首轮 prompt 快照恢复开场白。
6. 并发重生成只放行一条 streaming revision。
7. ownership、软删除及历史留存语义不变。
8. ST 与自研计费对拍保持一致。

2026-08-11 实测：后端 **173/173** 测试通过（含真库集成测试），`mvp:regression -- --seed-free-model`
八个场景全绿。

---

## 六、M2 — Prompt 引擎核心

> 状态：**已交付**（2026-08-10）。产出与偏离见 §6.5 / §6.6，验收结果见 §四「批次 1 验收现状」。

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

| `EngineInput` 字段    | 来源                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `character.*`         | `miniapp.characters`（Prisma model `Character`）。v1 只消费 `system_prompt`，其余字段照常取出备用                          |
| `history`             | `chat_history` 每轮最大 revision 展开的既往对话；开场白首轮取角色卡、之后取首轮 prompt 快照。本轮 userInput 不混入 history |
| `userInput`           | 本轮用户输入原文（重生成时为该轮已存在的 user 消息内容）                                                                   |
| `userConfig`          | `MiniappUserSettingsRepository.getGenerationConfig(userId)`                                                                |
| `persona.displayName` | `miniapp_user_settings.display_name`                                                                                       |
| `instructions`        | `miniapp.runtime_config` 新增的三个 key：平台规则模板 / 选项模式块 / 字数档位                                              |

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

四条已全部覆盖并通过（§四「批次 1 验收现状」）。对拍的做法是把 bot 的 `_buildMessages` / `_buildEnhancedPrompt` 逐字抄进 `prompt-engine.test.ts` 当基准函数，多组输入下与 `buildPrompt()` 的输出逐条比对。

### 6.5 产出清单

| 文件                                                              | 内容                                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/migrations/071_engine_platform_instructions.sql` | 平台规则三件套落 `miniapp.runtime_config`。正文取自 bot 生产库 `system_instructions` version 41                      |
| `packages/backend/src/platform/runtime-config.ts`                 | `runtime_config` 的统一读取入口：`fetchRuntimeConfigEntry` / `fetchRuntimeConfigValue` / `fetchRuntimeConfigEntries` |
| `features/engine/platform-instructions.ts`                        | 三件套的读取、校验、按 version 判活的缓存、三级兜底与 `degraded` 标记。**本模块唯一有 IO 的文件**                    |
| `features/engine/render-instructions.ts`                          | 三个占位符渲染 + 字数档位查找 + `wrapUserInput`（逐字保持 bot 的包装格式）。纯函数                                   |
| `features/engine/prompt-engine.ts`                                | `buildPrompt(input): EngineOutput`，实现 `PromptEngine` 接缝。纯函数                                                 |
| `features/engine/index.ts`                                        | 模块出口                                                                                                             |
| `platform/model-tiers.ts`（改）                                   | 两个私有读取函数移入 `platform/runtime-config.ts`，改为引用，净减 46 行。行为不变                                    |
| 三个测试文件                                                      | 25 个用例：渲染与档位查找、三件套解析与降级、`buildPrompt` 组装、与 bot 的对拍                                       |

### 6.6 相对方案的偏离

| 偏离                                                                        | 原因                                                                                                                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §6.3 只说「建三件套」没给编号，实际落成 migration `071`                     | 三个 key 是运行时依赖，得跟着迁移走才能在各环境复现；顺手把 069 / 070 / 071 一起补进 README 索引                                                           |
| `runtime_config` 读取提取到 `platform/runtime-config.ts` 共用               | 触点约定要求「不另起一套并行实现」。`model-tiers.ts` 的两个私有函数只读 `value`，M2 还要 `text_value`，扩字段而不是复制一份，代价是改到了 `model-tiers.ts` |
| 三件套加 `degraded` 标记与内置兜底模板                                      | key 缺失或格式损坏时既不能中断生成，也不能悄悄降级。兜底刻意写得很短，靠 `degraded` 与日志把问题顶出来，M3b 可据此打点告警                                 |
| 加 `findUncoveredWordCounts` + `satisfies Record<PreferredWordCount, true>` | 档位表漏配某个枚举值会静默回落到默认档——用户改了设置看不到变化且不报错。`satisfies` 让枚举增减在编译期就报错，运行时再补一条覆盖检查                       |
| 三个 key 全读不到时先扛过 5 分钟 TTL 再换兜底                               | 一次网络抖动不应该让全站 prompt 立刻降级                                                                                                                   |
| `EngineInput.persona` v1 未消费                                             | 模板里没有对应占位符，bot 也没有 persona 概念。接缝字段保留，日后加占位符时不必改 M1 / M3b                                                                 |

---

## 七、M3a — 生成执行与计费出口服务化

> 状态：**已交付并验收通过**（代码 2026-08-10，回归 2026-08-11）。产出与偏离见 §7.4 / §7.5，回归判据与对拍结论见 §7.3，脚本发现的既有问题见 §7.6。

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

原计划是"部署到 staging 对着真实 ST iframe 手验"。实际改成了本地回归脚本，理由与结论见下三节。

#### 7.3.1 为什么不去 staging

**没有 staging 环境。** Railway 只有 `development`（跟 `dev` 分支）和 `production`（跟 `main`），两者都不是可以随意造脏数据的地方。

更关键的是这五条要的是**可控的失败**：上游 5xx 和流中断没法对着真实 OpenRouter 按需触发，只能靠运气或临时改代码，而它们恰恰是最容易出事的两条。

ST 对 `llm-proxy` 而言只是个 HTTP 客户端，它发的东西全部可复现——HMAC 自签的 platformToken、四个 `X-ST-*` header、一个 OpenAI 兼容 body，handler 里没有任何一处需要 iframe 真的存在。所以本地起真实 Fastify app 配假上游，比部署上去验得更全。

#### 7.3.2 本地回归脚本

`packages/backend/src/scripts/st-regression/`：

```
pnpm --filter @miniapp/backend st:regression -- --seed-free-model
```

在随机端口起真实的 Fastify app，`LLM_UPSTREAM_URL` 指向假上游，用自签 token 打 `/api/platform/llm-proxy/v1/chat/completions`，再查 test 库断言落库与计费。七个场景：

| 场景                    | 判据                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| `success_paid`          | 200 透传、收到 `[DONE]`、落库 `success`、按定档扣费、`session_id` 为 NULL   |
| `insufficient_balance`  | 402 + `statusMessage`、`error.type`、**上游收到 0 个请求**、不落库不扣费    |
| `upstream_error`        | 502 透传、落库 `upstream_error` + `upstream_status = 502`、不扣费、余额不变 |
| `stream_interrupted`    | 干净收尾但无 `[DONE]`：落库 `stream_interrupted` 且保留半截正文、不扣费     |
| `stream_aborted`        | 上游销毁 socket 时的既有行为，见 §7.6                                       |
| `free_quota_exhaustion` | 最后一轮免费扣 0（charge 状态 `free`），下一轮按 `deduct_markup` 计费       |
| `idempotent_charge`     | 同一 `charge_id` 二次提交返回 `already_charged`，明细只一条、余额不再变     |

`--seed-free-model` 会临时往共享的 `llm_model_catalog` 插一个 `markup = 0` 的模型再还原：test 库现在五个模型倍率都是 1~4，免费额度那条判据否则永远跑不到。它动的是别人也在读的配置，因此默认不开。

#### 7.3.3 对拍结论

断言只能证明重构后的行为符合**我对旧行为的理解**——理解错了照样全绿。真正的判据是拿旧代码的实际输出当基准：

```
git checkout ca0b226        # 批次 1 之前
pnpm --filter @miniapp/backend st:regression -- --seed-free-model --snapshot /tmp/before.json
git checkout dev_ST_remove
pnpm --filter @miniapp/backend st:regression -- --seed-free-model --snapshot /tmp/after.json
pnpm --filter @miniapp/backend st:regression:diff -- /tmp/before.json /tmp/after.json
```

脚本是未跟踪文件，切 commit 时原样留在工作区，所以同一份场景定义能直接压到旧代码上跑（它刻意不 import 任何 M1/M2 才有的模块）。快照里已剔除 id 与时间戳。

> **2026-08-11 实测：两侧各 7/7 通过，逐字段 diff 完全一致。**
> 第 2 条（`chat_history` 落库字段逐字段一致）由此从"人眼比对"变成机器判据。

#### 7.3.4 本地验不到的部分

| 欠项                            | 为什么                                                                                                    | 怎么补                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 第 4 条 simulation 链路         | 跑在独立 Railway project 且连生产库，test 库的 `miniapp_simulation.conversations` 无数据                  | 保障来自「`llm-proxy` 的 simulation 分支一行未动」，看 diff 即可 |
| 402 的 `statusMessage` 能否送达 | 本地只验到后端把 reason phrase 写进了状态行；HTTP/2 没有 reason phrase，Vercel / nginx 每一跳都可能抹掉它 | 合到 `dev` 后在真机点一次余额不足                                |

两条都不是 M3a 引入的风险：simulation 分支未改，`statusMessage` 的写法与重构前逐字相同。

### 7.4 产出清单

| 文件                                                 | 内容                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `features/generation/resolve-model.ts`               | `resolveAuthoritativeModel`（ST 链路用，搬自 handler 第 234~278 行）/ `resolveModelForUser`（自研链路用，补齐档位与倍率，返回 `ResolvedModel`）              |
| `features/generation/quota.ts`                       | `reserveCharacterFreeQuota` / `noFreeQuotaReservation`。预留、生效倍率换算与 finalize 收进 `FreeQuotaReservation` 一个对象                                   |
| `features/generation/precheck.ts`                    | `resolveBillingPlan`（定档扣费额 + 计费快照）/ `checkWalletBalance`（402 判定，不构造响应）                                                                  |
| `features/generation/upstream.ts`                    | `forwardToUpstream` / `resolveUpstreamUrl` / `createSseTap`。tap 逐字节透传，终态在 flush 里跑完才放行                                                       |
| `features/generation/prompt-caching.ts`              | 决策 11 的 `cache_control` 注入，纯函数                                                                                                                      |
| `features/generation/execute.ts`                     | `GenerationService` 实现，串起上面四段，供 M3b 直调                                                                                                          |
| `features/generation/index.ts`                       | 模块出口                                                                                                                                                     |
| `lib/chat-history-logger.ts`（改）                   | `ChatHistoryEntry` 加可选 `session_id`                                                                                                                       |
| `routes/llm-proxy.ts`（改）                          | 改为调用上述服务，净减约 190 行；ST 专有部分（验签 / X-ST-\* / simulation / 透传外壳）原样保留                                                               |
| `upstream.test.ts` `execute.test.ts` 等 5 个测试文件 | 33 个用例：SSE 切包还原、[DONE] 判据、计费快照字段、402 前不碰上游、缓存断点位置                                                                             |
| `scripts/st-regression/`（5 个文件）                 | §7.3 的本地回归脚本：假上游、数据播种/清理、模拟 ST 的 HTTP 客户端、七个场景断言、快照对拍工具。挂在 `st:regression` / `st:regression:diff` 两条 pnpm 脚本上 |

### 7.5 相对方案的偏离

| 偏离                                                                              | 原因                                                                                                                             |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| §7.2 的 `execute.ts` 拆成 `upstream.ts`（传输原语）+ `execute.ts`（自研链路服务） | 两条链路消费方式不同：ST 要把 tap 挂在 pipe 上透传，自研要自己 drain 后重编码。共用的是原语，不是整条 execute                    |
| 模型解析对外是两个函数而不是一个                                                  | 让 ST 链路只做原来那三步。合成一个就会在 handler 早期多打一次 `runtime_config`，而计费段稍后本来就要再取一次                     |
| `saveChatHistory` 只在 `session_id` 非空时才把该列写进 insert                     | migration 069 尚未在生产执行。显式传 `null` 会让 ST 链路每一条 chat_history 落库都失败，条件写入的落库结果同为 NULL，判据不变    |
| SSE tap 顺带记录 `finish_reason`                                                  | 自研链路收口 `chat_history.llm_finish_reason` 需要它。只进 tap 返回值，不改转发内容，对 ST 无可观测差异                          |
| tap 增加 `snapshot()`                                                             | 流被上游打断时 `flush` 不触发，自研链路要靠它补终态，否则预留的免费轮会一直挂着。ST 链路不调用，保持原有（不补终态）行为         |
| 缓存断点打在**历史最后一条**而不是最后一条消息                                    | 最后一条是「平台规则 + 本轮输入」的包装体，下一轮它会以未包装的原文回到历史里，断点打上去必然 miss；退一位才是两轮逐字相同的前缀 |
| 免费额度预留失败时 `execute()` 直接抛出，而不是返回 `GenerationResult`            | 与 ST 链路同判据（原 handler 返回 500）。上游侧失败才走 `status` 收口                                                            |

### 7.6 回归脚本发现的既有问题（非 M3a 引入）

上游**销毁 socket**（而不是干净收尾）时，ST 链路的表现是：

- `upstreamNodeStream.pipe(sseTap)` 没在源流上挂 error 监听器，undici 抛的错变成未捕获的 `'error'` 事件，能打死整个进程
- `pipe` 出错时不会 `end` 目标流，下游那条响应**一直挂着不结束**
- tap 的 `flush` 因此不触发，这一轮既不落 `chat_history`，也不 finalize 免费额度预留（预留的那一轮会挂着，直到被后续请求的 stale 清理捡走）

`git show ca0b226:packages/backend/src/routes/llm-proxy.ts` 可确认这段在 M3a 前后逐字节相同，**不是重构引入的，因此不阻塞 M3b**。脚本把它固化成 `stream_aborted` 场景，不判失败，只把「1 条未捕获异常 + 响应不结束 + 0 条落库」记进快照，将来它变了对拍会发现。

自研链路不受影响：`execute.ts` 用的是 `pipeline()` + `try/catch` + `tap.snapshot()`（§7.5），断链时会补齐终态。ST 链路要不要一起修是独立议题，不建议塞进 M3b——那会破坏 M3a"只搬不改"的边界，且需要单独的回归。

---

## 八、M3b — 对话 REST + SSE（MVP 收口）

> 状态：**已交付并验收通过**（2026-08-11）。§8.3 的八条判据由本地回归脚本全绿覆盖（§8.4），产出与偏离见 §8.5 / §8.6，上线前的欠项见 §8.7。

依赖 M1 + M2 + M3a 全部就绪。**开工前置已全部清零**（2026-08-11）：代码依赖齐备，§7.3 的 ST 回归已由本地脚本 + 重构前后对拍完成，逐字段 diff 一致。剩余两项（402 `statusMessage` 真机确认、simulation 端到端）不阻塞，理由见 §7.3.4。

M3b 也是三个模块第一次在同一个进程里串起来，下面这几处接缝到今天为止还没有任何测试碰过，验收时要盯——三处均已落地并有测试覆盖，落点见括号：

- `getContextMessages` 返回有序全量 → M3b 切掉尾部本轮 user → `EngineInput.history` + `userInput`。切片只有约定，实现和测试都在 M3b（`features/conversations/history.ts` + 同名单测；口径改动见 §8.6）
- `getGenerationConfig` 同时喂给 M2 的 `userConfig` 与 M3a 的 `resolveModelForUser`，两处对 `selected_model_id` 为 null 的处理要一致（两者读同一列，一致性由构造保证，见 §8.6）
- M3a 的 `GenerationResult` → 收口预建的 `chat_history` revision + 异步补齐计费元数据（`send_message` 场景逐字段断言）

### 8.1 接口清单

契约先定义在 `packages/shared/src/api/conversations.ts`（backend CLAUDE.md 硬规则 4），每条路由上方必须写 `@frontend-ready` 注释（硬规则 1）。

| 方法 / 路径                                 | 职责                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /api/v1/conversations`                | 建会话（入参 `character_id`），返回 session + 虚拟开场白，不写 `chat_history`                        |
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
3. 并行读取模型、角色卡、用户配置、昵称与平台规则
4. RPC start_chat_history_turn → 原子分配 turn_index，插入 status='streaming' 的 revision 0
5. 从 chat_history 读取当前 turn 之前各轮的最大 revision；首轮使用角色卡开场白，之后从首轮 history 快照恢复
6. M2 build() → messages + sampling，并把完整 prompt 更新到本轮 history
7. M3a execute(request, hooks)：内部先做预检（免费额度 / 余额）
   - 预检不过 → 直接以 status='insufficient_balance' 收口，M3b 返回 HTTP 402 JSON
   - 预检通过 → 转发上游，首个 hook 回调时 M3b 才写 SSE 响应头，先发 start 事件（带 message id / turn_index / revision），再发 delta
8. SSE 边转发给客户端边累积
9. 终态：同步更新同一条 chat_history 的正文/状态；M3a 异步补齐实扣与 OpenRouter 元数据
```

> 顺序的关键约束：**SSE 首字节写出之前不能有任何可能失败的判定**。402 与 409 都要以 HTTP 状态码返回 JSON，一旦响应头发出去就只能降级成 stream 的 error 事件，前端处理成本高一截。所以 M3b 推迟到 execute 的首个回调才写响应头。

### 8.3 MVP 验收

用 curl / 集成测试完成全流程，不经过 ST、iframe、bridge：

1. 建会话 → 返回开场白
2. 发消息 → 收到 SSE 流式 token → 流结束后 `chat_history` 的该 revision 有完整 prompt、用户输入、assistant 回复且 `session_id` 非空
3. 扣费金额与 ST 链路同口径（对同一模型档位比对 `llm_usage_charges`）
4. 免费额度用户前 N 轮不扣费，第 N+1 轮起按 `deduct_markup` 扣
5. 余额不足返回 402
6. 重生成最后一轮 → 新 revision 生效，旧版本保留
7. 中途断开客户端 → 后端仍跑完并落库完整内容
8. 会话列表直读 DB，不产生任何对 ST 的请求

### 8.4 验收结果（2026-08-11）

与 §7.3 同样的理由（没有 staging、要的是**可控的失败**），八条判据落成本地回归脚本
`packages/backend/src/scripts/mvp-regression/`：

```
pnpm --filter @miniapp/backend mvp:regression -- --seed-free-model
```

在随机端口起真实的 Fastify app，`LLM_UPSTREAM_URL` 指向假上游（复用 §7.3.2 的那一个），
用 `MOCK_AUTH=1` 的 initData 打 `/api/v1/conversations` 那一组路由，再查 test 库断言会话、
消息、`chat_history` 与扣费。**全程不经过 ST、iframe、bridge，这正是 §8.3 的判据本身。**

| 场景                   | 覆盖判据 | 主要断言                                                                                                                                          |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_session`       | 1、8     | 建会话返回虚拟 turn 0 开场白但 `chat_history` 为 0 行；列表 / 详情直读 DB；**全程上游 0 请求**                                                    |
| `send_message`         | 2        | SSE `start`→`delta`→`done`；上游 messages 与 M2 组装一致；同一条 `chat_history` 从 streaming 收口并补齐计费元数据                                 |
| `billing_parity`       | 3        | 同一模型档位下，自研链路与 ST 链路（自签 token 直打 `llm-proxy`）的 `llm_usage_charges` 逐字段一致                                                |
| `free_quota`           | 4        | 免费额度最后一轮 charge 状态 `free`、扣 0；下一轮按 `deduct_markup` 计费                                                                          |
| `insufficient_balance` | 5        | 402 + JSON（`content-type` 不是 `text/event-stream`）、0 个 SSE 事件、**402 前上游 0 请求**、assistant 行收口成 `failed`、充值后重发不被 409 卡住 |
| `regenerate`           | 6        | 新 revision 生效、旧 revision 保留、最大 revision 为当前版本、详情只出最新、重生成 prompt 不重复本轮输入                                          |
| `client_disconnect`    | 7        | 客户端收到第一片就 abort，后端仍跑完上游并收口 `chat_history` 完整正文、照常扣费                                                                  |
| `conflict_guards`      | —        | `session_busy` / `regenerate_not_allowed` 的 409 与 `session_not_found` 的 404 都在写出 SSE 首字节之前判定                                        |

> **实测：8/8 通过。** 不带 `--seed-free-model` 时 `free_quota` 跳过（test 库五个模型倍率都是 1~4，判据跑不到），其余 7 条全绿。

最新实测 `pnpm --filter @miniapp/backend test` 为 **173/173 全绿**，包含 8 条打真库的最终数据模型集成测试。

`conflict_guards` 的会话忙用**直接往库里插一条 `streaming` 行**来触发，而不是靠慢上游卡时序：
`guard_chat_session_idle` 的判据就是"存在 120 秒内的 streaming 行"，直接造这个状态比赛跑稳定得多。

#### 8.4.1 本地验不到的部分

| 欠项                                 | 为什么                                                                 | 怎么补                                       |
| ------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------- |
| 真实上游的流式时序                   | 假上游按固定 chunk 切包，真实 OpenRouter 的分片节奏、首 token 延迟不同 | M5 接上前端后在 `development` 环境点几轮     |
| 中间层对 SSE 的缓冲                  | 本地直连，Vercel / Railway 的代理是否会攒包看不出来                    | 已按惯例下发 `X-Accel-Buffering: no`，真机验 |
| 069 / 070 / 071 / 072 / 073 在生产库 | 迁移不随部署自动跑（§十.4）                                            | M6 切换前按顺序执行，见 §8.7                 |

### 8.5 产出清单

| 文件                                                                | 内容                                                                                                                                               |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/src/api/conversations.ts`（改）                             | 收口 `PatchGenerationConfigRequest`（去掉 `selected_model_id`，见 §8.6）；补齐 `start` 事件的下发时机语义                                          |
| `infrastructure/repositories/CharacterCardRepository.ts`            | 角色卡引擎字段组的读取通道。不过滤 `enabled` / `archived_at`：卡下架也要能把已有会话聊完                                                           |
| `MiniappUserSettingsRepository.ts`（改）                            | 加 `getDisplayName`，喂 `EngineInput.persona`。与 `getGenerationConfig` 分开是因为 `display_name` 属用户资料，塞进生成配置会污染 `gen_config` 快照 |
| `features/generation/types.ts` `execute.ts`（改）                   | 加 `onStreamOpen` hook：上游 2xx、即将消费响应体时恰好一次。这是"不会再以 HTTP 状态码失败"的分界点，M3b 据此决定何时写 SSE 响应头（§8.6）          |
| `features/conversations/history.ts`                                 | `buildEngineHistory`：开场白置顶 + 过滤既往空回复；本轮 userInput 不混进 history                                                                   |
| `features/conversations/sse.ts`                                     | `ConversationStreamSink`：把 Fastify `reply` 包成"只开一次头、客户端走了就不再写"的 sink，事件编码是纯函数                                         |
| `features/conversations/errors.ts`                                  | `ConversationErrorCode` → HTTP 状态码的集中映射 + `sendConversationError`                                                                          |
| `features/conversations/generate.ts`                                | M1 + M2 + M3a 编排；`send` / `regenerate` 都先预建一个 chat_history revision，再收口同一行                                                         |
| `ConversationHistoryRepository.ts`、migration 072                   | chat_history 唯一事实模型、turn/revision RPC、上下文与 API 消息投影；删除 chat_messages                                                            |
| `routes/conversations.ts`                                           | §8.1 的八条路由，全部 `@frontend-ready`；鉴权走 `requireTelegramAuth`，归属校验落在仓库层                                                          |
| `app.ts`（改）                                                      | 注册 `conversationRoutes`                                                                                                                          |
| `history.test.ts` `sse.test.ts` `errors.test.ts` `generate.test.ts` | 16 个用例，覆盖四段纯逻辑                                                                                                                          |
| `scripts/mvp-regression/`（4 个文件）                               | §8.4 的回归脚本：HTTP 客户端（含 SSE 解析与中途 abort）、数据播种 / 清理、八个场景断言、runner。挂在 `mvp:regression` 脚本上                       |
| `scripts/st-regression/mock-upstream.ts`（改）                      | 加 `chunkDelayMs`（默认 0，ST 回归行为不变）。`client_disconnect` 需要真实的流式窗口才能在中途断开                                                 |

### 8.6 相对方案的偏离

| 偏离                                                                              | 原因                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §8.2 第 8 步的"首个 hook"具体化为**新增的 `onStreamOpen`**，而不是 `onFirstToken` | 等第一个 token 才写响应头，会让客户端白等一整个上游首 token 延迟（实测 1~5 秒）才拿到 `start` 事件，占位气泡挂不上——这恰是本方案要解决的问题。`onStreamOpen` 在预检通过且上游 2xx 之后触发，仍在任何 402 / 502 判定之后，"首字节前不能有可能失败的判定"这条约束不变 |
| M3b 验收后用 `chat_history` 合并原 `chat_messages` 职责                           | 两者都在持久化同一轮正文与生成状态。072 让 chat_history 增 turn/revision，并以最大 revision 表示当前版本，减少重复数据源                                                                                                                                            |
| 开场白改为虚拟 turn 0，首轮后只存在于 prompt 快照                                 | 只有用户主动发起的对话进入 chat_history；未发言的 session 不制造调用记录                                                                                                                                                                                            |
| `PATCH /api/v1/generation-config` **不收** `selected_model_id`                    | 改模型有专门的 `POST /api/v1/models/select`，那条路由带着"切到付费模型前先查余额"的业务闸门。从 PATCH 旁路改会绕过它。GET 仍返回该字段（只读镜像），PATCH 收到就 400 并指向正确路由；shared 契约同步收窄，M5 尚未消费，改动无成本                                   |
| 402 时把预建 history revision 收口成 `insufficient_balance`                       | 用户主动发起的数据仍需留痕；收口后不会被 streaming guard 锁 120 秒，充值后可立即继续发送或重生成                                                                                                                                                                    |
| 跳过 §8.2 第 2 步的"无进行中 streaming"预查询                                     | 两个 start RPC 在 session 行锁内调用同一个 guard。前置查询既多一次往返又有 TOCTOU，不如直接映射 RPC 的 SQLSTATE                                                                                                                                                     |
| `getGenerationConfig` 与 `resolveModelForUser` 各读一次 `selected_model_id`       | 接缝要的是"两处处理一致"，而两者读的是同一列、null 处理都收在 `resolveEffectiveSelectedModelId` 里，一致性由构造保证。合并成一次读要么破坏 M3a 的接口，要么让 `getGenerationConfig` 在 M3b 变成死代码                                                               |

### 8.7 上线前置（M6 之前必须清掉）

| 事项                                         | 说明                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 069 / 070 / 071 / 072 / 073 在**生产库**执行 | 目前只在 test 库跑过。必须按编号执行；072 回填并删除 `chat_messages`，073 建 current revision 视图。执行方式见 §十.4 |
| `chat_history.session_id` 的条件写入         | ST 链路不传 history id，继续 INSERT `session_id = NULL` 的日志；自研链路按预建 id UPDATE，不再产生重复行             |

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
5. **迁移编号**：批次 1 占用 069 / 070 / 071；最终会话模型调整占用 **072 / 073**，均已补进 README 索引。历史上有重号，后续落盘前再确认一次
6. PR 描述里附 §7.3 的 ST 链路回归结果（跑 `st:regression`，改动碰到 `llm-proxy` / `features/generation` 时还要附 §7.3.3 的对拍 diff）。`promptCaching` 在 ST 链路必须传 `false`，否则破坏"行为零变化"判据
7. ~~三个批次 1 模块各自独立 PR~~ 实际合成一个 PR 提交，提交按模块分开，理由与代价见 §四批次 1
