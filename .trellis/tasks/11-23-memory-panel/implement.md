# 执行计划：记忆栏拆出正文模型

需求见 [prd.md](prd.md)，方案见 [design.md](design.md)，任务分解见 [task.md](task.md)。

## 1. 复用调研

| 检索过的                                                                                                                                                   | 结论                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/features/status-bar/update.ts`（`runStatusUpdate` / `maybeAutoUpdateStatus` / `inFlight` / 主通道→兜底→日志）                                     | **照抄结构，不抽公共框架**：记忆检查另起 `features/memory-bar/update.ts`，同样的进程内去重、主通道失败或没过校验转兜底、只记日志。两者校验和落库完全不同，强行抽象只会多一层。                                                                  |
| `backend/features/generation/status-bar-model.ts`（`callStatusModel(channel, {system,user})`，Gemini 首字 4 秒、DeepSeek 兜底、超时与 finish_reason 处理） | **直接复用**：记忆检查调用同一个函数，模型、超时、通道与状态栏一致；如需不同的输出上限，加一个可选参数，不复制。                                                                                                                                |
| `infrastructure/repositories/StatusBarRepository.ts`（`readSession`、`readRecentTurns`、`readEarlierUserInputs`、`readOverride/writeOverride`）            | **复用读轮次与会话**：记忆要的是 `[covered_turn-1, latest]` 最多 42 轮完整回复，新增一个按区间读的方法放进新的 `MemoryBarRepository`（避免 StatusBarRepository 超 500 行）；`readSession` 直接复用。玩家要求的读写仿 `writeOverride` 只写一列。 |
| `experience.chat_status_snapshots` + `get/record/undo_chat_status`（20261119_status_bar_v2.sql）                                                           | **照它建新表和 get/record 两个函数**（路径判定、同锚点软替换、权限）；不做 undo。不合表：状态和记忆是两件事，各自独立失败与重试。                                                                                                               |
| `shared/memory-bar/*`（本分支已有：schema / plan / prompt / apply，12 条单测）                                                                             | 后端只拼数据、调函数、落库。                                                                                                                                                                                                                    |
| `shared/status-bar` 的 `splitEditableReply`                                                                                                                | 喂记忆模型的回复正文用它剥掉尾巴（同状态栏）。                                                                                                                                                                                                  |
| `features/conversations/history.ts` 的 `stripStatusBlocks`                                                                                                 | 照写 `stripMemoryBlocks`。                                                                                                                                                                                                                      |
| `shared/text-postprocess` 三处旧状态栏隐藏                                                                                                                 | 照写旧记忆区隐藏。                                                                                                                                                                                                                              |
| `engine/render-instructions.ts` 的 `{{STATUS_RULES}}` 填空                                                                                                 | 同样处理 `{{MEMORY_RULES}}`。                                                                                                                                                                                                                   |
| `routes/status-bar.ts`、`service.ts`（VIP 判断、60 秒冷却、`STATUS_BUSY`）                                                                                 | 手动更新沿用同一路由与限制，service 里并行调两件事。新路由只加 `PUT …/memory-request`。                                                                                                                                                         |
| 前端 `components/status-bar/chat-status-panel.tsx`（293 行）、`lib/api/status-bar.ts`（2 秒轮询）                                                          | 面板内加记忆区组件（新文件 `memory-timeline.tsx`、`memory-request-sheet.tsx`），hook 复用同一个 query；入口条件从"状态来源不是 none"改为"状态或记忆有一个开着"。弹层复用现有 sheet 组件。                                                       |
| 20261119_status_bar_legacy_cleanup.sql                                                                                                                     | 清理迁移（退役 `memory_rules_mode` / `memory_rules`）照它的"读现行定义、只替换恰好一处"写法，放在发布观察之后。                                                                                                                                 |

## 2. 可靠性

- **超时**：模型调用沿用 `callStatusModel` 的首字 4 秒 + 总超时；库读写沿用仓库的 `timeout()` signal。
- **重试**：每次检查最多 2 次模型调用（主通道 + 兜底），不循环；失败就保持原记忆，下一个 3 轮自然再试。
- **幂等**：`record_chat_memory` 以 `(session_id, anchor_history_id)` 唯一（未作废行），同锚点重复写入取代旧行；手动撞自动由 `inFlight` 合并。
- **并发**：同一会话进程内只跑一个检查；多实例下极端情况两个实例同锚点各写一次，后写的取代前一个，结果仍是一份合法记忆（每份都是在读到的那份基础上整份校验过的）。读到旧记忆、写回时别人已写过：用 `p_expected_previous_id` 比对，不一致就放弃本次（记 `skipped`），下次再看。
- **事务**：record 函数内一次 UPDATE（作废同锚点旧行）+ INSERT。
- **降级**：记忆检查任何异常只记日志，不影响回复、不影响状态更新；面板读记忆失败时只显示状态部分并记 warn。
- **容量**：每会话每 3 轮最多一行（只在有进展时），每行 ≤ 4000 字；量级与状态快照相当（状态快照 48 小时约 2.2 万次读）。模型调用量：每 3 轮最多 2 次，Gemini 首发，比正文便宜两个数量级。
- **可观测性**：见 task.json `logging_integration`。

## 3. 最小充分

- 新文件：shared 已有 4 个；后端 `features/memory-bar/{update,service}.ts`、`MemoryBarRepository.ts`；前端 2 个组件；1 个迁移。不新增依赖、不新增 runtime_config key、不新增独立接口读记忆（并进状态接口）。
- 拒绝的过度设计：状态/记忆公共的"面板任务框架"；检查点表；记忆撤销；玩家编辑记忆；记忆版本历史页；任务队列（检查是回复后的轻量异步，进程内足够，丢一次等下个 3 轮）。

## 4. 演进与恢复

- **发布顺序**：迁移（只加表、函数、列）TEST → 生产 → 后端 + 前端同一次发布。迁移先上不影响旧代码。
- **切换点**：新后端一上线，正文模型就不再写记忆栏、老记忆区被隐藏、记忆面板开始工作。没有灰度（DAU 小，用户已定走最简路径）。
- **旧数据**：不批量迁移。每个老会话第一次检查时，把最近一条旧记忆区整理进前情概要（§5）。
- **停止条件**：发布后 24 小时内记忆检查失败率 > 30%，或用户反馈记忆大面积空白/乱写 → 回滚后端发布（Railway rollback）。新表留着无害；旧逻辑回来后正文模型恢复写记忆栏。
- **清理迁移**：观察 48 小时稳定后再退役 `memory_rules_mode` 列、`memory_rules` 托管 key 与模板校验占位；不可逆部分（列数据）已无读者。

## 5. 可验证性

### 自动

- shared：`pnpm --filter @miniapp/shared test`（含 memory-bar 12 条 + 新增旧记忆区隐藏、协议常量测试）。
- backend：记忆检查编排的失败路径单测——主通道超时转兜底、兜底也失败保持原记忆、没进展不写库、`expected_previous_id` 冲突放弃、开关关闭不检查、取模触发；`turnsToPromptMessages` 剥记忆区；`renderPlatformInstructions` 不再出现记忆规则；路由：非本人会话 404、要求超长 400、VIP 限制沿用。
- 契约消费者：`pnpm -r typecheck`、`pnpm lint:complexity`、`pnpm lint:backend-logging`、`pnpm lint:db-contract`。
- 日志：断言真实 Pino JSON 里有 outcome/计数/耗时，没有记忆正文、玩家要求原文、对话内容。

### 人工（TEST 环境）

1. 新会话聊 3 轮有进展 → 面板出现一段近档记录；再聊 3 轮闲聊 → 记忆不变。
2. 写记忆要求"着重记录我和 X 的关系" → 下一次检查的记录明显围绕 X。
3. 关掉记忆开关 → 不检查、面板无记忆区；卡没有状态栏 → 面板只有记忆。
4. 重新生成最后一轮 → 面板显示当前路径的记忆。
5. 老会话（带旧记忆区）→ 第一次检查后前情概要里有旧内容，老回复里的记忆区不再显示。
6. VIP 点「立即更新」：没进展时提示「这几轮没有新进展」；非 VIP 仍提示开通。
7. ui-tests 预览（`ST_UI_APP_PORT=3150 pnpm preview:ui`）加场景：近/中档时间线、更早的记忆展开、记忆要求弹层，手机宽度截图。

### 离线试跑（需用户同意）

- 只读生产对话，抽多人物卡（含房东模拟器）与普通卡若干会话，按真实节奏回放检查，结果写本地文件给用户抽看；聊天里只报统计，不贴对话原文。看：每条线写全、没进展不写、压缩保留要点、整份 ≤ 4000 字、兜底比例。

### 发布后

- 48 小时：记忆检查 outcome 分布、有进展比例、兜底比例、耗时 P95；`/chat/:id` 导航与状态接口 P95 对照基线。
