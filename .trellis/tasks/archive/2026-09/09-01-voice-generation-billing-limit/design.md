# 技术设计：语音生成收费与 300 字限制

## 1. 设计目标

在保留现有“POST 受理、后台生成、GET 轮询”的语音架构下，实现以下闭环：

- 前端清晰展示单次价格 15 星尘；
- 生成与重新生成采用相同计费规则；
- 默认和自定义文本均经过文本处理，并在 TTS 前按最终文本执行 300 字服务端硬校验；
- 只有对用户可见的成功语音才扣费，所有失败和超限均不扣费；
- 同一生成 attempt 在重试、重复执行或收口竞争下最多扣费一次；
- 配置、日志和客户端均不泄漏文本处理服务凭据。

## 2. 仓库现状与差距

### 2.1 当前调用链

```text
聊天页 / 自定义页
  -> shared voice DTO
  -> POST /conversations/:sessionId/messages/:messageId/voice
  -> chat_message_audio 插入 pending revision
  -> runVoiceGeneration（进程内异步）
  -> 默认：DeepSeek 文本处理；自定义：当前直接跳过文本处理
  -> MiniMax TTS
  -> Supabase Storage
  -> chat_message_audio 标记 ready / failed
  -> GET 会话语音轮询
  -> 聊天消息底部状态 / 播放条
```

### 2.2 已有可复用能力

- `chat_message_audio.id` 每次生成唯一，适合作为 attempt 与计费幂等键。
- `ChatMessageAudioRepository` 已封装 pending、草稿、ready、failed 和 stale pending 映射。
- `features/voice` 已分离文本处理、TTS、存储和错误阶段码。
- 前端已有 React Query 语音配置、生成 mutation、轮询及按消息缓存合并。
- 自定义页已有 `maxLength=300` 与字数计数。
- 钱包已有行锁、赠送余额优先的扣减规则，以及 LLM 计费的事务与 ledger 范式。
- runtime config 有统一读取入口 `platform/runtime-config.ts`。

### 2.3 主要差距

- 当前注释和实现明确为免费；无语音计费事实、幂等扣费和价格契约。
- 默认文本处理最终上限仍为 700 字；TTS 前没有本需求要求的统一 300 字闸门。
- 自定义文本当前跳过 DeepSeek，与 PRD 不符。
- 前端异步失败只显示“重试语音”，未按错误码显示当前消息行内提示。
- `createPending` 先让旧 active 行失效再插入，跨两次数据库调用存在并发窗口；语音计费不能复用普通 `deduct_wallet_credits`，否则缺少业务幂等事实。
- 当前配置来自 `platform/config.ts`；本任务涉及的新运行时业务配置必须改由 `platform/runtime-config.ts` 读取。

## 3. 总体方案

采用“一次生成一条 attempt、TTS 前硬闸门、成功结果与扣费原子收口”的方案。

```text
POST 受理
  1. 鉴权、会话/消息、自定义输入校验
  2. 读取语音业务配置（价格、上限、提示、开关）
  3. 钱包余额预检（<15 -> 402，不创建 attempt，不调用上游）
  4. 原子创建 pending attempt（audioId）
  5. 返回 202，异步执行

后台 attempt
  6. 默认/自定义统一调用文本处理
  7. 规范化最终文本并检查 1..300 字
     - >300 -> failed: voice_text_too_long，不调用 TTS、不扣费
  8. 调用 TTS 并写入对象存储
  9. 数据库 RPC 原子完成：锁 attempt -> 幂等检查 -> 锁钱包
     -> 扣 15 -> 写 wallet ledger -> attempt 标记 ready 并记录扣费事实
 10. 任一步失败 -> attempt 标记 failed；若已上传但结算失败，尽力删除孤儿对象

前端轮询
 11. pending -> 生成中；ready -> 播放条；failed -> 可重试 + 当前消息行内提示
```

## 4. Shared 契约设计

先修改 `packages/shared/src/api/voice.ts`，再修改后端与前端消费者。

### 4.1 配置响应

在 `GetVoiceConfigData` / `PatchVoiceConfigData` 增加：

```ts
interface VoiceBillingConfig {
  enabled: boolean;
  credits_per_generation: number;
  price_label: string;
}

interface VoiceLimitsConfig {
  max_spoken_chars: number;
}

interface VoiceHintsConfig {
  over_limit: string;
  draft_failed: string;
  tts_failed: string;
}
```

响应增加 `billing`、`limits`、`hints`。前端展示和限制从该响应读取，避免价格、上限和文案分别硬编码；shared 仍保留 `MAX_CUSTOM_VOICE_CHARS = 300` 作为配置加载前的输入安全上限与类型消费者兜底。

### 4.2 语音状态

`MessageVoice.error_code` 继续承载当前 attempt 的失败码，至少识别：

- `voice_text_too_long`：红色超限文案；
- `voice_draft_*`：文本处理失败提示；
- `voice_tts_*`、`voice_generation_failed`、`voice_generation_stalled`：语音生成失败/可重试提示。

本期不向客户端暴露 wallet ledger id、内部 charge id 或供应商错误详情。

### 4.3 错误响应

- POST 余额不足：HTTP 402 + `INSUFFICIENT_CREDITS`，附 `credits_required` 与 `credits_available`（复用现有错误 envelope 口径）。
- 输入格式或自定义初始文本超限：HTTP 400。
- 已有未过期 pending：HTTP 409 `CONFLICT`。
- 异步阶段超限与上游失败：通过轮询得到 `failed + error_code`，不改变 POST 202 模式。

## 5. 运行时配置与安全

通过 `features/voice/voice-billing-config.ts` 聚合读取以下 runtime config，底层只调用 `platform/runtime-config.ts`：

- `voice_billing_enabled`：灰度开关；测试环境验证时开启，生产由上线确认后开启；
- `voice_generation_credits`：默认 15；
- `voice_max_spoken_chars`：默认 300；
- `voice_price_label`：默认“15 星尘”；
- `voice_over_limit_hint`、`voice_draft_failed_hint`、`voice_tts_failed_hint`。

配置缺失或损坏时使用代码内同值兜底并记录 warn。业务开关关闭时可保留 300 字限制，但不做余额预检和扣费；返回的 `billing.enabled` 使前端只在计费启用时展示价格。

DeepSeek 兼容服务的 URL、模型名和 API Key 继续作为服务端环境秘密读取，不进入 runtime config 公共响应，不写入日志。日志只记录 stage、error code、attempt id、字符数、延迟和原始 `err` 对象。

## 6. 文本处理与 300 字规则

### 6.1 统一处理

- 默认生成：输入角色回复正文；
- 自定义生成：输入用户提交的自定义文字；
- 两者均调用文本处理服务，使用明确区分 source mode 的 user prompt，避免把自定义台词当角色回复抽取后意外丢失；
- system/user prompt 均明确“最终输出不超过 300 字”；
- 模型返回后执行现有清洗/规范化，再以规范化后的最终字符串计数。

### 6.2 服务端最终闸门

在 `runVoiceGeneration` 内、`synthesizeSpeech` 前执行：

```text
finalText.length === 0 -> 文本处理失败类错误
finalText.length <= maxSpokenChars -> 允许 TTS
finalText.length > maxSpokenChars -> voice_text_too_long
```

边界测试必须覆盖 300 放行、301 拦截。不得通过截断最终文本来“修复”模型超限，否则用户无法得知文本处理未遵守要求，且可能改变语义。

前端自定义 textarea 同时设置动态 `maxLength`，并在 `onChange` 中截断粘贴/输入法一次性产生的超长字符串；服务端仍对原始请求独立校验，前端限制不构成安全边界。

## 7. 数据库与计费一致性

### 7.1 新 migration

在 `packages/shared/migrations/` 新增单独 migration（不得修改历史 migration），面向 schema split 后对象：

- `experience.chat_message_audio` 增加：
  - `credits_charged NUMERIC(14,1) NOT NULL DEFAULT 0`；
  - `debit_ledger_id UUID NULL`；
  - 可选 `charged_at TIMESTAMPTZ NULL`；
- 为 `debit_ledger_id` 建唯一索引（非空时唯一）；
- 增加 `billing.charge_voice_usage(...)` 或语义等价 RPC；
- runtime config 种入上述 voice 业务键，初始开关按部署计划保持关闭，再在测试环境显式开启。

不复活已回滚的 101/102 文件，不照搬旧 `miniapp.*` schema 名称；迁移必须以当前 `experience`、`billing`、`app_core` schema 为准。

### 7.2 原子结算 RPC

RPC 输入至少包含：`audio_id`、`user_id`、`amount`、ready 结果字段。事务内：

1. `SELECT ... FOR UPDATE` 锁定 audio attempt，验证归属与状态；
2. 若 attempt 已有 `debit_ledger_id/credits_charged`，返回 `already_charged`，不得再次扣费；
3. 锁定 `billing.user_wallets` 行并检查余额；
4. 按现有规则先扣赠送星尘、再扣主星尘；
5. 插入 `billing.wallet_ledger`，`reference_type='voice_usage'`，reference 指向 `audio_id`；
6. 同事务把 attempt 标记为 `ready`，写入音频字段与扣费事实；
7. 返回 charged amount、ledger id 与幂等命中状态。

由 audio attempt id 作为业务幂等键。单纯调用现有 `deduct_wallet_credits` 不满足要求，因为它不能把“扣费事实、ledger、语音成功状态”绑定在同一事务内。

### 7.3 并发与后置余额变化

- POST 前置余额预检满足“余额不足不可发起”，但预检不持有跨上游调用的数据库锁。
- 若生成期间余额被其他业务消耗，原子结算发现余额不足，则该 attempt 不得对用户呈现为成功；标记为失败且不扣费，已上传对象尽力删除。
- 不采用先扣后退：这会引入失败退款、退款失败和额外 ledger 状态，超出本期范围。
- `createPending` 的并发原子性应通过数据库 RPC 或 pending 唯一约束完成，避免当前“让旧行失效 + 插入新行”的跨语句窗口。每个成功受理生成独立 attempt；同一 attempt 只扣一次，不同重新生成 attempt 各扣一次。

## 8. 后端模块设计

### 8.1 `routes/voice.ts`

- 保留所有 `@frontend-ready: true` 注释；
- 获取统一业务配置并回传配置 DTO；
- 校验自定义初始输入上限；
- 计费开启时调用 `features/generation/` 下的语音余额预检能力；
- 余额不足返回 402，不创建 pending；
- 创建 pending 后把价格、上限和 source mode 传入后台任务。

### 8.2 `features/generation/`

项目硬规则要求 LLM generation 与 billing 经过该目录。新增语音计费用例/适配器，负责：

- `precheckVoiceCredits(userId, amount)`；
- `settleVoiceGeneration(...)` 调用原子 RPC 并归一化 `charged / already_charged / insufficient_balance`；
- 不把语音供应商调用搬入 generation，`features/voice` 仍拥有语音编排。

### 8.3 `features/voice/`

- prompt 上限由 700 调整为配置 300，并区分默认/自定义 source mode；
- `runVoiceGeneration` 统一文本处理；
- TTS 前执行最终硬校验；
- 成功路径改为“合成/存储后调用原子结算”，不再先独立 `markReady`；
- 失败按阶段记录 error code，超限固定为 `voice_text_too_long`；
- 对象已上传但结算失败时执行 best-effort 清理，并保留原始错误日志。

### 8.4 Repository

- `ChatMessageAudioRepository` 增加计费列映射和原子 pending 创建能力；
- `toMessageVoice` 继续隐藏内部账务字段；
- stale pending 仍对外映射 failed；
- 本期沿用当前产品行为：重新生成受理后旧结果让位，新 attempt 失败则当前消息显示可重试状态，不额外设计“保留旧音频 + last_error”契约。

## 9. 前端设计

### 9.1 聊天页

- 从 `useVoiceConfigQuery` 取得 `price_label` 与 hints；
- `ChatMessageVoiceFooter` 在未就绪操作行显示“生成语音 · 15 星尘”或等价紧凑排版；failed 时显示“重试语音 · 15 星尘”；
- ready 播放条保持现状，重新生成按钮的无障碍标签包含再次收费语义，并可用邻近小字/提示让价格在操作前可见；
- 根据 `error_code` 在当前消息操作入口下方显示提示；`voice_text_too_long` 使用 destructive 红色小字，其他失败使用低强调错误提示；
- mutation 成功合并 pending 后，旧 failed error 随状态替换自然消失；ready 后不再显示错误。

### 9.2 自定义页

- 复用 voice config，不新增组件级 fetch；
- textarea 使用后端配置的 `max_spoken_chars`，加载前回退 shared 300；
- 提交前提示“成功将消耗 15 星尘”；
- 保留现有表单内错误位置，余额不足按现有充值/错误交互处理；
- 提交成功仍返回聊天页，由轮询展示最终结果。

### 9.3 缓存与余额刷新

- 继续由 `useGenerateVoiceMutation` 合并 pending；
- 轮询得到 ready 后刷新钱包 query，使页面余额反映扣费；
- 为避免每次轮询重复刷新，可在语音列表从 pending/failed 转为 ready 时，或查询成功检测新 ready attempt 时做一次失效；具体复用现有 wallet query key。

## 10. 测试设计

### 10.1 Shared

- DTO 导出与所有消费者 typecheck；
- 如增加错误码映射 helper，覆盖已知和未知码。

### 10.2 Backend 单元/路由测试

- 余额 14：POST 402，未 createPending，未调用文本处理/TTS；
- 余额 15：允许受理；
- 默认/自定义均调用文本处理；
- 最终 300 字调用 TTS，301 字不调用 TTS、标记 `voice_text_too_long`、不结算；
- draft/TTS/存储失败不调用结算；
- 首次结算扣 15 并 ready；同 audioId 重放返回 already_charged 且余额不再变化；
- 两个不同 audioId 的成功重新生成各扣 15；
- 预检后并发消费余额导致结算不足：不 ready、不扣费；
- stale pending、冲突和日志错误对象行为回归。

### 10.3 Migration/RPC 测试

- migration 在测试库单独执行并做对象/函数/权限检查；
- 余额拆分扣减（bonus 优先）、ledger 内容、audio ready 与扣费列同事务一致；
- 同 audioId 串行和并发重复调用只产生一条 ledger；
- 余额不足事务无部分更新；
- rollback 删除新增 RPC/索引/列/配置键，执行前导出或确认测试数据可丢弃。

### 10.4 Frontend

- 价格在生成和失败重试入口可见；
- 超限错误仅显示在对应消息并使用红色小字；
- pending/ready 后错误消失；
- 自定义输入 300/301 和超长粘贴；
- 自定义页收费提示；
- 播放条、展开文字框、音色和播放倍速回归。

## 11. 发布、观测与回滚

### 11.1 发布顺序

1. 合并 shared 契约与后端兼容代码，计费开关关闭；
2. 在测试库手工执行 migration，记录结果；
3. 部署测试 backend/frontend；
4. 测试环境开启 `voice_billing_enabled`，逐项执行 AC；
5. 经年确认上线后，生产先执行已验证 migration，再部署代码，最后开启开关；
6. 观察扣费数、成功数、失败码、ledger 与钱包余额一致性。

### 11.2 关键日志/指标

- `voice.generate.accepted / done / failed`；
- `audioId`、用户匿名内部 id、stage、errorCode、source/spoken chars、latency、charged amount；
- 禁止记录 API Key、Authorization、兼容服务私有地址和完整敏感请求体。

### 11.3 回滚

- 首选即时关闭 `voice_billing_enabled`，停止新语音扣费，保留 300 字保护；
- 应用代码回滚需保证仍可读取带新增列的数据；
- 数据库 rollback 仅在确认没有依赖新列的新版本运行后执行；已产生的 wallet ledger 属于财务事实，不自动删除或反向退款，如需处理须走单独经审计的补偿任务；
- migration 文件附测试环境执行记录与明确 rollback SQL/说明，生产执行前再次核对 schema。

## 12. 关键决策

| 决策           | 选择                                    | 理由                                             |
| -------------- | --------------------------------------- | ------------------------------------------------ |
| 计费幂等键     | `chat_message_audio.id`                 | 每次生成唯一，重新生成自然产生新键               |
| 成功与扣费     | 数据库事务原子收口                      | 防止 ready 未扣费或重复扣费                      |
| 余额竞争       | 预检 + 成功收口再锁钱包                 | 满足不足不可发起，同时不提前扣费/退款            |
| 自定义处理     | 与默认统一经过文本处理，prompt 区分模式 | 符合 PRD，避免直接复用角色抽取 prompt 破坏文本   |
| 超限处理       | 301 失败，不截断                        | 保持语义并给用户明确反馈                         |
| 价格/上限/提示 | runtime config + shared DTO             | 前后端一致、支持测试灰度和安全上线               |
| 失败后的旧音频 | 沿用当前“新 attempt 取代旧结果”         | PRD 未要求保留旧成片，避免扩大契约和状态聚合范围 |
