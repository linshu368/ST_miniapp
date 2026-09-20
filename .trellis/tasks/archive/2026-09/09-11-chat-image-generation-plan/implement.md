# 图片生成功能实施计划

## 评审门禁

- 产品确认：默认/自定义两条图片输入路径、`1024x1536`、健康向策略、200 字上限及初始价格。
- 模型确认：写稿/翻译使用 DeepSeek，若与语音同为 `deepseek-v4-flash` 则复用现有 DeepSeek 配置；图片 provider 使用 Grok via Liaobots。
- 工程确认：数据库任务队列而非语音 fire-and-forget；成功后结算，余额竞争失败删除产物。
- 运维确认：test/prod 分别配置 `LIAOBOTS_AUTH`、`LIAOBOTS_BASE`、`GROK_MODEL`、DeepSeek env、Storage bucket、runtime config；除用户明确要求由 Admin 管理的图片文本模型 API key 外，不把 secret 写入文档或 Admin。
- 追加确认：description 调用前创建并复用同一 draft 行；`description_user_prompt` 为 backend-only 敏感审计字段。图片写稿/翻译 runtime API key 是“secret 进入 runtime_config”的显式例外；按最新要求进入 Admin managed config，并在 UI 预览中脱敏。

## 实施顺序

1. **Shared 契约**：新增 image DTO/Zod、错误码、`MAX_IMAGE_PROMPT_CHARS = 200` 和 exports；保持公开字段可兼容扩展，并对齐语音 300 字限制的“shared 常量 + 后端权威校验”模式。
2. **Migration**：新增 experience attempt 表、索引、RLS/grants、claim RPC；attempt 保存 `prompt_cn`，可保存内部 `prompt_en/provider_prompt` 审计字段；新增 billing 原子结算 RPC/ledger 类型；提供独立 rollback 文件和锁/容量说明。
3. **角色数据准备**：扩展 `CharacterCardRepository` 或新增图片读模型，按会话 `character_id` 读取 `character_persona_and_style` 和必要角色卡字段；确认 110 migration 在目标环境的执行状态，字段为空时按评审策略失败或兜底。
4. **Backend generation 基建**：在统一出口增加 DeepSeek 分镜写稿、DeepSeek 中文直译英文、Grok/Liaobots provider adapter、角色锚点 + 英文场景 + 控制尾巴的 provider prompt 组装和结算入口；复用语音 DeepSeek 配置/transport 时避免引入语音台词清洗；所有公开方法在定义处写中文注释，明确职责、超时、幂等和模糊失败语义。
5. **Backend image feature/route/job**：实现 config/description/session query/create；默认路径用“视觉分镜师”系统提示词写中文短文，自定义路径直接保留用户最终中文短文且不走写稿；两路调用 Grok 前都先 DeepSeek 直译英文；注册 `@frontend-ready` 路由与 runner；日志只使用 allowlist。
6. **Frontend API**：集中 image query keys/hooks，pending 时 1.5~2 秒轮询，终态和后台停止；余额成功扣除后精确刷新 wallet；前端只处理中文短文，不接收英文翻译 prompt。
7. **Frontend 组件与图稿状态**：
   - `ChatImageSheet`：面板状态编排；props 为 session/message/config/open，events 为 close/recharge/completed。
   - 图 1：在最后完整 assistant 回复操作行、“生成语音”左侧增加“看看TA”入口。
   - 图 2：入口点击后进入写稿 loading Sheet，压暗聊天背景，禁止重复提交。
   - 图 3：写稿成功确认 Sheet，展示描述、确认生成按钮、价格和“我来改改”。
   - 图 4：`ChatImagePromptEditor` 进入自定义编辑态，受控 prompt、字数/200 上限；自定义提交后不请求 description API。
   - 图 5：确认后进入“正在出图”加载态，主按钮置灰，显示本次价格与失败不消耗。
   - 图 6：`ChatMessageImageFooter` 渲染 ready 图片卡、费用/状态文案、右下角放大图标；重新生成仍使用原操作行“看看TA”。
   - 图 7：`ChatImageViewer`：Dialog 大图、alt、关闭、safe area、长按保存提示；实施前验证 Telegram 保存相册能力或系统长按菜单差异。
   - 图 8：失败 Sheet，主按钮按原中文短文重试，次按钮回到编辑态。
   - 图 9：余额不足 Sheet，主按钮跳现有充值流程，回跳定位但不自动重新提交。
   - Chat page 仅组合 hooks 并通过现有 `renderFooter` 按“图片在上、语音在下”注入。
8. **文档/发布**：补 env example、runtime config 管理项、ARCHITECTURE；记录外部流水线参考与“视觉分镜师”prompt 版本；test 验证后再更新 module spec 的“当前状态”。
9. **追加兼容 Migration**：新增日期命名 forward migration，为 `experience.chat_message_images` 增加 `description_user_prompt`，扩展 draft 状态并使 `prompt_cn/prompt_source` 仅在 draft 阶段可空；重建状态相关 CHECK、claim 条件和权限自检。规划单个 `image_text_model_config` JSON key 的 shape，不写真实 API key；按最新要求加入 Admin managed key、draft/release CHECK 与 DB 校验。说明表锁、既有行兼容、容量、rollback guard 与 forward-fix。
10. **Draft 生命周期与契约**：shared description 响应增加 `draft_id`，确认请求增加 `draft_id`；repository 增加 createDraft/markDraftReady/markDraftFailed/confirmDraft 原子状态方法（优先 DB RPC/条件更新防 TOCTOU）。把当前 `draftImageDescription` 内的 userPrompt 组装提取为可先构建的函数；route 组装后先落 draft，成功提交后才把同一字符串传给模型；失败保留 draft。frontend 保存 draft id 并随确认/编辑提交，刷新/关闭后的废弃 draft 不进入 worker。
11. **可配置文本模型**：在 `features/image/config.ts` 通过 `fetchRuntimeConfigEntry('image_text_model_config')` 读取同一 JSON 对象中的 URL/API key/model，严格校验并按整组回退 `config.voice.draft`；将同一 resolved tuple 传给 description 和 translation。`callDeepSeek` 除 endpoint/auth/model 外请求参数保持不变；日志只记录 runtime/fallback 来源与安全错误码，不记录 value。
12. **追加发布记录**：同步任务 research、架构/模块事实（实施完成后），先 test migration 和双端部署、开关保持关闭；完成 draft 状态、配置切换/回退、secret 泄露扫描和 consumer 验证后才允许灰度。

## 可执行验证

按用户要求不新增测试文件，但运行既有测试：

```bash
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm -r typecheck
```

Migration 在 test 环境逐文件执行并记录：执行前后表/RPC shape、RLS/grants、claim 并发、结算幂等、余额不足、锁等待、rollback。不得因“规划通过”直接执行生产 migration。

追加 migration 还需验证：既有 pending/ready/failed 行约束不变；draft 可在 `prompt_cn/prompt_source` 为空时插入；非 draft 状态拒绝空 prompt；worker 不领取 draft；跨用户/跨 message 确认失败；description 上游失败后 draft 仍在；runtime API key 只对具备对应环境权限的 Admin 与 backend 可见，C 端不可见且 Admin 预览脱敏。

## 人工与接口场景

- 入口：开场白/历史/streaming/中断均隐藏；最后完整回复显示。
- 描述：成功、空响应、格式错误、超时、内容拒绝；均不扣费。
- 确认：默认原描述直接确认走写稿结果出图；自定义 1/200/201 字、空白、双击、两个设备并发；自定义路径确认后不再触发写稿模型。
- 写稿/翻译：默认路径用角色 `character_persona_and_style` + 角色卡信息 + 最近上下文写中文短文；默认/自定义两路调用 Grok 前均直译英文，provider prompt 按“角色锚点 + 英文场景 + 健康向控制尾巴”组装，用户界面仍只显示中文短文。
- 配置：缺 `LIAOBOTS_AUTH`、`LIAOBOTS_BASE`、`GROK_MODEL` 或 DeepSeek key/model 时功能 disabled/503，不创建 attempt；确认日志不含 secret、中文全文、英文 prompt 或 Grok 原始 URL。
- 任务：受理后离页/切会话/刷新；pending、provider 前重启、provider 模糊超时、Storage 失败、runner 多实例抢占。
- 计费：预检不足、预检后余额被抢、结算 RPC 重放、对象删除失败；对拍 wallet/ledger/attempt。
- 展示：多次生成 current 切换、旧 attempt 保留、图片/语音顺序、大图关闭、窄屏/软键盘/safe area/reduced motion。
- 图稿：逐项对照图 1~9 验收入口、Sheet 高度/压暗层、按钮层级、字数提示、结果卡位置、放大按钮、预览层和长按保存提示。
- 回跳：充值后回到原 character/session/message，不自动提交。
- 调用前落库：用可控 stub/无效上游验证 fetch 尚未发出前 draft insert 已提交；网络超时/HTTP/解析失败后行转 `draft_failed`，`description_user_prompt` 存在但 API/日志不返回正文。
- Draft 并发：双击 description、同消息多次重新写稿、两个设备同时确认同一 draft、确认其他用户或其他 message 的 draft、重复确认；确保只有一次推进 pending，旧/失败 draft 不被 worker 领取也不扣费。
- 模型配置：单个 runtime JSON 对象三项全有效时 description/translation 都使用该 tuple；分别模拟 URL/API key/model 缺失或非法，验证整组回退当前 DeepSeek；原子修改该行 version/value 后新请求生效；请求体除 model 外与当前参数一致。
- Secret 扫描：C 端 shared DTO/frontend bundle、Admin 确认与发布历史 UI、pino/Sentry、错误响应及 git diff 中均不得出现 runtime API key 或 `description_user_prompt` 正文；Admin 受权 RPC 的配置 payload 是用户要求的唯一管理通道。

## 发布与恢复

- test：migration → bucket → DeepSeek 与 Liaobots backend secret/config → backend → frontend → 开关 → smoke。
- production：复核 test 证据、角色 `character_persona_and_style` 覆盖和 Grok 配置，逐项重复，先保持开关关闭；小流量开启并观测成功率、P95、429、失败码、扣费不一致、孤儿对象。
- 回滚：先关开关；让 runner 收口已接单任务；回退应用。已产生记录和账务不删除，异常数据用审计脚本 forward-fix。
- 追加变更发布：forward migration → backend/frontend 同批兼容发布（开关关闭）→ 配置 backend-only runtime tuple 或保留默认 fallback → test 验证 → 灰度。停止条件增加 draft_failed 激增、draft 长期堆积、runtime/fallback 切换异常；回滚不删除新增列或 draft 行。
