# M5 自研聊天 UI ＋ 大厅推荐 v3 评分 — 实施计划

> 作者：肖君枫（前端）
>
> 日期：2026-08-12（v2，并入大厅 v3 评分、合并为单个 PR、开放问题已拍板）
>
> 分支：`dev`（已含 M1–M3，migration 069~073 已在 test 库执行）
>
> 上游输入：`docs/ST_remove-M5-自研聊天UI.md`（交接说明）、`docs/ST_remove.md`、`docs/ST_remove-MVP实施方案.md`
>
> 交付方式：**两个模块合成一个 PR，提到 `dev`，先开 PR 不合并。**

---

## 零、本次范围

这一轮同时交付两件互不依赖的事，合并成一个 PR：

| 模块                    | 内容                                                                   | 触及范围                 |
| ----------------------- | ---------------------------------------------------------------------- | ------------------------ |
| **A. M5 自研聊天 UI**   | 给已交付的自研对话链路补上真机可访问的入口，一套零 ST 依赖的聊天 UI    | 前端为主，不碰数据库     |
| **B. 大厅推荐 v3 评分** | 推荐页排序换成 D30 ＋ R48 的加权分，前八不再固定，冷启动卡每次请求重排 | 后端 ＋ 一个新 migration |

两者唯一的交集是**迁移编号**：`dev` 最新已把 068~073 用掉（068 模型预设目录、069~073 自研引擎），
所以 B 的迁移取 **074**，不是原先规划的 069。

TG 群管理那条线暂停，其原先占用的 068/069 编号一并作废，重启时再取新号。

---

## 一、已拍板的决定

### 1.1 交接说明里的四个待拍板项：全部按倾向执行

| 问题                         | 决定                                                     | 依据                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新路由命名、是否带底部导航   | `/chat/[characterId]`，全屏无底部导航                    | `src/app/chat/` 与 `(main)/` 平级，天然不吃 `(main)/layout.tsx` 的 `BottomNav`；`chat` 不在 `next.config.mjs` 的 `ST_ROOT_PREFIXES` / `ST_ROOT_FILES` 里，不会被重写到 ST 网关。零额外配置。                          |
| 自动打开最近会话还是每次新建 | 默认新建；`?session=<uuid>` 才恢复；保留显式「新建对话」 | 用 `session` 而不是复用 ST 的 `?chat=<fileName>`，两条链路参数名不撞车，日志里也能一眼分辨来源。                                                                                                                      |
| 要不要「停止生成」按钮       | 不做                                                     | `features/conversations/sse.ts` 明写客户端断开不终止后端流程、仍跑到 `[DONE]` 并落库扣费。这个按钮只能是「前端停止渲染」，语义误导用户。**但前端仍持有 `AbortController`**，用于卸载/切会话时停止渲染，不暴露成按钮。 |
| 重生成的交互形态             | 最后一轮 assistant 气泡下方贴按钮，原地替换              | 后端只允许对最后一轮重生成（否则 409），同一轮新老版本共用 `turn_index`、靠 `revision` 区分，读取侧只给最大 revision。UI 上就该是原地替换。按钮只挂最后一轮，从入口上消灭 409。                                       |

### 1.2 我通读代码后新提的问题：本轮的处理方式

| #   | 问题                                                        | 决定                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 交接说明 §五 与 §六 互相矛盾，「DevTools 零 ST 请求」不可达 | **改判据**，见 §1.3。                                                                                                                                                                                                                                                                                                |
| 2   | 免费额度耗尽在新链路里没有信号来源                          | **走纯前端兜底（不改契约）**：每轮 `done` 后 invalidate `useCharacterFreeQuotaQuery`，从「上轮有额度 → 这轮为 0」的跳变判定耗尽。代价是多一次往返、且与扣费落库有轻微竞态（可能滞后一轮）。**不为此改 shared 契约**——契约冻结的价值大于这一次往返；如果后续 PM 认为滞后不可接受，再单独提「`done` 事件补额度快照」。 |
| 3   | `/chats` 历史列表是否在 M5 接新链路                         | **不接。** 它读的是 ST 的 `/api/users/chats`，与新链路会话是两套互不相干的数据，并排展示会让用户看到两份对不上的历史。M5 只给内部账号手输 URL 验收，M6 切换时一次性换源。                                                                                                                                            |
| 4   | 路由名 `/chat` 与既有 `/chats` 只差一个 s                   | **仍用 `/chat/[characterId]`。** 语义最直白，M6 切换时改大厅卡片指向最省事。命名相近只是阅读上的轻微别扭，不构成技术问题。                                                                                                                                                                                           |
| 5   | 流式期间是否渲染 markdown                                   | **流式期间纯文本，收口后渲染 markdown。** 每个 delta 重跑 markdown→sanitize 太贵，半截 markdown（未闭合的 `**`、代码块）渲染出来会跳变闪烁。收口瞬间会有一次轻微重排，可接受。                                                                                                                                       |

### 1.3 ST 零依赖判据的重定义

交接说明 §五 说 ST iframe 全站常驻、在新路由上仍会 boot、看到 ST 请求是预期的；§六 又把
「DevTools Network 里零 ST 请求」定成核心判据。这两条互斥。

代码侧确认 §五 是对的：`Providers` 无条件渲染 `<STIframe />`，`BridgeProvider` 只用
`pathname.startsWith('/tavern/')` 控制**显隐**而非挂载；`STIframe` 一挂载就 `POST /api/init-st-session`
并把 iframe `src` 指向 `/tavern/?miniapp_doc=...`。人只要在站内，ST 就在跑。

**本轮采用的两条判据：**

1. **静态（硬性、可自动化）**：新增文件里
   `grep -E 'bridge|platformAction|st-mirror|iframe|/api/users/chats|/api/platform/llm-proxy'`
   零命中。执行结果贴在 PR 描述里。
2. **运行时（人工复核）**：DevTools Network 按 **Initiator** 列核对——所有 ST 请求的发起方都是
   `st-iframe.tsx` / `providers.tsx` / iframe 文档自身，没有任何一条来自 `src/app/chat/` 或
   `src/lib/api/conversation*`。聊天页自身的请求只应有 `/api/v1/conversations*`、`/api/v1/models/*`、
   `/api/characters/*`、`/api/wallet/*`。

要字面意义的零请求就得改 `providers.tsx` 按路径延迟挂载 iframe，那与「ST 侧只读」直接冲突，本轮不做。

---

# Part A — M5 自研聊天 UI

## A1. 两个必须写进实现的契约细节

### A1.1 402 的响应体不是标准 envelope

`finishTurn` 里余额不足走 `InsufficientBalanceErrorResponse`：

```jsonc
{
  "error": {
    "message": "...",
    "type": "insufficient_balance",
    "credits_required": 50,
    "credits_available": 10,
  },
}
```

它**没有 `success` 字段**。现有 `apiClient` 的错误分支判 `if (json && !json.success)`，`undefined`
也满足，于是去读 `json.error.code` —— 而这个 body 里只有 `error.type`，结果 `ApiClientError.code`
是 `undefined`，两个金额数字被丢掉。

且 **402 有两种可能的 body 形状**：`finishTurn` 发裸形状，`sendConversationError` 发标准
`fail('insufficient_balance', ...)` envelope。新的流式客户端必须同时认（先看 `error.type`，再看 `error.code`）。

### A1.2 新流式客户端会比 `apiClient` 少一个遥测头

`apiClient` 的 `applyTelemetryHeaders` 带 `X-Boot-Session-Id`，取自 `@/lib/bridge/boot-session`。
按「新代码零 bridge import」，新客户端**不带这个头**，只带 `X-Init-Data` 与 `X-Request-Id`。

后果是新链路请求在后端日志里无法按 boot session 归并。M5 不放性能指标，可接受。M6 做埋点对齐时
应把 `boot-session` 这个纯 id 生成器挪到中立目录。

> REST 请求仍复用现有 `apiClient()`——它是既有文件、既有 import，交接说明 §五 也明确列为可直接复用件。
> 硬约束约束的是新增文件。

## A2. 文件清单

### A2.1 数据层 `src/lib/api/`

| 文件                          | 内容                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation-stream.ts`      | 新流式客户端 `streamConversationTurn()`。见 A3.1。                                                                                                                                                      |
| `conversation-stream.test.ts` | 单测：事件解析、跨 chunk 半行拼接、402 两种 body 形状、流内 `error` 事件、abort。                                                                                                                       |
| `conversations.ts`            | React Query 层：`useConversationsQuery` / `useConversationQuery` / `useCreateConversationMutation` / `useRenameConversationMutation` / `useDeleteConversationMutation` ＋ key 工厂 `conversationKeys`。 |
| `generation-config.ts`        | `useGenerationConfigQuery` / `usePatchGenerationConfigMutation`（只发三个 `pref_*`）。                                                                                                                  |

### A2.2 路由 `src/app/chat/[characterId]/page.tsx`

解析 `characterId` 与 `?session=`，编排进入状态机（A3.4），组装下面的组件。

### A2.3 组件 `src/components/chat/`（新目录，与 `components/tavern/` 完全隔离）

| 文件                           | 内容                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat-message-list.tsx`        | 按 `turn_index` 升序渲染、自动滚底、向前翻页（`before_turn_index`）。                                                                                         |
| `chat-message-bubble.tsx`      | 区分 role 与 `status`（streaming 光标 / interrupted 半截标记 / failed 提示）。                                                                                |
| `chat-composer.tsx`            | 8000 字上限（对齐后端 `MAX_USER_INPUT_LENGTH`）、生成中禁用发送、回车换行策略。                                                                               |
| `chat-markdown.tsx`            | `showdown` ＋ `dompurify`，按 `id + revision` memo。两个包已在 `package.json` 且零 import。                                                                   |
| `chat-regenerate-button.tsx`   | 只挂最后一轮 assistant 气泡下。                                                                                                                               |
| `chat-top-bar.tsx`             | 返回、角色名/头像、会话抽屉入口、工具入口。**不复用** `components/tavern/chat-header.tsx`（吃 `useSTMirror`）。                                               |
| `chat-session-drawer.tsx`      | 本角色会话列表、新建、重命名、删除。数据源 `/api/v1/conversations?character_id=`。                                                                            |
| `chat-model-switcher.tsx`      | 复用 `useModelCatalogQuery` ＋ `useSelectModelMutation`（`POST /api/v1/models/select`，带余额闸门）。**不走** `PATCH /api/v1/generation-config`，后端会 400。 |
| `chat-generation-settings.tsx` | 字数偏好 / 选项开关 / 自定义指令。                                                                                                                            |

### A2.4 直接复用（不改）

`ChatSplash`（`components/tavern/chat-splash.tsx`，无 bridge 依赖，只吃一个 `ready` 布尔）、
shadcn/ui、`globals.css` 设计 token、`apiClient()`、`useFontScaleStore`、`useIdleDim`、
`useCharacterQuery`、`useCharacterFreeQuotaQuery`、`useWalletBalanceQuery`、`useModelCatalogQuery`、
`useSelectModelMutation`、`lobbyImageUrl()`、`characterRoomGradient()`。

### A2.5 既有文件的唯一改动

`src/lib/api/client.ts`：**删除 `apiStreamClient()`**。零调用方，与新契约不兼容（按 OpenAI 风格解析
`{ content }` 分片、认 `[DONE]`、非 2xx 丢响应体），留着只会让人挑错函数。

## A3. 关键实现设计

### A3.1 流式客户端

```ts
export interface StreamTurnOptions {
  sessionId: string;
  /** 省略 = 重生成；有值 = 发消息 */
  content?: string;
  signal?: AbortSignal;
  onStart: (e: ConversationStreamStartEvent) => void;
  /** 已攒批的增量，不是累积全文 */
  onDelta: (text: string) => void;
  onDone: (e: ConversationStreamDoneEvent) => void;
}
export function streamConversationTurn(o: StreamTurnOptions): Promise<void>;
```

与被删掉的 `apiStreamClient` 的四点不同，逐条对应契约：

1. **按事件解析。** 每个 `data:` 行 `JSON.parse` 成 `ConversationStreamEvent`，按 `type` 分发。
   **没有 `[DONE]` 哨兵**，终态是 `done` 事件。
2. **增量语义。** `delta.text` 是新增片段而非累积全文，回调直接透传增量。
3. **非 2xx 必须读 body**，按此顺序分型并抛出带结构的 `ConversationStreamError`：
   `error.type === 'insufficient_balance'` → 402 且带上两个金额；
   `{ success: false, error: { code } }` 且 code 在 `ConversationErrorCode` 里 → 按 code 抛；
   其余 → 按 HTTP 状态码抛通用错误。
4. **流内 `error` 事件单独一路。** 响应头写出后才发生的错误走 200 ＋ 流内 `error`。这类错误
   **已产生半截正文**，UI 应「保留已渲染内容 ＋ 底部错误条」，而不是把气泡整个换成错误态。

**delta 攒批**：`onDelta` 不直接 `setState`，用 `requestAnimationFrame` 合并一帧内的所有增量，
一帧至多一次 `setState`。上游逐 token 吐字时重渲染上限是 ~60fps 而不是 token 数量级。

**AbortSignal**：卸载、切会话、切角色时 abort。abort 只停本地读流，后端照跑照落库，
所以 abort 后要 invalidate 会话详情。

### A3.2 React Query 与流式状态怎么合流

定死一个规则，这是全模块最容易写乱的地方：

- **落库态的唯一真相是 `useConversationQuery(sessionId)`**。
- **流式临时态只活在组件级 `useState`**（`streamingTurn: { assistantMessageId, text, turnIndex, revision } | null`），
  不写进 query cache。
- 渲染时把 `streamingTurn` 叠在 query 数据之上：`start` 给到 `assistant_message_id` 后立刻挂占位气泡；
  `done` 之后**先 invalidate、等 refetch 落地再清 `streamingTurn`**，否则中间会闪一帧空白。
- 重生成同理，替换的是已存在的最后一轮，`start.user_message_id` 为 `null`，`revision` +1。

不塞进 query cache 的理由：逐帧 `setQueryData` 会让所有订阅方重渲染，且流被 abort 后缓存里会留下
一条永不收口的假消息。

### A3.3 错误矩阵

按后端 `features/conversations/errors.ts` 的映射表整理，每格都有确定的 UI 行为：

| 状态 / 事件         | code                                        | 场景                            | UI 行为                                                                                                            |
| ------------------- | ------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 400                 | `BAD_REQUEST`                               | 空消息、超 8000 字、UUID 非法   | 输入框内联提示；长度前端先拦，正常到不了                                                                           |
| 401                 | `UNAUTHORIZED`                              | initData 缺失/失效              | 走全站既有鉴权失败处理，不单独造                                                                                   |
| 402                 | `insufficient_balance`                      | 余额不足，**上游未被调用**      | 跳 `/profile/recharge?reason=insufficient_credits&returnTo=/chat/<id>?session=<sid>`，带 `credits_required` 做文案 |
| 404                 | `session_not_found` / `character_not_found` | 会话被删 / 角色下架             | 会话不存在 → 回落到「新建会话」；角色不存在 → 返回大厅并提示                                                       |
| 409                 | `session_busy`                              | 该会话还有一条 streaming 未收口 | 提示「上一条还在生成」，禁用发送并轮询会话详情直到收口。单端由「生成中禁用输入」提前挡掉，多端才会遇到             |
| 409                 | `regenerate_not_allowed`                    | 不是最后一轮 / 该轮无 user 消息 | 正常不该出现；出现即提示并刷新会话                                                                                 |
| 502                 | `upstream_error`                            | 上游不可用，流未开始            | 底部错误条 ＋ 重试，输入内容保留                                                                                   |
| 500                 | `INTERNAL_ERROR`                            | 未知异常                        | 同上，文案更保守                                                                                                   |
| 200 ＋ 流内 `error` | `upstream_error`                            | 流已开始后中断                  | **保留已渲染的半截正文** ＋ 底部错误条；对应落库 status 是 `interrupted`                                           |

**输入内容一律不清空，直到 `start` 事件到达才清。** 任何 `start` 之前的失败都要能原样重发。

### A3.4 进入会话的状态机

```
/chat/:characterId              → 新建：POST /api/v1/conversations { character_id }
                                  返回 session + 开场白（虚拟 turn 0）→ 直接可聊
/chat/:characterId?session=<id> → 恢复：GET /api/v1/conversations/:id
                                  404 → 提示后回落到「新建」分支
```

- 新建成功后 `history.replaceState` 把 `?session=<新 id>` 补进 URL，刷新页面不会又建一个空会话。
- 开场白由后端合成（`getCharacterFirstMes` ＋ `listMessages(openingMessage)`），`turn_index = 0`，
  前端**不需要**自己去角色卡取 `first_mes`。
- 加载期间复用 `ChatSplash`，`ready` 由「会话数据到手」驱动。

### A3.5 重生成

按钮只在**最后一轮 assistant 气泡**下出现且该轮 `turn_index > 0`。点击后
`POST /api/v1/conversations/:id/regenerate`（空 body），复用同一条流式客户端，
渲染上把最后一条 assistant 气泡原地清空后重新流入，不新增气泡。

---

# Part B — 大厅推荐 v3 评分

## B0. 目标与口径

推荐页排序从「运营固定前八 ＋ 第九张起按 5 轮转化率」换成**全量按 v3 score 排序**。
前八不再固定，金框跟着新前八自动走。

**统计窗口**：滚动 80 天，`W = now - 80d`。时间衰减本轮不开。

**每个 (用户 u, 卡 c) 在窗口内**：

- `turns` = 窗口内 `chat_history` 行数。**不是** `MAX(user_character_round)`——那是全历史累计值。
- newcomer 判定 = 该 (u,c) 的**全历史** `MIN(created_at) >= W`。`chat_history` 从无清理，判定精确。
- 失败请求（`status <> 'success'`）计入。用户确实发出了这条消息，且与现有视图口径一致。

**D30（权重 0.75）**：`n_c` = 窗口内有过至少一轮的去重用户数；`D30_c = AVG(LEAST(turns, 30)) / 30`。
用 `min(turns,30)` 单次聚合，不逐轮算 30 个留存点。

**R48（权重 0.25）**：仅对 newcomer 计算。按 `created_at` 排序，`LAG` 判定间隔 > 30 分钟即切新
session。`T_end1` 取 session 1 末条时间，`T_start2` 取 session 2 首条时间。
分母 `k_c` = 满足 `T_end1 <= now - 48h` 的 newcomer 数（严格只用满 48 小时的样本，不提前计入）；
分子 = 其中 `T_start2 <= T_end1 + 48h` 的人数。

**收缩与归一化**：

```
D30̂      = (n_c · D30_c + 20 · μ_D) / (n_c + 20)   μ_D 取 n_c ≥ 20 成熟卡的加权均值，全局单一先验
norm(x)   = clip((x − P10) / (P90 − P10), 0, 1)     P90 ≤ P10 时退化为 0.5
λ_R       = clip(k_c / 40, 0, 1)
normR_eff = λ_R · norm(R48) + (1 − λ_R) · 0.5
score     = round(100 × (0.75 · norm(D30̂) + 0.25 · normR_eff), 2)
```

两条标尺分别取样：D30 标尺用所有 `n_c ≥ 20` 的卡的 `D30̂`；R48 标尺用所有 `k_c ≥ 40` 的卡的原始 `R48`。

**分层**：主池 `n_c ≥ 20` 按 score 降序，同分回落 `sort_order`；冷启动池 `n_c < 20`（含 0）
随机插入**主池长度的 30%–60%** 位置，**每次请求重排**。

## B1. 为什么「每次请求重新随机」几乎不用额外代价

大厅取数是前端 Next 路由代理，两跳都已经是 no-store：`app/api/lobby-characters/route.ts` 里
`revalidate = 0` / `dynamic = 'force-dynamic'`，上游 fetch 带 `cache: 'no-store'`。
后端那个 `s-maxage=60` 对大厅其实是空转。

所以只需要把 `sort=recommended` 的响应头改成 `no-store`（`latest` 保留 60 秒），随机就真的每次生效。

**抖动范围**：主池顺序由 score 完全决定，是确定的；只有 `n_c < 20` 的冷启动卡在 30%–60% 区间内换位置。
列表头部（含金框八张）稳定不动。`useCharactersQuery` 是 `refetchOnMount: 'always'` 且带 localStorage
快照做 `initialData`，所以从聊天页返回首页会先看到上次的顺序、再闪一下换成新的随机顺序——**只在中段发生**。
这个代价接受。

## B2. 数据落地

### B2.1 Migration `074_lobby_ranking_score_v3.sql`

- 新建汇总表 `miniapp.character_ranking_scores`，每卡一行：

  | 列             | 类型                  | 说明                      |
  | -------------- | --------------------- | ------------------------- |
  | `character_id` | UUID PK               |                           |
  | `n_c`          | INTEGER               | 窗口内去重用户数          |
  | `d30_raw`      | DOUBLE PRECISION      | `AVG(LEAST(turns,30))/30` |
  | `d30_shrunk`   | DOUBLE PRECISION      | 贝叶斯收缩后              |
  | `k_c`          | INTEGER               | R48 分母                  |
  | `r48_raw`      | DOUBLE PRECISION NULL | `k_c = 0` 时为 NULL       |
  | `score`        | NUMERIC(6,2)          | 最终分                    |
  | `window_days`  | INTEGER               | 留痕，便于回看当时口径    |
  | `computed_at`  | TIMESTAMPTZ           |                           |

- 补索引：`(character_id, user_id, created_at) WHERE character_id IS NOT NULL`。
  既有的 `idx_chat_history_character_user_round` 是 `(character_id, user_id, user_character_round)`，
  走不了新口径的时间窗过滤。
- `GRANT SELECT` 给 `service_role, postgres`；结尾 `NOTIFY pgrst, 'reload schema'`。
- **纯新增，不动既有对象。**

### B2.2 回滚留一手

旧视图 `miniapp.character_engagement_stats` **不删**，只是不再读。v3 出问题时回滚是纯代码回退，
不需要动数据库。等稳定一两个版本再单独提一个迁移删它。

## B3. 计算的切分：SQL 出原始量，TypeScript 出分数

这样切是为了让统计部分能脱库单测。

**SQL 侧（两条查询，各自一次全表扫）**：

1. **D30 ＋ n_c**：窗口内按 `(character_id, user_id)` 聚合出 `turns`，再按卡聚合出
   `COUNT(*) AS n_c` 与 `AVG(LEAST(turns,30))/30 AS d30_raw`。
2. **R48**：先算全历史 `MIN(created_at)` 定 newcomer，再对 newcomer 的行用
   `LAG` ＋ 30 分钟阈值做 running-sum sessionize，取 session 1/2 的 `end1` / `start2`，
   最后按卡聚合出 `k_c`（`end1 <= now - 48h`）与 `returned_c`。

**TypeScript 侧（纯函数，零 IO，好测）**：

```ts
export function computeRankingScores(rows: readonly RawCardStats[]): RankingScore[];
```

依次做：加权先验 `μ_D` → 收缩 → 两条标尺各自取样算 P10/P90 → `norm` → `λ_R` → 加权求和 → 四舍五入两位。

需要在实现里定死、且要写进单测的边界：

- **百分位方法**：排序后线性插值（与 numpy 默认一致）。样本只有 1 个时 P10 = P90 → `norm` 退化为 0.5。
- **`μ_D` 无成熟卡时的兜底**：先退到「所有 `n_c > 0` 的卡按 `n_c` 加权的均值」，仍为空则取 0.5。
- **`k_c = 0`**：`r48_raw` 为 NULL，`λ_R = 0`，`normR_eff = 0.5`（完全靠先验）。
- `n_c < 20` 的卡也照常算分并落库（便于观察），只是排序时不进主池。

## B4. 每日刷新 job

新增 `packages/backend/src/lib/lobby-ranking-refresh-job.ts`，照 `chat-history-sync-job.ts` 的形态：
`setInterval` 每 24 小时 ＋ 启动后延迟跑一次，`start/stop` 一对导出，在 `app.ts` 里挂载与 `onClose` 停止，
用 `config` 里的开关控制启停。

**多副本防重**：整个刷新包在 `pg_try_advisory_lock(<常量 key>)` 里，拿不到锁就直接跳过本次
（Railway 可能跑多副本，没有锁会重复算）。跑完 `pg_advisory_unlock`。

**读路径变轻**：从「每次请求对全表做聚合视图」退化成「读一张每卡一行的表」，比现在更轻。
`engagement-stats.ts` 换成 `ranking-scores.ts`，保留 60 秒进程内缓存。

## B5. 冷启动兜底（重要）

**首次部署时汇总表是空的。** 如果读到空表就照常走排序逻辑，所有卡的 `n_c` 都是 0 → 全部落进冷启动池
→ 整个大厅被随机打乱。这是必须挡住的事故。

处理：`loadCharacterRankingScores()` 在**表为空或查询失败**时返回 `null`，路由侧沿用现有的
`if (engagement)` 那套写法——拿不到分就保持运营顺序，宁可不动态排序也不能把首页排乱。
job 在启动延迟后会跑第一次，把表填上。

## B6. 排序函数重写

`features/lobby/recommended-ranking.ts`：

- 入参从 `engagement: Map<string, CharacterEngagement>` 换成 `scores: Map<string, CardScore>`
  （`{ score, sampleSize }`），去掉 `fixedCount`。
- 主池：`sampleSize >= 20` 按 score 降序，同分回落运营顺序下标。
- 冷启动池：`sampleSize < 20`，洗牌后插入**主池长度的 30%–60%** 区间。
  沿用现有「槽位一次性选定」的写法（逐张插入会让先插入的被后插入的顶出区间）。
  冷卡数超过区间宽度时按现有做法把窗口撑大。主池为空时全部随机。
- **随机源改成每次请求不同**：签名从 `seed: number` 改成 `seed?: number`，省略时用随机种子。
  单测传固定 seed 保持可复现。`dailyShuffleSeed()` 随之删除（连同它的测试）。

常量调整：`LOBBY_COLD_START_MIN_ENTERED_USERS`（10）→ `LOBBY_RANKING_MIN_SAMPLE`（20）；
`LOBBY_COLD_START_SLOT_FIRST/LAST`（31/60 绝对名次）→ `LOBBY_COLD_START_BAND`（0.3 / 0.6 相对比例）。

## B7. 路由改动 `routes/characters.ts`

- 读 `loadCharacterRankingScores()` 替代 `loadCharacterEngagementStats()`。
- `Cache-Control`：`sort=recommended` → `no-store`；`sort=latest` → 保留现有 60 秒。
- `is_featured` 仍是 `index < LOBBY_FEATURED_POSITION_COUNT`，因为顺序已经是 score 驱动的，
  金框自动跟着走。

**顺带要修的不一致**：`GET /api/characters/:id` 现在用「`sort_order` 前八」算 `is_featured`，
而列表页 v3 之后是「score 前八」，两者会给出不同答案（同一张卡在大厅有金框、进详情页没有）。
抽一个 `resolveFeaturedIds(operatorOrdered, scores)` 给两个端点共用。

## B8. 测试重写

`recommended-ranking.test.ts` 现有 9 个用例全建立在「前八豁免」的假设上，整体重写：

- 主池严格按 score 降序、同分回落运营顺序
- `n_c < 20` 一律进冷启动池（含 `n_c = 0` 和「老卡但窗口内不活跃」两种）
- 冷卡落在主池长度 30%–60% 区间内
- 不同调用产生不同顺序（每次请求重排），同 seed 可复现
- 不丢卡不重复
- 主池为空、冷卡数超过区间宽度两个边界

新增 `ranking-score.test.ts` 覆盖 `computeRankingScores`：收缩公式、P10/P90 线性插值、
`P90 <= P10` 退化、`λ_R` 过渡带、`k_c = 0`、无成熟卡时 `μ_D` 兜底、权重 0.75/0.25。

---

## 二、任务清单（单个 PR）

### Part A — M5

- [ ] `src/lib/api/conversation-stream.ts` ＋ 单测
- [ ] `src/lib/api/conversations.ts`、`generation-config.ts`
- [ ] 删除 `apiStreamClient()`
- [ ] `src/app/chat/[characterId]/page.tsx`（进入状态机 ＋ `ChatSplash`）
- [ ] `components/chat/` 九个组件
- [ ] 错误矩阵九格全部落实
- [ ] 免费额度耗尽弹窗（按 §1.2 第 2 条的前端兜底方案）
- [ ] `useFontScaleStore` / `useIdleDim` 接入

### Part B — 大厅 v3

- [ ] `packages/shared/migrations/074_lobby_ranking_score_v3.sql`
- [ ] `features/lobby/ranking-score.ts`（纯函数）＋ 单测
- [ ] `features/lobby/ranking-stats.ts`（两条 SQL ＋ 60 秒缓存 ＋ 空表返回 null）
- [ ] `lib/lobby-ranking-refresh-job.ts`（24h ＋ 启动延迟 ＋ advisory lock）、`app.ts` 挂载、config 开关
- [ ] 重写 `features/lobby/recommended-ranking.ts`
- [ ] `routes/characters.ts`：换数据源、`recommended` 改 `no-store`、抽 `resolveFeaturedIds`
- [ ] 重写 `recommended-ranking.test.ts`

### 收口

- [ ] `pnpm -r typecheck` / `lint` / `pnpm -r --if-present test` / 前端 `build`
- [ ] §1.3 判据 1 的 grep 自检结果贴进 PR 描述
- [ ] 开 PR 到 `dev`，**不合并**

## 三、验收

### 3.1 M5（Railway `development`，真机 Telegram）

建会话、发消息看到流式回复、刷新后历史完整、重生成、切换/重命名/删除会话、切模型。
ST 零依赖按 §1.3 两条判据核。

**重点观察两件本地验不到的事**：真实上游的流式时序（本地假上游按固定 chunk 切包）；
中间层会不会缓冲 SSE（后端已下发 `X-Accel-Buffering: no`，Railway 侧是否攒包只有真机能看出来）。
**如果回复是整段吐出而非逐字，先反馈，不在前端做假打字机糊过去。**

**不验首屏耗时**：后台 ST iframe 仍在抢带宽，这个阶段的数字不代表最终值。

### 3.2 大厅 v3

迁移在 test 库执行后，job 跑完第一轮，检查汇总表每卡一行且 score 分布合理；
大厅推荐页前八与 score 前八一致；连刷几次，头部不动、中段冷卡位置变化；
`sort=recommended` 响应头为 `no-store`、`sort=latest` 仍是 60 秒。

## 四、风险

| 风险                         | 影响                                           | 应对                                                                                          |
| ---------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| SSE 被 Railway/中间层缓冲    | 流式退化成整段吐出，M5 核心卖点没了            | 真机一发现就上报，属基础设施问题，不在前端遮掩                                                |
| 免费额度提示滞后一轮         | 用户多发一条才看到额度耗尽                     | 已知取舍（§1.2 第 2 条）；不可接受时再提契约变更                                              |
| **汇总表为空导致大厅全随机** | 首页排序事故                                   | §B5 的 `null` 兜底 ＋ 路由侧保持运营顺序；这条是 Part B 的头号风险                            |
| 两条聚合 SQL 在大表上慢      | job 跑不完或拖慢库                             | 新索引覆盖 ＋ job 每天只跑一次 ＋ advisory lock 防并发；上线后看一次实际耗时                  |
| 新老两套历史并存             | 用户在 `/chats` 看到 ST 历史，进新链路却是空的 | M5 不动 `/chats`（§1.2 第 3 条）                                                              |
| 流式态与 query cache 不同步  | 闪烁、假消息残留                               | §A3.2 定死的规则                                                                              |
| 误碰 ST 侧文件               | ST 承载 100% 生产流量，改错即事故              | 新目录隔离 ＋ grep 自检 ＋ review 时确认既有文件改动只有 `client.ts` 与 Part B 的三个后端文件 |

## 五、迁移与部署

- **本轮唯一迁移是 074**，纯新增（一张表 ＋ 一个索引），不动既有对象。
- M5 全程不碰数据库；069~073 已在 test 库执行过，dev 环境就绪。
- PR 只开不合并。迁移与部署等验收后另行安排。
