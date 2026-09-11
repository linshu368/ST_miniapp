# 角色对话图片生成功能技术方案（评审稿）

> 状态：待产品 / 工程 / 运维评审，尚未实施。
> 范围：`packages/backend`、`packages/frontend`、`packages/shared`，以及对应 migration、Storage 与运行配置。
> 产品输入：`MiniApp 图片功能构建与初版 UI`（2026-09-11 提供）及配套状态图。

## 1. 评审摘要

本方案复用现有语音链路的产品形态和稳定原语：图片是 assistant message 的旁支产物，使用 202 异步受理、会话级批量查询、Supabase Storage、成功后原子扣费和 React Query 条件轮询。图片生成比语音更慢、供应商 POST 更难安全重试，因此**不照搬语音的纯进程内 fire-and-forget**，改用 PostgreSQL attempt 表 + `FOR UPDATE SKIP LOCKED` 租约作为最小持久任务队列。

推荐初版：OpenRouter 文本模型免费生成中文画面描述；OpenAI Images API `gpt-image-1` 生成 `1024x1536` 单张竖图；默认展示价 12 星尘但以 runtime config 为准。图片上传成功后，通过一个数据库 RPC 原子完成钱包扣款、ledger、幂等墓碑和图片 ready/current 收口。失败、模糊超时或结算时余额不足均不扣费、不展示结果。

## 2. 产品口径到工程约束

| 产品口径             | 工程落点                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 只在最后完整回复显示 | 后端每次 description/create 均校验 ownership、assistant、最新 turn/revision、status=completed；前端只做同口径展示 |
| 描述免费             | description 调用 generation 文本能力，但不进入 quota/钱包结算                                                     |
| 用户改什么就画什么   | create 保存 trim 后原文快照；只做校验/安全审核，不润色、不截断                                                    |
| 成功才扣费           | Storage 可读后调用原子 settlement RPC；预检只改善体验，不构成扣款                                                 |
| 失败不消耗           | failed/failed_unknown 不调用 settlement；已上传但结算失败则补偿删除                                               |
| 图片挂在该回复下     | attempt 外键绑定具体 `chat_history.id`，不只绑定 turn/session                                                     |
| 每次重新消耗         | 每次确认创建新 attempt；`attempt.id` 是独立 charge key                                                            |
| 离开后回来可见       | 会话 images query + DB 持久任务；前端仅 pending 时轮询                                                            |

## 3. 现状与复用调研

### 3.1 可直接复用

- Shared `voice.ts` 的旁支产物契约、202 返回和会话批量聚合模式。
- Frontend `lib/api/voice.ts` 的 domain query key、message map、pending 条件轮询和 mutation 防重复模式。
- Chat page 的 `renderFooter(message)` 注入点，以及消息详情 query 在刷新/离页后的服务端收敛方式。
- Backend route 的 Telegram 鉴权、ownership、结构化错误和 `@frontend-ready` 规范。
- `platform/runtime-config.ts` 的 TTL/version/降级读取与 Admin managed config 发布方式。
- Supabase Storage 的服务端上传/删除模式。
- 语音结算曾使用的“产物可用后，以业务行 ID 幂等扣费并在同一事务收口 ready”语义。

### 3.2 只复用思路、不直接共表/共类型

- 不把图片放进 `experience.chat_message_audio`；媒体属性、失败阶段和展示规则不同。
- 不把 image DTO 塞进 `voice.ts`；新增 `shared/src/api/images.ts`，避免形成含糊的通用媒体契约。
- Storage 可抽取“安全路径 + upload/remove”小原语，但首版可保留薄的 `chat-image-storage.ts`；不建立通用媒体框架。
- `features/generation/execute.ts` 是聊天 SSE 专用，不能硬塞图片分支；在同目录增加明确的 text-json/image 原语和 settlement facade。

### 3.3 明确不复用

- 对话免费角色轮次：图片始终按成功次数消耗星尘。
- 语音纯 fire-and-forget：进程退出会遗留 pending，无法满足图片离页/重启恢复。
- `billing.llm_usage_charges` 的文本模型字段形状：图片账务使用专用 dedup/charge 或可辨识的 usage kind，避免污染文本 finish_reason 语义。

## 4. 总体链路

```text
点击“看看TA”
  -> POST image-description
  -> generation.generateStructuredText（不扣费）
  -> 面板展示 description
  -> 用户确认/编辑确认
  -> POST images（余额预检 + 原子创建 pending attempt）
  -> 202
  -> DB job runner claim
  -> generation.generateImage（有总 deadline，不安全自动重投）
  -> 校验 MIME/尺寸/大小
  -> Supabase Storage upload
  -> billing.settle_image_generation(attempt.id)
       wallet lock + debit + ledger + dedup + attempt ready/current
  -> Frontend session images polling 收敛
  -> 图片显示在对应 message 下
```

## 5. Shared API 契约草案

新增 `packages/shared/src/api/images.ts`，所有接口继续使用现有 envelope；402 可在兼容现有 client 的前提下统一携带 `required`、`available`。

```ts
type MessageImageStatus =
  | 'pending'
  | 'generating'
  | 'storing'
  | 'ready'
  | 'failed'
  | 'failed_unknown';

interface MessageImage {
  id: string;
  message_id: string;
  status: MessageImageStatus;
  image_url: string | null;
  width: number;
  height: number;
  prompt_source: 'generated' | 'custom';
  error_code: ImageErrorCode | null;
  credits_charged: number;
  is_current: boolean;
  created_at: string;
}
```

公开 response 不返回 `storage_path`、provider 原始响应、完整 prompt、lease 或内部重试字段。建议接口：

| Method / Path                                 | Request                     | Response / 语义                                     |
| --------------------------------------------- | --------------------------- | --------------------------------------------------- |
| `GET /api/v1/image/config`                    | -                           | enabled、价格/标签、prompt 上限、安全提示、展示尺寸 |
| `GET /api/v1/conversations/:sessionId/images` | -                           | 会话内按 message 聚合的 current + latest attempt    |
| `POST .../:messageId/image-description`       | 可选空 body                 | `{ description }`；同步等待，明确超时，不扣费       |
| `POST .../:messageId/images`                  | `{ prompt, prompt_source }` | `202 { image }`；pending attempt                    |

错误码至少区分：`image_unavailable`、`image_description_failed`、`image_prompt_invalid`、`image_content_rejected`、`image_generation_failed`、`image_generation_unknown`、`image_storage_failed`、`image_insufficient_balance`、`image_already_pending`、`image_message_not_eligible`。

## 6. 数据模型与数据库边界

### 6.1 `experience.chat_message_images`

一行即一次确认后的出图 attempt。核心约束：

- FK/ownership 快照：`user_id`、`session_id`、`message_id`；`message_id` 指向具体 assistant revision。
- `unique(message_id, attempt_no)`；attempt_no 在 message 锁/RPC 内分配。
- partial unique：同 message 至多一个 active attempt（pending/leased/generating/storing），避免双击并发。
- partial unique：同 message 至多一个 `is_current=true` 的 ready 图。
- `check` 约束限定状态、正价格、正尺寸、ready 必备 storage/url/charge 数据。
- prompt 是业务审计输入，受 200 字上限；不写日志，不进入公开批量 response。

表归属 `experience`。浏览器不直连，RLS 默认拒绝；只授予 backend service role 必要访问，通过 repository/RPC 使用。

### 6.2 账务对象

建议新增图片专用 `billing.image_generation_charges` 与永久 dedup 墓碑，或在现有通用 ledger 上新增明确 `image_generation` 类型。不要复用带 `generation_id/finish_reason/reply_outcome` 的文本 LLM charge 行。

`billing.settle_image_generation` 使用 `SECURITY DEFINER`、固定 `search_path`、撤销 public/anon/authenticated execute，只授 service role。RPC 同事务：锁 attempt → 锁钱包 → 幂等判断 → 校验快照/结果 → 扣余额 → ledger/charge/dedup → current 切换 → ready。

### 6.3 Storage

- bucket：`miniapp-chat-images`，实施前在 test/prod 分别确认创建和策略。
- 路径：`{userId}/{sessionId}/{messageId}/{attemptId}.{ext}`；ID 均由服务端事实生成。
- 对象只由 service role 写/删。读取方案优先私有 bucket + 短期签名 URL；若沿用语音公共桶，需明确用户可转发 URL 的隐私风险后另行批准。
- 数据库保存稳定 `storage_path`，API 查询时生成签名 URL，避免长期 URL 过期成为事实字段。
- 限制 MIME allowlist、最大输出字节数和声明尺寸；禁止把 base64/二进制放数据库。

## 7. 模型与配置

### 7.1 描述模型

- 走现有 OpenRouter 上游与 `LLM_API_KEY`，模型由 `image_description_model` runtime config 选择，不跟随用户聊天模型。
- 输入仅取生成描述所需的有限信息：角色名/必要人设摘要、目标 assistant 回复、最近有限轮对话；不发送整段 prompt 快照。
- 系统要求一句简体中文、健康向、可公开、只描述画面；结构化返回 `{ "description": "..." }`。
- 模型空响应/非法 JSON 可做一次同请求语义的解析修复或明确失败；总 deadline 不因重试重置。

### 7.2 图片模型

- 推荐 provider：OpenAI Images API；模型：`gpt-image-1`；secret：`OPENAI_API_KEY`。
- endpoint、timeout、最大响应大小由 `platform/config.ts` 启动期校验。缺 key 时 config 返回 disabled/路由 503，不能带病受理。
- 默认尺寸 `1024x1536`，单张，WebP；若 provider 实际 response 只提供 PNG，可原样保存并返回真实 MIME，不为初版引入图像转码依赖。
- 用户最终 prompt 原样进入图片请求的用户描述字段；平台健康向 policy 可作为独立 system/policy 输入，但不能改写用户文本后冒充原文。

### 7.3 Runtime config

建议 managed keys：

| Key                            | 初始建议             | 说明                           |
| ------------------------------ | -------------------- | ------------------------------ |
| `image_generation_enabled`     | `false`              | 发布总开关                     |
| `image_generation_credits`     | `12`                 | 单次成功扣费                   |
| `image_price_label`            | `12 星尘`            | 前端展示，仍与数值做一致性校验 |
| `image_description_model`      | 评审时从现有目录选定 | 免费描述模型                   |
| `image_generation_model`       | `gpt-image-1`        | 图片模型                       |
| `image_width` / `image_height` | `1024` / `1536`      | 初版固定竖图                   |
| `image_max_prompt_chars`       | `200`                | shared/backend 权威上限        |
| `image_max_output_bytes`       | 工程压测后定         | 下载/上传容量闸门              |
| `image_prompt_policy`          | 健康向模板           | 自动描述与出图安全边界         |

配置解析必须有安全降级：缺失/损坏时功能 disabled，而不是使用可能错误价格继续受理。价格和配置快照写入 attempt，运行中改价不影响已受理任务。

## 8. 持久任务队列

### 8.1 为什么使用 PostgreSQL

现有 backend 已连接 PostgreSQL，初版单图流量有限。表队列可以用最少组件获得跨进程、跨重启状态，不增加 Redis/BullMQ、独立 worker 部署和新监控面。Redis REST 不适合作为长任务可靠队列。

### 8.2 Claim 与租约

- `claim_chat_image_jobs(worker_id, limit)` 使用 `FOR UPDATE SKIP LOCKED` 小批量领取。
- claim 只领取 `pending` 或**尚未 dispatch provider**且租约过期的 `leased`。
- runner 在调用 provider 前原子写 `generating + dispatched_at`。一旦进入 generating，租约过期也不得自动重投。
- `generating` 超过总 deadline 的恢复器标 `failed_unknown`；这避免进程恰在 provider 已接单后死亡造成第二张图和双供应商成本。
- Storage/settlement 阶段有稳定结果与 attempt key，可安全重试；重试有限、退避，之后留给下一轮 reconciliation。

默认轮询 2 秒、batch 5、单实例并发 2。它们是 backend 安全配置，不作为前端 API；上线后按 provider 限流和 DB 负载调整。若以后持续吞吐超过单进程容量，再以数据证据评审独立 worker，不在初版预建。

## 9. 扣费、幂等与补偿

### 9.1 提交点

外部系统与 PostgreSQL 无法做分布式事务，固定顺序：provider 成功 → Storage 上传并验证 → settlement RPC。只有 RPC 提交后 API 才返回/查询为 ready。

### 9.2 幂等

- `attempt.id` 同时作为业务任务 ID 和 `charge_key`，一 attempt 最多一费。
- settlement 重放返回 `already_charged` 及既有 ready，不新增 ledger。
- 创建 attempt 的 partial unique 防止同 message 同时存在两个 active 任务；用户主动重试只能在前一 attempt 终态后创建新 ID。
- `is_current` 在 settlement 事务内切换，避免先隐藏旧图、后新图失败导致页面无图。

### 9.3 余额竞争

受理时余额预检后，其他消费可能抢先扣款。settlement 再锁钱包判断；不足则不扣费、不 ready，attempt 失败码为 `image_insufficient_balance_at_settlement`，并删除刚上传对象。用户可充值后新建 attempt，不复用旧产物自动扣款。

### 9.4 补偿与对账

- 上传后结算失败：删除对象；删除失败记录 orphan 路径摘要和告警。
- RPC 成功后客户端/runner断线：重放 settlement 命中幂等，query 仍可读 ready。
- 增加只读对账脚本/查询：ready 无 ledger、ledger 无 ready、非 ready 有 current、终态 orphan path、超期 active。修复操作必须单独审批。

## 10. Frontend 设计

### 10.1 组件边界

- Chat page：只拥有选中 message、打开/关闭和 hooks 组合，不承载整块面板 JSX。
- `ChatImageSheet`：用 `useReducer` 管理面板有限状态，避免多个 boolean 组成非法状态。
- `ChatImagePromptEditor`：输入/字数/校验，props down、callback up。
- `ChatMessageImageFooter`：渲染 latest pending/error/current ready，放在语音 footer 之前。
- `ChatImageViewer`：Radix Dialog，全屏大图、关闭、焦点恢复和有意义 alt。

### 10.2 服务器状态与恢复

- config 和会话 images 都在 `lib/api/images.ts`，组件不直接 fetch。
- 会话 images query 仅存在 pending/generating/storing 时 1.5~2 秒轮询；终态、后台页面停止。
- 创建成功立即把 202 attempt 合并到 cache；最终 ready 后刷新 images 和 wallet balance。
- Sheet 描述是局部临时状态；离开前未确认不持久化。已经确认的 attempt 由数据库恢复。
- 充值 URL 只带安全的 `returnTo`（character/session/message anchor），严格编码和 allowlist；不带 prompt、token 或价格。

### 10.3 状态覆盖

必须实现：描述 loading/error/retry、确认、编辑、提交 disabled、生成中、ready、失败可重试、余额不足、功能 unavailable。图片保留固定宽高比/占位，避免消息列表跳动；大图支持 Esc/返回关闭、safe area、reduced motion。

## 11. 可靠性评估

| 项     | 设计                                                                                         |
| ------ | -------------------------------------------------------------------------------------------- |
| 超时   | 描述、图片 provider、下载、Storage、DB 各有 timeout；全链路总 deadline 不被重试重置          |
| 重试   | 描述非法结构最多一次；provider 明确失败/模糊超时不自动重投；上传与 settlement 可安全有限重试 |
| 幂等   | active partial unique、claim SKIP LOCKED、attempt charge key、settlement dedup               |
| 并发   | DB 约束/RPC 为真相；前端 disabled 和单进程 concurrency 只做流控                              |
| 事务   | 钱包、ledger、charge、ready/current 同事务；Storage 使用显式补偿                             |
| 降级   | 配置/key 异常关闭新受理；描述失败不影响聊天/语音；旧成功图在新 attempt 失败时保留            |
| 限流   | runner 有界并发；provider 429 记录并暂停新 claim 的短退避，不无限堆并发                      |
| 容量   | 单张/固定尺寸/输出字节上限；DB 不存二进制；查询只返回每 message 聚合状态                     |
| 可观测 | 阶段耗时、状态计数、错误码、provider request id、queue age、settlement/orphan 不一致         |
| 恢复   | provider 前可重领；provider 后模糊任务收口 unknown；Storage/settlement 可重放；只读对账兜底  |

## 12. 日志与隐私

Pino 事件建议：`image.description.*`、`image.accept.*`、`image.job.claim`、`image.generate.*`、`image.storage.*`、`image.charge.*`、`image.reconcile.summary`。仅记录 allowlist：request/attempt/session/message 的 ID、状态、阶段、模型名、尺寸、字节数、耗时、错误码、provider request id；原始异常使用 `{ err }`。

禁止记录 prompt、对话正文、完整 provider response、base64、签名 URL、initData、secret、用户敏感资料。Storage 私有时签名 URL 不进入 info 日志或 Sentry breadcrumb。

## 13. 发布、灰度、停止与回滚

1. test 单文件执行兼容 migration，核验 shape、RLS/grants、claim 并发、settlement 幂等与 rollback。
2. 创建 test bucket/policy，配置 test secret/runtime config；保持功能开关关闭。
3. 发布 backend，再发布 frontend；开启 test 开关完成产品必验和故障矩阵。
4. 生产重复 migration/bucket/secret/backend/frontend 顺序，开关仍关闭；经年确认后小流量开启。
5. 观测成功率、queue age/P95、provider 429、扣费不一致、孤儿对象、Storage 失败。

建议停止条件：5 分钟成功率低于 90%、P95 超过 90 秒、任一扣费与 ready 不一致、孤儿持续增长或 provider 429 超过 10%。停止时先关 `image_generation_enabled`，不再接新单；默认让 runner 收口已受理任务，若发现计费一致性问题则同时暂停 runner并只读盘点。

紧急回滚不删表/流水：关开关 → 回退 frontend/backend → 保留审计数据 → 后续 forward-fix。生产 migration 需要独立 rollback 文档，但一旦产生真实账务，不执行破坏性 down migration。

## 14. 验证清单

按需求不新增测试文件，但必须运行仓库既有 shared/backend/frontend typecheck、test、lint、build 和 `pnpm -r typecheck`。此外在 test 环境逐项人工验证：入口条件、描述不扣费、原描述/自定义出图、双击/双设备、离页/刷新/重启、明确失败、模糊超时、Storage 失败、预检不足、结算余额竞争、RPC 重放、多次生成 current、充值回跳、窄屏/软键盘/大图。

## 15. 待评审拍板

1. 是否批准 OpenAI `gpt-image-1` 作为初版 provider/model；若已有商务供应商，请只替换 adapter 配置，不改变链路。
2. 是否批准默认 `1024x1536` 单图、价格 12 星尘、200 字上限。
3. Storage 采用私有 bucket + 短签名 URL（推荐），还是接受公共 URL 的转发风险。
4. 用户自定义 prompt 的内容安全由 provider moderation 还是现有平台审核能力前置；拒绝时统一不扣费。
5. `failed_unknown` 是否允许用户立即新建 attempt（推荐），并接受供应商侧可能已产生但平台不向用户收费的成本。

评审通过后再执行 `.trellis/tasks/09-11-chat-image-generation-plan/implement.md`，当前文档不代表已上线能力。
