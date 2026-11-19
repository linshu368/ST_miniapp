# 状态栏 v2：实施计划

设计见 `design.md`。本文件只写怎么做、按什么顺序、怎么验证。开工前需用户确认本计划，并补齐 `task.json` 的 `mobile_performance` / `logging_integration` 后再 `task.py start`。

## 0. 已定决策速查

- 正文模型不再管状态栏；状态栏由独立模型生成，显示在聊天页**右侧状态面板**（雾面玻璃风格），收起时不显示数值。
- 更新：每 5 轮自动（从上次记录起算，所有人）+ 手动（**仅限 VIP**，限频 1 分钟 1 次）；**不消耗星尘**。
- 状态模型：主通道 DeepSeek 官方 `deepseek-v4-flash`（关思考，temperature 0.3）；兜底为模型目录的通用兜底（默认 `deepseek/deepseek-v4.1-flash-1017`，OpenRouter）。
- 喂入：上次记录 + 最近 5 轮完整对话（每轮标【新】/【已计入】）+ 更早的玩家输入（每轮 100 字、合计 3000 字）+ 角色简介 / 主角人设 / 补充设定 / 状态栏定义。
- 创作者：建卡栏目，AI 一键生成 / 帮写说明 / 补全说明 / 一句话改，用 `google/gemini-4-carbon`（同 AI 润色），不兜底、不扣费。
- 玩家：工具箱第三张卡"状态栏"，在预览卡上点着改，只对自己和这张卡；**玩家侧不加 AI**（用户定，出于成本），说明靠写法提示和校验保证质量。
- 生效优先级：玩家覆盖版 > 卡版本自带 > 自动（没有状态栏的旧卡）。
- 上限：≤12 项、名称 ≤8 字、每条说明 ≤200 字、定义合计 ≤3000 字。

## 1. 复用调研

| 现有资产                                                                                 | 用法                                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `shared/text-postprocess/rich-reply.ts` 的面板解析与渲染                                 | 只保留给**旧消息**里的状态栏；新状态栏不走这条链路                                         |
| scratchpad 原型 `status-v2/parse.mjs`、`examples.mjs`、`status_prompt.mjs`               | 移植成 `packages/shared/src/status-bar/`（解析、定义文本、提示词组装、校验）               |
| `platform/config.ts` 的 `voice.draft`（DeepSeek 凭据）与 `voice-draft.ts` 的关思考做法   | 状态主通道复用同一组环境变量；把配置提到 `deepseek` 公共段（写稿和状态栏共用），不新增 key |
| `model-catalog.ts` 的 `fallback_model_id` + `resolveFallbackProviders`                   | 状态兜底直接读，和正文首字兜底同源                                                         |
| `creator-polish.ts`（OpenRouter `gemini-4-carbon`、非流式错误文案）                      | 创作者 AI 生成/改写复用调用方式与错误文案                                                  |
| `turn-execution.ts` 中 `done` 之后的 `void persistRichReplyDiagnosis(...)`               | 同一位置挂 `void maybeAutoUpdateStatus(...)`，不拖慢回复                                   |
| `UserPersonaRepository` / `user_character_preferences` / `get_character_prompt_settings` | 玩家覆盖版放同表新列；读取补充设定、主角人设复用现有 RPC                                   |
| `character_versions.runtime`（会话按版本绑定）                                           | 作者的状态栏写进 `runtime.status_bar`，随卡版本走                                          |
| `chat_branch_turns.source_history_id`                                                    | 分支会话没有自己的记录时，回溯父会话分叉点之前的记录                                       |
| 工具箱 `ChatCharacterModules` / `ModuleCard`                                             | 加第三张卡（鼠尾草绿 `--success`）                                                         |
| 创作者编辑器 `character-editor.tsx` 的栏目结构、AI 润色交互                              | 加"状态栏"栏目，沿用"恢复上一版"交互                                                       |

不复用：`story_memory_jobs` 任务表。自动更新失败只需"下一轮再试"，不需要租约和重试表（见 §4.3）。

## 2. 共享层 `packages/shared`

新建 `src/status-bar/`（每个文件 <500 行，函数 <120 行）：

1. `schema.ts`：状态栏模板 zod 契约。
   - 分区 1–4；方式 `fixed | repeat{what, max 1–3}`。
   - 项目 ≤12：`name` ≤8 字、不含标点和 `：【】[]<>`；`style` 是 10 种之一；样式参数（max / total / unit / stages 2–8）；`desc` 8–100 字；`init` 可选。
   - 定义合计 ≤3000 字（refine）。
2. `parse.ts`：v2 行解析，从原型移植，含恶意输入耗时测试。
3. `definition.ts`：骨架、样式写法短语、定义块文本。
4. `prompt.ts`：状态模型的 system 提示词常量与 user 消息组装（输入是纯数据，不做 IO）。
5. `validate.ts`：按模板校验输出，给出问题清单；缺项沿用上次记录的合并函数。
6. `examples.ts`：7 套成人向示例（创作者"从示例开始"用）。

API 契约 `src/api/status-bar.ts`：读取状态、手动更新、撤销、玩家覆盖读写；创作者的生成/改写请求与响应。`CharacterDraftSchema` 增加可选 `statusBar` 字段。

测试：把原型的用例搬进 vitest（零件判定 28 例、任务型/人物型、跑偏写法、散文不恢复、HTML 当文字、12 种恶意输入 <50ms），再加模板校验、合并、提示词组装各几例。

## 3. 数据库（一个 migration：`2026xxxx_status_bar_v2.sql`）

落位按 `docs/db/CONTRACT.md`，同一 PR 更新 `registry.yaml`。

| 对象                                                               | 坐标                                               | 内容                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_core.user_character_preferences.status_bar_detail jsonb NULL` | app_core × S（同表同性质、同写入模块、同生命周期） | 玩家对这张卡的状态栏覆盖版；CHECK 大小 ≤ 16KB；NULL = 用卡自带                                                                                                                                                                                                                                |
| `character_versions.runtime` 新键 `status_bar`                     | app_core × E（卡内容，随版本不可变）               | 作者的状态栏；无 DDL，registry 记 jsonb 键                                                                                                                                                                                                                                                    |
| `experience.chat_status_snapshots`                                 | experience × D（由对话派生，同 `story_memories`）  | `id`、`session_id`、`user_id`、`anchor_turn_index`、`anchor_history_id`（FK chat_history）、`status_text`（≤8000 字）、`template_source`（card/player/auto）、`trigger`（auto/manual）、`discarded_at`（撤销）、`created_at`；索引 `(session_id, created_at desc)`；RLS 开，只授 service_role |
| `experience.get_chat_status(p_session_id)`                         | 函数                                               | 返回当前路径上最近一条未撤销记录：本会话里锚在"每轮当前版本"上的记录优先；没有就看分支继承的 `source_history_id`；都没有返回空（前端显示开局值）                                                                                                                                              |

迁移验证：仿照 `scripts/test-character-persona-migration.sh`，用一次性 PG 跑以下场景：

- 写入、读取最新；
- 重新生成后，旧版本上的记录不再算"当前"；
- 分支继承；
- 撤销；
- 权限（anon / authenticated 无权）。

执行顺序：先 TEST 再生产，生产需用户确认。回滚：DROP 新表、函数、新列（数据可丢：只是派生状态和玩家覆盖版）。

## 4. 后端 `packages/backend`

### 4.1 `features/status-bar/`

- `repository.ts`：快照的读写和撤销、玩家覆盖版读写；所有调用 5 秒超时。
- `template.ts`：解析当前生效模板：玩家覆盖 > 版本 `runtime.status_bar` > 自动。
- `inputs.ts`：组装喂入：
  - 最近 5 轮正文（去掉旧的富文本尾巴）和更早的玩家输入，复用历史仓库读当前路径；
  - 角色简介，以及补充设定、主角人设（复用 `get_character_prompt_settings`）；
  - 上次记录。
- `model.ts`：主通道 DeepSeek（关思考，30 秒超时）→ 兜底 OpenRouter 通用兜底；最多 2 次调用；第 2 次在输出不合格时附问题清单。
- `update.ts`：校验、缺项沿用上次、落库；同一会话进程内加"进行中"去重；落库前比对最新锚点，避免手动和自动同时写出两条。
- 日志：`status_bar.update`，字段包括 trigger、templateSource、gapTurnCount、inputCharCount、attemptCount、fallbackUsed、matchedCount、expectedCount、durationMs、outcome，不记任何内容。

### 4.2 路由（每个注册保留 `@frontend-ready` 注释）

- `GET /api/conversations/:sessionId/status`：当前状态、生效模板（开局值用）、`updating` 标记。
- `POST /api/conversations/:sessionId/status/refresh`：手动更新。同步等待，上限 65 秒；限频 1 分钟 1 次；不扣星尘。
- `POST /api/conversations/:sessionId/status/undo`：撤销最近一次。
- `GET/PUT/DELETE /api/characters/:characterId/status-bar`：玩家覆盖版的读、存、"恢复作者的版本"。
- 创作者：`POST /api/creator/characters/:id/status-bar/{generate,describe,edit}`，用 `gemini-4-carbon`，不兜底。

### 4.3 自动更新

`turn-execution.ts` 在 `done` 之后，仅当回复成功时调用 `void maybeAutoUpdateStatus(...)`，满足以下条件才更新：

- 玩家没关"状态栏"总开关；
- 这张卡有状态栏，或走自动模式；
- 距上次记录满 5 轮。

失败只记日志，下一轮回复结束后条件仍满足，会自然再试一次。不建任务表，进程重启丢一次也会在下一轮补上。`done` 事件附 `status_update_scheduled: true`，前端据此轮询 `GET status`（每 2 秒，最多 60 秒），拿到后亮"新"点。

### 4.4 正文模型去掉状态栏

- 平台规则：状态栏槽位固定为"不输出状态栏"；协议常量删掉状态栏条款；`turn-execution` 的富文本诊断不再期待 status。
- 主体模板 v18 改几行（模块顺序、机器标签说明）。走运营 CLI 发布，需用户确认差异。
- 旧消息里的状态栏照常由 rich-reply 渲染。

## 5. 前端 `packages/frontend`

1. `components/status-bar/`：
   - 状态内容渲染：React 组件吃 shared 的解析结果，雾面玻璃样式用 Tailwind，不再受 text-rules 的 CSS 白名单限制；
   - 编辑弹层：名称、类型、样式缩略图、设置、开局值、说明，带"已用 N/12"和说明计数。创作者和玩家共用。
2. 聊天页：
   - 右侧入口标签：中下拇指区；键盘弹起时隐藏；第一次进卡弹一次提示气泡（localStorage 记，异常时不弹）。
   - 状态抽屉：右滑跟手收起（只认横向）、从入口左滑打开、点外面或"收起"关闭；Telegram 返回键先关抽屉；遵循减少动态效果。
   - "新"点：localStorage 记最后看过的快照 id。
   - 状态数据懒加载：不进聊天页首屏的关键路径。
3. 工具箱"对话设置"：加"状态栏"卡（鼠尾草绿），里面是预览卡，点着改，有"撤销"和"恢复作者的版本"。
4. 创作者编辑器：在"预设"后、"标签"前加"状态栏"栏目，必填：
   - 生成：AI 一键生成、6 套示例、从空白开始、换一套 / 不换了 / 恢复上一版；
   - 补说明：AI 补全说明、一句话让 AI 改。
5. React Query hooks 放 `src/lib/api/status-bar.ts`，组件里不直接 fetch。

## 6. 验证

- 必跑：shared 测试；全部消费者 typecheck；backend 相关测试；`pnpm lint:complexity`；`pnpm lint:db-contract`；frontend build。
- 失败路径：
  - DeepSeek 超时或报错 → 走兜底；
  - 两次都不合格 → 部分沿用；
  - 全失败 → 保留原状态；
  - 限频生效；
  - 撤销后读到上一条；
  - 重新生成正文后显示旧记录；
  - 分支继承；
  - 关总开关后不生成。
- TEST 环境（development，免登录）：
  - 真实走一遍：建卡生成状态栏，聊 5 轮自动更新，手动更新，撤销，玩家覆盖与恢复；
  - 测完删数据。
- 离线评测（上线前）：
  - 范围：两个模型 × 7 套示例 × 隔 1 / 5 / 12 轮，用自写的成人向对话样本，不读生产对话；
  - 指标：格式严格通过率、项目名命中率、阶段乱跳、重复计算、数值走向；
  - 目标：严格通过 ≥95%、命中 ≥95%；
  - 不达标就先改提示词再评。
- UI 回归：在 `packages/ui-tests` 增加状态面板场景：开合、右滑、更新中、"新"点、撤销。按规定提醒是否纳入本地验收。

## 7. 待用户确认

1. 本计划的切分与发布顺序。
2. （零成本建议）玩家说明栏的"填空模板"：按样式插入一句带空格的模板，玩家只填空，不调用模型。

## 8. 发布顺序

1. 迁移：先在 TEST 执行，再验证。
2. 代码合入 dev，在 development 环境验证。
3. 离线评测达标。
4. 生产迁移（需确认）。
5. 发布分支合 main（需确认）。
6. 运营发布主体模板改动（需确认差异）。
7. 观察 24 小时：`status_bar.update` 的成功率、兜底比例、耗时 P95，以及正文首字耗时是否受影响。

回滚：前端可以整块隐藏状态面板。主体模板回滚到 v18 会恢复旧状态栏。新表和新列独立，不影响聊天。
