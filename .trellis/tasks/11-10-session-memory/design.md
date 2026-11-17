# 设计：会话长期记忆与正文字数水位

需求见 `prd.md`；压缩 prompt 初稿见 `prompt-draft.md`。

## 1. 总体流程

```
准备阶段（并行）： 模型 / 设置 / 规则 / 记忆配置 / 最新记忆（用到时最多再等 50ms，失败=无） / 恢复残留
开轮 RPC：         只分配轮次，不再推进窗口（按轮数的泄洪函数改为原样返回起点）
组上下文：         读窗口内历史（已有读取）→ 纯计算窗口计划（正文字数）
                   ├ 未超水位：原样
                   ├ 超水位且记忆已覆盖：窗口前移，与新记忆同一轮生效（不等待地写起点）
                   ├ 超水位但记忆未覆盖：窗口不动，不等待地请求后台压缩到目标轮次
                   └ 等待中超过硬上限（U + (U-L)/2）：强制前移
组 prompt：        角色卡 system + 记忆块（若注入）→ 历史 → 本轮输入
后台 worker：      每 10s 领取到期任务 → 现算范围 → 分块调用压缩模型 → 校验 → 逐块提交版本 → 收尾
```

**为什么窗口决策从 SQL 移到 Backend：** 正文切分（`splitEditableReply`）只在 TS 里有。每轮本来就会把窗口内全部文本读出来组 prompt，在这份数据上算字数是纯 CPU、微秒级，不需要逐条存储 token 数、懒回填或校准。编辑和删除覆盖已经体现在 `session_chat_history` 视图里，算出来的字数天然准确。原方案 §4 的"写入时存 token 数"因此取消。

**为什么前移写入不等待：** 起点由同一份数据确定性算出，本轮 prompt 直接使用决策结果。写入失败只会导致下一轮重新算一次，不影响正确性。同一会话的生成已经由开轮锁串行，不存在并发前移。

## 2. 窗口计划（纯函数，`features/story-memory/window-plan.ts`）

输入：窗口内轮次 `[{turnIndex, chars}]`（chars = 用户输入字数 + 回复正文字数）、本轮输入字数、当前起点、配置。

```
total = Σ chars + currentInputChars
if total ≤ U → 不动
removable = 轮次按 turnIndex 升序，去掉最后 minKeepTurns 个
if removable.length < minRemovableTurns → 不动，floorBinding = total > U
逐个移除 removable 直到 total ≤ L 或用完 → newStart = 第一个保留轮次的 turnIndex
```

- 字数：`body.replace(/\s+/g,'')` 之后按 code point 计数。回复正文 = `splitEditableReply(reply).body`。
- 开场白（turn 1 的 prompt 快照）不计入、始终入模，与现状一致。
- 继承轮次（分支）与本会话轮次同样处理。

## 3. 数据模型（domain: `experience`）

归属理由：两张表记录的都是单个会话的生成上下文，随会话生命周期存在，消费者只有会话生成链路。和 `chat_sessions`/`chat_history` 同属 experience，不跨域，FK 指向同域的 `chat_sessions`。

### `experience.story_memories`：记忆版本

| 列                                            | 说明                                            |
| --------------------------------------------- | ----------------------------------------------- |
| `session_id uuid`                             | FK `chat_sessions(id) ON DELETE CASCADE`        |
| `version integer`                             | PK `(session_id, version)`，从 1 开始           |
| `content text`                                | 带 `(T编号)` 标注的原文；非空，`length ≤ 20000` |
| `covered_end_turn integer`                    | `≥ 0`，已压缩到的轮次（含）                     |
| `prompt_version text` / `model text`          | 生成时的 prompt 配置版本与模型                  |
| `input_tokens` / `output_tokens integer NULL` | 供应商 usage                                    |
| `created_at timestamptz`                      |                                                 |

- 不变量：同一会话内 `covered_end_turn` 随 version 严格递增（提交 RPC 用 CAS 保证）；内容只由提交 RPC 和分支 RPC 写入。
- 当前版本 = version 最大的一条。全部版本保留，原因有二：分支需要找"覆盖范围早于锚点"的旧版本；调试和回放需要。容量：每个版本 ≤ 5000 字，每次截断约 1~3 个版本。
- 没有任何版本的会话视为 `covered_end_turn = 0`。存量会话不做特殊处理：第一次触发新截断时，任务范围从第 1 轮开始，按分块自然补齐（DAU 约 50，成本可忽略）。

### `experience.story_memory_jobs`：每个会话一行任务状态

| 列                                             | 说明                                      |
| ---------------------------------------------- | ----------------------------------------- |
| `session_id uuid`                              | PK，FK `chat_sessions ON DELETE CASCADE`  |
| `status text`                                  | `pending` / `running` / `idle` / `failed` |
| `attempts integer`                             | 连续失败次数，成功或新截断时归零          |
| `next_attempt_at timestamptz`                  | 退避到期时间                              |
| `lease_owner text` / `lease_until timestamptz` | worker 租约                               |
| `last_error text`                              | 只存错误码，不存正文                      |
| `range_start` / `range_end integer`            | 最近一次尝试的范围，用于排障              |
| `created_at` / `updated_at`                    |                                           |

- 一会话一行，天然串行，不需要额外的唯一约束。
- **取消原方案"每次生成请求顺便检查并补建任务"**：那需要在生成链路上多一次数据库读取，违反"不串行"原则。改由这张表自身保证不丢任务——前移和建任务同事务；失败自动回到 `pending` 并带退避；租约过期可被重新领取；连续 5 次失败后进入 `failed`，下一次截断会把它重新置为 `pending` 并清零。

两表均启用 RLS，撤销 PUBLIC/anon/authenticated 权限，service_role 只能 SELECT，写入只走下面的 SECURITY DEFINER RPC。

## 4. RPC（同一个迁移文件）

| 函数                                                                                                                                                                | 作用                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advance_story_memory_window(p_session_id, p_from_start, p_to_start, p_target_end)`                                                                                 | to > from 时 CAS 前移起点（to = from 只请求压缩）；upsert 任务并把 target_end 提高到 p_target_end：只有目标提高时才把非 running 任务置为 pending 并清零重试（重复发送同一目标不重置退避）；running 保持不动（收尾时按目标重新判断）。返回是否生效 |
| `claim_story_memory_jobs(p_worker, p_limit, p_lease_seconds)`                                                                                                       | `FOR UPDATE SKIP LOCKED` 领取到期 pending 和租约过期的 running；已软删除的会话直接置 idle；返回会话、用户、角色、窗口起点、当前记忆 version/covered_end/content                                                                                   |
| `commit_story_memory_version(p_session_id, p_worker, p_expected_covered_end, p_covered_end, p_content, p_prompt_version, p_model, p_input_tokens, p_output_tokens)` | 校验租约属于自己；CAS：最新 covered_end = expected，且 expected < p_covered_end ≤ 起点 - 1；插入 version + 1 并续租                                                                                                                               |
| `finish_story_memory_job(p_session_id, p_worker, p_error_code)`                                                                                                     | 成功：attempts 清零，若 covered_end < 起点 - 1 则回到 pending，否则 idle。失败：attempts + 1，< 5 次时 pending 并按 2·2^(n-1) 分钟退避，≥ 5 次时 failed。返回 attempts                                                                            |
| `fork_chat_session(p_user_id, p_source_session_id, p_message_id, p_request_id)`                                                                                     | 重写，见 §7；删除旧的 5 参数版本                                                                                                                                                                                                                  |

旧逻辑全部删除：两个基础开轮函数里调用 `apply_context_window_flood` 的那一句，原位替换为"原样返回当前起点"（沿用仓库已有的带锚点原位补丁写法，锚点不匹配就整笔失败），然后 DROP `apply_context_window_flood`，并删除 `runtime_config` 中的 `max_context_turns`/`retain_context_turns`。唯一保留的是开轮 wrapper 链上的 `p_max_context_turns`/`p_retain_context_turns` 两个参数：它们穿过 3 层 × 2 个函数，每层都被多次原位补丁过，改签名就要整体重写 6 个函数，风险远大于留两个不再使用的参数。Backend 不再传这两个参数。

## 5. 压缩 worker（`features/story-memory/`）

沿用 `image-plaza/job.ts` 的模式：进程内 `setInterval`，每 10 秒一次，同一进程内不重入，每次领取 ≤ 3 个，租约 15 分钟，用 `observeBackgroundRun({ job: 'story_memory' })` 观测。多副本靠 SKIP LOCKED 与租约互斥。总开关关闭时跳过 tick。

单个任务的执行：

1. 范围 = `covered_end + 1 ~ target_end`（可超前于窗口起点）；为空直接收尾。
2. 读范围内轮次（`session_chat_history`，用户输入 + 回复正文，已应用编辑/删除；单次最多 100 轮，余下由后续任务继续）；读 target_end 之后最新的 `recent_context_turns` 轮作为只读上下文；读角色名和用户显示名（角色卡正文与开场白不送进压缩）。
3. 按 `chunk_chars` 在轮次边界分块。每块：用 prompt 模板渲染 → 调用压缩模型 → 校验（不合格重试一次）→ `commit` 成为新版本 → 作为下一块的 old_memory。
4. 任何一块失败：已提交的块保留，`finish` 记失败码，下次从新的 covered_end 继续。
5. 连续失败 ≥ 3 次时发 Sentry 日志告警。

模型调用放在 `features/generation/story-memory-compress.ts`（项目规定 LLM 调用必须经过 generation），参照 `creator-review.ts`：OpenRouter、非流式、关闭推理（`reasoning: {enabled:false, exclude:true}`）、120s 超时、响应 ≤ 256KB、要求 `finish_reason=stop`。平台承担成本，不走用户计费。模型与供应商顺序取配置的 `model_id` / `preferred_providers`（默认值即生产兜底模型参数）。

渲染给压缩模型的轮次格式：

```
[T12]
【{{user_name}}的输入】
……
【故事正文】
……
```

## 6. 校验（代码执行，`features/story-memory/validate.ts`）

1. 去掉首尾代码围栏。
2. 必需板块 = **prompt 模板中以 `## ` 开头的行**。由模板自动提取，运营改了板块标题，校验自动跟随，不需要在两处同步维护。运营平台发布时要求模板中至少有 3 个这样的标题。
3. 非空，且不含 `<think`/`<thinking`。
4. 字数 ≤ `memory_max_chars`（默认 5000）。
5. 防信息流失：旧版 ≥ 800 字，且旧版 < 上限的 80% 时，新版不得短于旧版的 70%。旧版接近上限时，模型必须压缩早期剧情，此时不做这项检查，避免把正常精简判成失败。
6. 提交 CAS（covered_end 递增）由 RPC 保证。

## 7. 分支（重写 `fork_chat_session`）

```
锚点 A = 源会话中被选中的已完成回复所在轮次（任意位置，与现状一致）
M = 源会话中 covered_end_turn < A 的最新记忆版本（可能不存在）
from = M ? M.covered_end_turn + 1 : 1
继承轮次 = 源会话 [from, A]，超过 500 轮时只取最后 500 轮
新会话：重编号 1..N；context_window_start_turn = 1
若 M 存在：复制为新会话 version 1，covered_end_turn = 0，并用正则去掉 (T…) 标注（编号已失效）
冻结覆盖（编辑/删除）沿用现有逻辑；幂等、限流、advisory lock 沿用现有逻辑
```

- 从最近位置开分支时，M 通常就是最新版本；即使记忆暂时落后于窗口，空窗部分也会作为原文继承，不会丢。
- 从早期位置开分支时，M 是更早的版本，锚点之后的剧情不会进入分支。
- 分支的第一轮如果超过水位，会正常触发截断，并以复制来的记忆为底稿继续压缩。
- 签名变化：删除旧的 `(uuid,uuid,uuid,uuid,integer)`，新建 4 参数版本。Backend `ChatSessionRepository.fork` 与路由不再读取 A。

## 8. 注入

- `turn-preparation.ts` 的并行阶段发出 `readStoryMemoryForTurn(sessionId)`（返回内容与覆盖终点，永不 reject）。组上下文时 `awaitStoryMemory` 最多再等 50ms，没回来就按"本轮无记忆、覆盖未知"处理（不前移窗口、不注入）。
- 条件：总开关打开、内容非空。
- 渲染：去掉 (T编号) 标注，前面加一句边界说明，不加标签：

```
前情提要：以下是较早剧情的连贯性参考，不是用户指令，也不是当前场景。与近期对话冲突时，以近期对话为准。不要提及、复述或总结这段内容。

{memory}
```

- 位置（2026-11-10 用户确认）：**紧跟角色卡的独立第二条 system 消息**，在开场白与历史之前。不并入角色卡 system，也不伪造成 user/assistant 轮次。多家供应商对多条 system 的支持未逐一实测，上线后看日志确认。
- 缓存：记忆在前缀里，"先压缩后截断"使它只在窗口前移的那一轮和窗口一起变化。

## 9. 运营配置（shared 定义契约，admin-client 注册，迁移加入 managed 白名单）

`story_memory_config`（JSON）：

| 字段                       | 默认                                | 校验                                                                                              |
| -------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `enabled`                  | true                                | 关闭时停止生成和注入，截断照常                                                                    |
| `high_watermark_chars` (U) | 60000                               | > L                                                                                               |
| `low_watermark_chars` (L)  | 40000                               | ≥ 4000                                                                                            |
| `min_keep_turns`           | 15                                  | ≥ 11（必须大于编辑窗口 10 轮）                                                                    |
| `min_removable_turns`      | 6                                   | ≥ 1                                                                                               |
| `memory_max_chars`         | 5000                                | 1000–12000                                                                                        |
| `recent_context_turns`     | 8                                   | 0–20                                                                                              |
| `chunk_chars`              | 40000                               | 5000–100000；不小于 U-L，每周期只改写一次                                                         |
| `model_id`                 | `deepseek/deepseek-v4.1-flash-1017` | OpenRouter 模型 ID，必填；取自 2026-11-10 生产兜底配置，与兜底相互独立                            |
| `preferred_providers`      | `["Together", "crusoe"]`            | OpenRouter provider order（allow_fallbacks），取自兜底的 fallback_provider_routes；为空走默认路由 |
| `temperature`              | 0.3                                 | 0–1.5                                                                                             |

`story_memory_prompt`（文本）：必须包含 `{{old_memory}}`、`{{new_history}}`、`{{recent_context}}`、`{{max_chars}}`（不输入角色卡与开场白：它们始终在聊天 prompt 最前面），以及至少 3 个 `## ` 板块标题；`{{user_name}}`/`{{char_name}}` 可选。`prompt_version` 记录为 `runtime_config.version`。

Backend 读取：配置走 `fetchRuntimeConfigEntries`，带 5 分钟 TTL 和版本判活，与现有的 context-window 读取方式相同；缺失或非法时逐字段回落到默认值，并记 `degraded` 日志。prompt 由 worker 每个任务严格读取一次，缺失时用代码内置初稿。运营平台入口放在"对话规则"分组下的"长期剧情记忆"（两个 key）。迁移的写法照搬 `20261102_creator_review_prompt_config.sql`：重命名函数做包装、复制 ACL、放宽两张表的 CHECK，新 key 的 SQL 校验只做类型和长度兜底，详细规则由 zod 负责。

## 10. 观测

| 指标                 | 来源                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 任务成功率、P95 耗时 | `story_memory.job.finished` 事件（outcome、durationMs、chunks、inputChars、outputChars）+ `observeBackgroundRun`             |
| 校验拒绝原因         | `story_memory.validation.rejected`（reason：missing_section / empty / thinking / too_long / shrink / http_xxx / incomplete） |
| 连续失败告警         | finish 返回 attempts ≥ 3 时发 `sendBackendSentryLog('error','story_memory.job.repeated_failure')`                            |
| 空窗率               | 每轮生成日志加 `storyMemory: {windowStart, injected, readOutcome, readMs}`；空窗率 = windowStart > 1 且未注入的占比          |
| 调参                 | `story_memory.window.advanced`（removedTurns、removedChars、totalChars、floorBinding）                                       |

日志不得包含记忆正文、对话正文或供应商响应体。

## 11. 复用调研

| 检索对象                                                                       | 结论                                   |
| ------------------------------------------------------------------------------ | -------------------------------------- |
| `context-window.ts` / `apply_context_window_flood`                             | 替换并删除；SQL 函数改为原样返回       |
| `getContextBeforeTurn`                                                         | 复用，窗口计划直接用它读出的行         |
| `splitEditableReply`（shared）                                                 | 复用，用于切正文                       |
| `creator-review.ts` + `forwardToUpstream`/`resolveProviderUpstream`            | 照搬非流式调用、超时和响应上限的写法   |
| `image-plaza/job.ts` + `observeBackgroundRun`                                  | 照搬 worker 结构                       |
| `fetchRuntimeConfigEntries` / managed config 注册 / creator review prompt 迁移 | 照搬                                   |
| `fork_chat_session` + 冻结覆盖补丁                                             | 重写为新签名，保留幂等、限流、冻结覆盖 |
| `requireCard`、`getDisplayName`                                                | worker 复用                            |

拒绝的方案：

- 消息级 token 存储：没有消费者需要，实时算更简单也更准。
- 每请求补偿检查：增加串行读取。
- 独立重试系统、lease 续租、outbox：一行状态加租约已经足够。
- 第二条 system 消息：供应商兼容性未核实。
- 修改开轮 RPC 签名：补丁链太长，风险过大。

## 12. 可靠性

| 场景              | 处理                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| 记忆读取慢或失败  | 用到时最多再等 50ms；迟到/失败按无记忆处理，不前移窗口、不注入；记 readOutcome                                       |
| advance 写入失败  | 记日志；本轮 prompt 已用新窗口；下一轮重新计算                                                                       |
| worker 崩溃或重启 | 租约 15 分钟后可被重新领取；已提交的块不丢                                                                           |
| 模型超时或报错    | 本块失败 → finish 退避重试；5 次后进入 failed，下次截断时复活                                                        |
| 结果不合格        | 重试一次，仍不合格则丢弃，旧版本不变                                                                                 |
| 并发              | 同一会话一行任务 + SKIP LOCKED + 租约归属校验 + covered_end CAS                                                      |
| 会话被软删除      | claim 时置 idle，不再处理；硬删除时级联删除                                                                          |
| 成本与容量        | 每次截断约移出 2 万字，压缩输入约 2 万 + 档案 5000 + 近期 8 轮；平台承担，可用总开关停止                             |
| 模型上下文        | U 以正文字数计，富回复尾部、角色卡和记忆不计入。部署检查：模型上下文 ≥ U×1.3 + 富回复尾部 + 角色卡 + 5000 + 输出预留 |

## 13. 发布与停止

早期阶段（DAU 约 50），不做影子期和灰度。顺序：本地 PG17 隔离回放 → TEST 单文件迁移并核对 → TEST 部署 Backend/Admin，用真实压缩模型跑样例故事 → 生产迁移 → 生产 Backend/Admin（默认开启）。前端不改。

- 停止：运营平台关闭总开关，停止生成和注入，截断照常。
- 不准备回滚迁移：旧的按轮数截断已删除，问题用 forward-fix 处理。注意不要把 Backend 回退到本任务之前的版本——旧 Backend 依赖已删除的 SQL 截断，回退后窗口不再截断。
- 迁移是单事务，失败整体回滚；锁预算为 lock_timeout 5s、statement_timeout 60s。

## 14. 性能预算（2026-11-10 修订，用户要求：对聊天回复的额外等待 ≤ 100ms）

| 项                      | 实测/上限                                    | 说明                                                                               |
| ----------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| 记忆读取                | 用到时额外等待 ≤ 50ms（代码常量 + 单测锁定） | 在准备阶段就发出，与模型解析、开轮 RPC、上下文读取并行，通常早已落定               |
| 窗口计算                | 5 万字窗口 P95 ≈ 1ms（本机基准）             | 纯 CPU，无 IO                                                                      |
| 窗口前移 / 压缩请求写入 | 0（不等待）                                  | fire-and-forget；数据库客户端无连接池上限，不与其他查询排队                        |
| 后台压缩                | 0（异步）                                    | 单次最多读 100 轮，限制 JSON 解析占用事件循环                                      |
| prompt 长度             | 一般比旧策略短                               | 记忆 ≤ 5000 字，窗口正文 ≤ 6 万字（等待压缩时 ≤ 7 万字）；旧策略最多保留 75 轮全文 |

**先压缩、后截断（取代原方案"截断后接受空窗期"和"不规避记忆更新导致的缓存未命中"两条）**：超过高水位时先请求后台把将要移出的轮次压缩到 target_end，窗口暂不移动；下一轮读到记忆已覆盖时，窗口前移与新记忆同一轮生效。这样每个截断周期 prompt 前缀只变一次（与任何截断策略相同），不会因为记忆落地再多一次缓存未命中；同时没有空窗期。等待期间窗口最多超出高水位 (U-L)/2（默认 1 万字），超过后强制前移（压缩失败时退化为原方案行为）。总开关关闭时直接截断。
