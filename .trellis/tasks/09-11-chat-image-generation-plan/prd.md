# 角色对话图片生成功能规划

## Goal

在角色最后一轮完整回复下增加“看看TA”，按语音链路口径拆成“默认写稿后出图”和“用户自定义原文出图”两条输入路径，再异步生成单张健康向图片；图片成功可用后才扣除运营配置的星尘，并永久绑定发起它的具体 assistant 回复。

## 产品范围

### 入口与描述

- 入口只出现在最后一轮、已完整完成、非开场白的 assistant 回复操作行，位于“生成语音”左侧；历史回复、生成中断/生成中的回复不展示。
- 点击后默认进入“写稿后出图”路径：先免费生成与当前角色、该条回复及近期对话氛围一致的一句中文画面描述，再由用户确认后送入图片生成模型。描述预览免费，失败可原地重试且不影响消息其他操作。
- 自动描述应克制、健康、可公开发布；用户可直接确认，也可“我来改改”，默认带入原描述。
- 用户改写/输入后进入“自定义原文出图”路径：确认时只使用用户提交的最终文本调用图片生成，不再调用写稿模型，不润色、不概括、不静默截断。
- 默认写稿产物与自定义描述 trim 后均须为 1~200 字；前端提示且禁止超限提交，后端执行同一权威校验。处理方式参考语音 300 字限制：shared 定义常量，route/feature 在受理与送模型前共用同一上限。
- 默认写稿参考 `shengtu_pipeline.py`：后端准备当前会话角色卡信息、`app_core.characters.character_persona_and_style`、生成风格和最近对话，用“视觉分镜师”系统提示词调用 DeepSeek 产出中文短文。
- 不管默认写稿还是用户自定义，用户可见、可编辑、入库主文本都必须是中文短文；调用 Grok 生图前再由 DeepSeek 做内部直译英文 prompt，英文 prompt 不展示给用户。
- 默认写稿在调用文本模型前，必须先在 `experience.chat_message_images` 创建 draft 阶段记录，并把 `draftImageDescription` 组装出的完整 `userPrompt` 保存到新增内部字段；模型调用失败也保留该记录用于审计，禁止先请求模型、后补写。
- 描述接口返回 draft id；用户确认生成时必须携带该 id，并由后端在 ownership、message 绑定和状态校验后，将同一行从描述阶段原子推进为 pending 图片任务，不再创建第二条 attempt。
- draft 阶段记录及新增 `userPrompt` 字段仅供 backend 审计/排障，不进入 shared 对外 attempt DTO、不返回前端、不写日志。其内容包含角色卡与近期对话，按消息正文同级敏感数据保护。
- `draftImageDescription` 与 `translateImagePrompt` 共用一个可运行时配置的 OpenAI-compatible 文本模型配置对象：请求 URL、API key、模型名称作为同一个 `app_core.runtime_config` JSON value 原子发布；temperature、max_tokens、thinking、messages 等请求参数保持当前实现不变。
- 运行时文本模型配置缺失或不合法时，整组回退到当前 `config.voice.draft` 的 DeepSeek URL/API key/model，保证默认行为与现状一致；不得把数据库 URL/API key/model 下发前端或加入 Admin managed config 清单。

### 出图与展示

- 确认按钮展示后端下发的当次价格；价格、可用性、限制和提示不得在前端写死。
- 确认后异步受理，只生成单张竖图；生成中禁止同一 attempt 重复提交，但允许离开会话。
- 成功图片固定展示在发起它的具体 assistant message 下方、语音上方；点击可查看大图。再次点击“看看TA”重新走描述确认并创建新 attempt，每次成功分别计费。
- 出图失败、超时或平台无法确认成功时不扣星尘，可按原描述重试或修改后重试。
- 星尘不足在面板内明确 required/available，提供充值入口；回跳保留 character、session、message 定位，不自动重新提交。

### 前端交互状态

- 图 1：入口在最后一条完整 assistant 回复操作行内展示，位于“生成语音”左侧，使用“看看TA”文案和图标；正文下方已有字数、语音、换一问答等操作时保持同一行秩序。
- 图 2：点击入口后立即打开底部 Sheet，并进入写稿加载态；背景聊天内容压暗，Sheet 展示“正在看看 TA 此刻的样子”、说明文案和加载动效，期间不允许重复触发入口或提交出图。
- 图 3：写稿成功后进入确认态，标题为“TA 此刻的样子”，展示生成的描述卡片；主按钮为“确认 生成图片 · {price_label}”，次按钮为“我来改改”，底部展示“出图失败不消耗”。
- 图 4：点击“我来改改”进入自定义编辑态，标题为“改成你想要的样子”，带说明“写完直接出图，系统不会替换或补充你写的内容。”；输入框带入原描述，显示当前字数和上限 200 字，主按钮为“按我写的生成图片 · {price_label}”。
- 图 5：确认生成后进入出图加载态，标题“正在出图”，展示大约耗时提示、进度/等待视觉、本次消耗价格和“失败不消耗”；主按钮置灰为“生成中...”，不可重复提交。
- 图 6：图片 ready 后展示在发起的 assistant 回复下方、语音入口上方；图片卡保持固定竖图比例，右下角提供放大图标按钮，卡片下方展示“=图生成 · {price_label}”和“已按你输入的描述生成；再点一次「看看TA」可换一张。”等状态说明，重新生成入口仍在原操作行。
- 图 7：点击放大按钮打开沉浸式预览层，顶部展示时间/状态胶囊和关闭按钮，中间展示大图；底部提示“长按图片可保存到相册”及来源描述。实施前需确认 Telegram WebView/SDK 的保存相册能力；若只能依赖系统长按菜单，应在规划验收中标记平台差异，不新增不确定的私有 API。
- 图 8：出图失败时在 Sheet 中展示失败态，包含“这张没出来”标签、“生成没有成功”标题、失败原因说明；主按钮“重试 · {price_label}”按原中文短文重新创建 attempt，次按钮“改一改描述”进入图 4。
- 图 9：生成前余额预检不足时在 Sheet 中展示余额不足态，包含“星尘不够”标签、“还差一点才能出图”标题、required/available 说明；主按钮“去充值”跳转现有充值流程，次按钮“先不要了”关闭 Sheet，不创建 attempt。

### 一致性与安全

- 计费口径为“Storage 中存在可读取图片，且数据库在同一事务内完成扣款、流水与 ready 收口后才算成功”；预检不等于实扣。
- 同一 attempt 最多扣一次；并发确认、worker 重领、前端重试不得重复扣费或错误覆盖另一张图。
- 自动描述和用户描述都经过平台既有内容安全边界；初版仅健康向出图，不做参考图上传、图生图、多图、站内相册/作品集、站内分享或运营审核后台。
- 外部模型密钥只存在 backend secret；日志、URL、Markdown、fixture 不记录密钥、完整中文短文、英文 prompt、完整对话或图片正文。
- 本次按明确需求允许图片写稿/翻译 API key 存在 `app_core.runtime_config`，但该 key 仍属于 backend-only secret：只能由 service role 读取，禁止进入 Admin 草稿/发布/审计快照、公开 DTO、日志和错误响应。数据库备份与运维访问按 secret 处理。

## 工程约束

- 只使用现有 packages 技术栈，主要改动 `backend`、`frontend`、`shared`；不新增独立服务、Redis 队列框架或前端状态框架。
- 对外 DTO 先落 `packages/shared/src/api/*`；前端通过 `src/lib/api/` React Query hooks 调用，不在组件直接 fetch。
- 模型调用、生成审计与计费编排扩展 `packages/backend/src/features/generation/`，不得在图片 feature 另建旁路。
- 运行时运营配置只通过 `platform/runtime-config.ts`；启动期 secret/endpoint 只通过 `platform/config.ts`。
- 图片写稿/翻译模型是上述 secret 规则的显式例外：三项参数从 `app_core.runtime_config` 经 `platform/runtime-config.ts` 读取；仅在缺失/非法时整组回退 `platform/config.ts` 的当前 DeepSeek 参数，不新增第二套 runtime_config 读取。
- 复用语音的“消息旁支产物、202 受理、会话批量回读、Storage、成功后原子扣费”模式，但图片必须使用可重启恢复的数据库任务租约，不照搬纯 fire-and-forget。
- 写稿和翻译若沿用语音同款 DeepSeek `deepseek-v4-flash`，应复用现有 DeepSeek 配置；只复用领域无关的结构化/普通文本调用、超时、解析和错误边界，不复用语音专属台词清洗、TTS 标签和朗读口径。
- 图片生成模型使用 Grok，经 Liaobots OpenAI-compatible images endpoint 调用；`LIAOBOTS_AUTH`、`LIAOBOTS_BASE`、`GROK_MODEL` 通过 backend config 配置，不下发前端，不把任何默认密钥写入源码或文档。
- Grok provider prompt 可参考 Python 的“角色锚点 + 英文场景 + 控制尾巴”结构；角色锚点来自 `character_persona_and_style`，健康向控制尾巴来自受控配置/常量，不直接套用 Python 示例里的固定性别外貌词。
- 初版不纳入 `shengtu_pipeline.py` 里的 Replicate/Z 降级，除非后续单独评审批准；主要新增工作集中在 Grok provider、中文到英文翻译、任务状态、Storage 与计费收口。
- 新增或修改的方法需在方法定义处添加说明职责、幂等/事务边界或失败语义的中文注释；显而易见的局部表达式不要求逐行注释。
- 按用户要求不新增 `*.test.*` 测试文件；仍须运行既有 typecheck/test/build，并完成可重复人工/接口验证。

## 明确不做

- 多图、组图、参考图、图生图、裁剪编辑、站内相册/作品集、站内分享、审核后台。
- 免费对话轮次抵扣图片费用。
- 用户自定义描述的二次润色或偷偷截断。
- 自定义原文出图时再次调用写稿模型。
- 将英文翻译 prompt 展示给用户，或用英文 prompt 替换用户确认的中文短文。
- 将外部参考 Python 中的默认 auth/token 写入源码、Markdown、日志或 fixture。
- 初版为图片任务引入 BullMQ、Kafka、独立 worker 部署或 WebSocket/SSE 推送。

## Acceptance Criteria

- [ ] 入口出现条件、位置及描述/确认/编辑/生成/成功/失败/余额不足状态与 PRD 和交互稿一致。
- [ ] 图 1~9 对应的入口、写稿加载、确认、自定义、出图加载、ready 展示、放大预览、失败重试、余额不足充值状态均有明确 UI 状态和可重复人工验收路径。
- [ ] 描述预览不扣费；description 阶段只创建不可被 worker 领取的 draft attempt，确认或编辑确认后才将其推进为可出图 pending，按钮价格来自 runtime config。
- [ ] 默认路径为空自定义输入时才调用文本写稿模型；自定义路径提交用户最终文本时跳过写稿模型，按原文出图、不二次加工。
- [ ] 自动描述与用户自定义描述都通过 shared 契约 1~200 字校验，并复用同一后端权威上限；超限不创建 attempt、不调用图片模型、不扣费。
- [ ] 默认写稿使用“视觉分镜师”系统提示词，并从当前角色卡读取 `character_persona_and_style` 与必要角色信息；字段缺失时有明确失败/兜底策略，不凭空造固定外貌锚点。
- [ ] 默认和自定义路径在调用 Grok 前都经过 DeepSeek 直译英文；用户界面、确认态和审计主文本仍保持中文短文。
- [ ] Grok/Liaobots 的 `LIAOBOTS_AUTH`、`LIAOBOTS_BASE`、`GROK_MODEL` 只经 backend config 使用；日志与前端响应不暴露鉴权、英文 prompt、Grok 原始响应或临时 URL。
- [ ] 图片结果绑定 `session_id + message_id`，离开再返回可通过会话批量查询恢复；多次生成保留 attempts，仅一个明确 current 展示版本。
- [ ] 图片成功可读后，数据库原子完成钱包扣费、ledger 和 attempt ready；失败、超时、余额竞争失败均不扣费。
- [ ] 创建 attempt、任务领取和扣费都有数据库级幂等/并发约束，进程重启不会永久卡 pending 或重复扣款。
- [ ] 所有外部调用均有超时；自动重试只覆盖可证明安全的阶段，模糊超时不自动二次出图。
- [ ] 日志包含 attempt/message/session 摘要、阶段、耗时、provider request id/错误码，不含中文短文、英文 prompt、对话正文、secret 或图片二进制。
- [ ] shared、backend、frontend 的既有 typecheck/test/build 按实施计划通过；不新增测试文件，并完成失败路径人工验收。
- [ ] 放大预览支持关闭、焦点恢复、移动端 safe area；保存相册能力按 Telegram 实际支持验证并记录平台差异。
- [ ] DeepSeek 配置复用结论、Grok provider 配置和外部流水线参考已在设计/实施记录中明确，功能上线后再更新模块现状文档。
- [ ] description 请求在任何文本模型网络调用前已创建 `chat_message_images` draft 行并持久化完整 `userPrompt`；通过可控上游超时/失败仍能查询到该审计行，且日志/响应不泄露其正文。
- [ ] description 成功返回 draft id；确认生成校验 draft 归属、session/message 绑定和允许状态，并原子复用同一行推进 pending；重复确认、跨用户/跨消息 draft id、失败 draft 均不能创建重复任务或扣费。
- [ ] draft 未确认、描述失败和长期遗留记录不被图片 worker 领取；有明确保留/清理口径，不占用“同一消息仅一个出图中 attempt”的约束。
- [ ] `draftImageDescription` 与 `translateImagePrompt` 使用同一组 runtime 文本模型 URL/API key/model，其他请求参数不变；三项均有效时使用 runtime 配置，任一缺失/非法时整组回退当前 DeepSeek 配置。
- [ ] runtime API key 只能由 backend service role 读取，不纳入 Admin managed keys、不进入 frontend/shared 响应、日志、错误、Markdown 或 fixture；配置轮换后新请求生效，既有运行中 attempt 按阶段语义安全收口。
