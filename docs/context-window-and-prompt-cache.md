# 上下文水位线泄洪与 LLM Prompt Cache

> 状态：设计已确认，待落地。不引入会话级 Redis。
> 前置：`docs/ST_remove.md` 决策 10（上下文长度管理后置）、`docs/ST_remove-MVP实施方案.md` 决策 11（Anthropic `cache_control`）、`docs/ARCHITECTURE.md` §4.4 / §10.2。
> 对照实现：旧 bot `UpstashSessionStore` 的 `maxHistoryItems` / `historyRetentionCount` + `SimplePromptEngine._buildRequestBody`；miniapp 现状见 `features/engine/prompt-engine.ts`、`features/generation/prompt-caching.ts`、`features/conversations/generate.ts`。

---

## 1. 结论

Postgres 足以同时承载两件事，**不必为它们引入 Redis**：

| 能力             | 作用                                                        | miniapp 现状                             |
| ---------------- | ----------------------------------------------------------- | ---------------------------------------- |
| 水位线泄洪       | 限制入模历史轮数，压长会话 prompt 成本                      | ⏳ 未做，`truncatedTurns` 恒为 0         |
| LLM prompt cache | Claude 经 OpenRouter 时打 `cache_control`，前缀按缓存价计费 | ✅ 自研链路已开（`promptCaching: true`） |

对话工作集的真相继续是 `miniapp.chat_history`（当前 revision）。进程重启不丢已收口历史；正在流式的那一口本来就不在 Redis/内存工作集里，和有没有 Redis 无关。

Redis 在 miniapp 里只继续做 `runtime_config` 等短 TTL 缓存，不存会话 List。

---

## 2. 双水位线 A–B

用**轮**计数，不是 bot 的消息条数。一行 `chat_history`（当前 revision）= 一轮。开场白是虚拟 turn 0，**不计入水位**。

| 符号         | 配置键（建议）         | 含义                                                                  |
| ------------ | ---------------------- | --------------------------------------------------------------------- |
| **B** 高水位 | `max_context_turns`    | 入模窗口上限：最多带最近 **B** 轮                                     |
| **A** 低水位 | `retain_context_turns` | 泄洪后留下的轮数：冲过高水位后窗口收成最近 **A** 轮，且 **1 ≤ A ≤ B** |

直观理解：

- 窗口在涨：从当前起点一直累加，**最多 B 轮**。
- 一旦 `size > B`：一次性丢掉最老的那截，**留下最近 A 轮**（不是每轮滑一格）。
- 之后再从 A 涨到 B，再泄一次。泄洪之后窗口长度落在 **[A, B]**。

会话早期（还没泄过洪）可以少于 A 轮，这是正常的。

### 为什么必须是双水位，而不是「永远只留最近 B 轮」

若每轮都 `slice(-B)`，顶满后**每一轮都丢掉最老一轮**，Anthropic 缓存的前缀每轮都变，cache 会轮轮 miss。

双水位的价值是制造「稳定前缀」区间：泄洪那一轮 miss 一次，随后从 A 涨到 B 的整段前缀只增长、不改写，cache 可以连续命中。因此 **A 应明显小于 B**（例如 A=50、B=75）。A=B 时退化为滑动窗口，cache 收益变差。

### 和旧 bot 的对应

Bot 在 Redis List 上：`maxHistoryItems`（高）/ `historyRetentionCount`（低），超高水位 `LTRIM` 只留低水位条数。那是**删工作集**。miniapp **不删** `chat_history`，只决定本轮 prompt 带哪些 turn；UI 翻历史、审计、计费仍看全量当前 revision。

Bot 按消息条（默认 150，约 75 轮）。miniapp 按轮，数值不要直接抄 150。

---

## 3. 现状：prompt 怎么组装（窗口接上之前）

一次发消息：

1. 并行读模型、角色卡、`miniapp_user_settings` 偏好、`runtime_config` 平台规则三件套。
2. RPC 插入本轮 `chat_history`（`status=streaming`），再 `getContextBeforeTurn`：`turn_index < 本轮` 的**全部**当前 revision，无 LIMIT。
3. `buildEngineHistory`：开场白（首轮快照或角色卡 `first_mes`）+ 历史；空回复丢掉；本轮原文不进 history。
4. `buildPrompt`：
   ```
   [system]    角色卡 system_prompt
   [assistant] 开场白
   [user/assistant…] 全量历史
   [user]      ##系统指令：{平台规则}\n##用户指令:{本轮原文}
   ```
   平台规则三个占位符：`{{WORD_COUNT}}` / `{{INTERACTION_MODE}}` / `{{USER_CUSTOM_INSTRUCTIONS}}`。人设走 system；字数/选项/自定义走**本轮最后一条 user**。
5. `setPromptHistory` 把实际 messages 写回本轮 `history` 列（下一轮开场白从首轮快照抽）。
6. `applyPromptCaching` 后 POST OpenRouter。

重生成：新 revision、同一 `turn_index`，读的仍是「本轮之前」，不会把旧回复带进 prompt。

---

## 4. 泄洪怎么落地（Postgres）

### 4.1 配置

`miniapp.runtime_config` 两个整数，走现有 `fetchRuntimeConfigEntries`，进程内缓存即可。缺省或非法时用代码默认值，并保证 `A ≤ B`。

### 4.2 会话记住窗口起点

`chat_sessions` 增加：

```text
context_window_start_turn INTEGER NOT NULL DEFAULT 1
```

含义：入模历史从该 `turn_index`（含）起到本轮之前。默认 1 = 尚未泄洪。

**不要每轮改它。** 只在窗口超过 B 时跳到 A：

```text
completed = 本轮 turn_index - 1
size = completed - context_window_start_turn + 1

if size > B:
    context_window_start_turn = completed - A + 1
    persist
```

例：A=50，B=75

| 本轮   | completed | 起点   | 入模轮次       | 说明               |
| ------ | --------- | ------ | -------------- | ------------------ |
| 1–76   | 0–75      | 1      | 1 … completed  | 未超 B，前缀只增长 |
| 77     | 76        | **26** | 26–76（50 轮） | size=76>75，泄洪   |
| 78–102 | 77–101    | 26     | 继续涨         | 稳定前缀 + 新轮    |
| 103    | 102       | **53** | 53–102         | 再次泄洪           |

泄洪写起点放进现有 `start_chat_history_turn` / `start_chat_history_regeneration` 的行锁事务，与 `session_busy` 同一把锁，避免并发把起点写乱。

新会话新行默认起点=1，窗口自动重置。

### 4.3 读上下文带下界

改 `ConversationHistoryRepository.getContextBeforeTurn`：

```text
WHERE session_id = ?
  AND turn_index >= context_window_start_turn
  AND turn_index < 本轮
ORDER BY turn_index ASC
```

`truncatedTurns = context_window_start_turn - 1`（未泄洪为 0）。

然后仍走 `buildEngineHistory`（开场白 + 窗口）。`buildPrompt` 填 `truncatedTurns`，不要再 slice 一遍——窗口下界以 SQL 为准。

`listMessages` **不加**这个过滤。

### 4.4 与现有语义

- 空回复 / 中断：继续不进 prompt；`turn_index` 仍占一轮，实现简单、与库一致。
- 重生成：窗口起点用 session 列，读「本轮之前」。
- 重启：起点在 Postgres，进程挂了窗口不会退回全量。
- 不 `DELETE` 旧 turn，不按 token 估算（bot 也没有；要做是下一档）。

---

## 5. LLM cache（已有，窗口接上即可）

`features/generation/prompt-caching.ts`：只对 `anthropic/*` 把 string content 改成带 `cache_control: { type: 'ephemeral' }` 的 text 块。

断点：

1. **system**（角色人设）
2. **`messages.length - 2`**（窗口内历史最后一条）
3. **不打最后一条**（平台规则 + 本轮输入）。下一轮这条会以未包装原文出现在历史里，打上去必然 miss。

ST 链路必须继续 `promptCaching: false`，保住「行为零变化」。

窗口接上之后，cache 看到的就是泄洪后的 messages，不必改断点规则。泄洪发生的那一轮前缀 miss 一次，随后 [A, B] 增长段可连续命中。

不要为了 cache 把平台规则改进行人设 system：历史里的 user 是原文，本轮是包装体，两者对不上。

---

## 6. 目标组装顺序

```text
取配置 / 角色 / 偏好
  → RPC 开本轮（必要时泄洪，更新 context_window_start_turn）
  → getContextBeforeTurn（turn_index ∈ [起点, 本轮)）
  → buildEngineHistory（开场白 + 窗口）
  → buildPrompt
        [system 人设]
        [assistant 开场白]          ← 始终在，不计水位
        [窗口内 user / assistant]
        [user 平台规则 + 本轮输入]
  → setPromptHistory（实际发出去的 messages）
  → applyPromptCaching
  → OpenRouter
```

---

## 7. 明确不做

- 不为窗口或 cache 引入会话 Redis List。
- 不把 `chat_history` 裁成工作集（那是日志 / UI / 计费源）。
- 不在引擎里按 token 预算再裁一刀（本方案只做轮数窗口）。
- 不把窗口过滤套到会话消息 API 上。

---

## 8. 改动面（落地时）

| 位置                                    | 改什么                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 新 migration                            | `chat_sessions.context_window_start_turn`；两个 RPC 在开轮时按 A/B 更新起点                     |
| `runtime_config`                        | `max_context_turns` / `retain_context_turns`                                                    |
| `ConversationHistoryRepository`         | `getContextBeforeTurn` 加 `turn_index >= 起点`                                                  |
| `features/engine/prompt-engine.ts`      | 写入真实 `truncatedTurns`                                                                       |
| `features/conversations/history.ts`     | 一般不用改；开场白逻辑保持                                                                      |
| `features/generation/prompt-caching.ts` | 不改断点；窗口后的 messages 直接喂进去                                                          |
| 测试                                    | 泄洪跳点、A=B 退化、开场白保留、重生成不带旧回复、非 anthropic 不打断点、最后一条 user 不打断点 |

验收：短会话与现在逐条一致；第 B+2 轮起 prompt 不含被裁掉的早期轮，但仍含开场白；UI 仍能翻到被裁轮次；Claude 请求里 system 与历史尾带 `cache_control`。
