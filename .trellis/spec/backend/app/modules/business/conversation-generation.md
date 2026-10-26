---
module_id: backend.business.conversation-generation
title: 会话与生成
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/10-26-user-stop-billing/
last_verified_at: 2026-10-26
---

# 会话与生成

## 职责与边界

## 当前状态

文字回复新增基于数据库标记的显式取消；生成计费前抢占没有取消标记的 streaming 终态。取消先释放免费额度，再确认 interrupted；上下文/上游异常统一恢复，详情读取回收过期生成。执行副本未确认时取消返回可重试待确认。无需 migration，真实 TEST/Preview SSE、钱包/额度及真机验收仍未执行。

AI 回复后处理版本由数据库 current-postprocess RPC 在开轮事务内读取正式指针、校验不可变快照并绑定；成功必返回非空版本。配置/RPC/快照异常在 LLM、计费和 SSE 之前拒绝开轮，不再由 Backend 冷启动缓存降级成永久 `NULL` 消息。

自研会话链路已上线。图片生成代码已落地但 runtime 开关默认关闭：当前只保留单一普通图片路径，由 DeepSeek 写中文分镜或保留用户中文稿，在 worker 中直译英文后优先调用 Grok/Liaobots，主通道失败时以相同内容降级到 Replicate Z。普通图片继续使用 `basic_image` 免费次数，耗尽后按普通价格结算；高级图片入口、provider 分流、VIP 门禁与高级价格已退场。图片 telemetry 与结算未知语义保持不变。

## 入口与调用者

## 涉及文件

| 路径                                                                                | 职责                              |
| ----------------------------------------------------------------------------------- | --------------------------------- |
| `packages/backend/src/routes/conversations.ts`                                      | HTTP/SSE 入口                     |
| `packages/backend/src/features/conversations/`                                      | 轮次编排                          |
| `packages/backend/src/features/generation/`                                         | 生成与计费出口                    |
| `packages/backend/src/features/text-postprocess/config.ts`                          | Admin 正式版本指针严格读取        |
| `packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.ts` | current-postprocess 开轮 RPC      |
| `packages/backend/src/features/image/`                                              | 图片任务编排与 telemetry observer |
| `packages/backend/src/features/image/ImageGenerationTelemetry.ts`                   | 图片生成安全事件 observer         |
| `packages/backend/src/routes/images.ts`                                             | 图片 HTTP 入口                    |

## 关键实现链路

图片链路为“ownership/回复资格 → 普通图片免费名额预留或付费预检 → 中文稿 → pending attempt → DB 租约 → DeepSeek 直译 → Grok（失败则 Z 降级）→ Storage → `settle_image_generation` 原子消费免费次数或扣费并置 current ready”。旧客户端的 tier 输入被兼容忽略，新 attempt 固定为 basic。

## 数据、契约与外部依赖

OpenRouter mapper、计费读取和回捞仓储统一使用专表的厂商原名字段；`llm_generation_id`、`llm_generation_data` 为明确保留的例外。主表 `recordBillingOutcome` 显式接收金额、结算时间和业务结束原因，禁止复用并修改 OpenRouter 元数据对象承载计费列。`usage_cache` 可缺失，不作为元数据完整性的必需条件。Venice 的 mapper/repository 不参与本次命名调整。原名代码需先执行 `20261016_openrouter_original_metadata_fields.sql`；远端未执行前不能部署。

消费 shared conversations/images/telemetry 契约、experience 会话与图片 attempt、OpenRouter、DeepSeek、Grok/Liaobots、Replicate Z、Supabase Storage 和服务端 PostHog capture。

## 关键节点与约束

流前错误使用 HTTP；响应头发出后使用流内 error。聊天与图片上游适配不得旁路 `features/generation`。图片 provider 前租约可恢复；Grok 失败只允许切换一次 Z，Z dispatch 后结果未知必须失败关闭。结算明确余额不足删除对象，结算响应未知则保留对象和 storing 状态待幂等对账，且不发送 PostHog 终态事件。事件不得包含 prompt 正文、图片 URL、Storage path、provider request id 或错误 body。

## 验证方式

`pnpm --filter @miniapp/backend typecheck && pnpm --filter @miniapp/backend test`；真实上游、PostHog Preview 和 SSE 缓冲使用可重复人工回归，已删除的 `mvp:regression` 不再使用。

## 已知缺口与待核验项

本地已实现主表调用字段清退：正常读写为显式业务投影，finalizeTurn 不接收调用 ID，上游前 await 快照/专表占位、首次 ID 持久化；已接收 SSE/非流式正文在 metadata 失败时仍保留。五路恢复消费对应专表身份/已存事实，业务取消/超时与计费归属保持。未部署，真实环境验收见任务 T8 报告。

角色卡更多人设字段和自建预设格式仍待后续任务；图片真实 DeepSeek/Grok、Storage、重启/并发、PostHog Preview 事件与发布观测仍待 test 环境验收。

## 关联模块

`frontend.business.conversation-ui`、`backend.infrastructure.runtime-data-security`、`shared.business.conversation-contracts`、`database.business.conversation-storage`。

## 图片创作广场 V2（2026-10-12）

`features/image-plaza` 是图片创作广场的独立任务域，不复用聊天 `features/image` attempt。链路为报价快照 → 幂等受理 → worker 租约 → Venice 单次写调用（明确超时、不自动重试）→ 私有 Storage → 原子结算；上游结果不确定时进入 `failed_unknown` 且不扣费。

审核后的 Civitai 初始数据通过独立离线导入器进入公开作品，不伪造用户、会话或生成 attempt。导入保留最多 2000 字原始提示词与模型映射，超限行隔离且不截断；apply 必须同时提供逐条审核清单、明确 test/production 目标、原图存储确认和有限批次，生产还需额外确认。

Feed/config 始终返回启用标签目录；点击业务标签按标签中文 label 在 `snapshot.prompt_zh` 字面包含筛选，「全部」不限制标签。`image_plaza_tags_feature_enabled` 只控制分享时空 tags 的自动打标。

## 变更记录

- 2026-10-15：任务 `10-15-image-plaza-tag-prompt-filter` 解耦标签展示与自动打标，feed 标签筛选改为 `prompt_zh` 中文包含匹配。
- 2026-10-13：任务 `10-10-image-plaza-v2` 增加经审核初始作品的离线导入路径与 apply 门禁。

- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）写入图片描述/受理/worker 终态 PostHog observer；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）删除无法恢复的乱码变更记录；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。

## Scenario: 两平台思考参数与流解析（2026-10-23）

### 1. Scope / Trigger

新增默认开启的对话思考开关，仍只有generation一条生成/计费出口。

### 2. Signatures

`GenerationRequest.thinkingEnabled?:boolean`、`GenerationHooks.onReasoningDelta`、`createSseTap.onReasoningDelta`；route传递本轮值，HTTP缺字段按false兼容旧客户端，新UI默认显式true。

### 3. Contracts

OpenRouter：`reasoning:{enabled,exclude:!enabled}`；Venice：`reasoning:{enabled}`与`venice_parameters:{include_venice_system_prompt:false,disable_thinking:!enabled,strip_thinking_response:!enabled}`，stream继续请求usage。不开新模型目录/特殊重试。SSE读取reasoning_content/reasoning或可读details，忽略encrypted/signature及官方加密占位；同轮出现结构化思考后不重复转发旧标签内容。只识别正文前导think区，跨chunk标签/UTF8可拆分，正文中的后续字面标签保留。

### 4. Validation & Error Matrix

非法bool开轮前400；上游非2xx保留既有拒绝/释放预留，不传原始错误正文给hook；首次provider ID仍先持久化再转发。关闭不发送思考；每轮思考最多64Ki字符，不保存到snapshot.content/DB/日志。普通模式保留4秒单次兜底，深度思考模式不启动快速兜底；两种模式的6秒阈值都只记录首字SLA超时，不主动取消或中断上游，并受110/120秒绝对期限和显式取消约束。只读准备使用独立20秒有限预算。取消、绝对超时与身份写失败不重放生成；只有思考不得触发完成结算或消费免费额度；首字选择/放行独立于最终有效正文判定。

### 5. Good / Base / Bad Cases

Good：思考→正文→DONE/stop，按原正文交付结算。Base：只正文。Bad：将reasoning_tokens再加到completion_tokens重复计费；把reasoning-only认定成功；流后自动重试。

### 6. Tests Required

现有upstream/execute/lifecycle与route回归：双平台on/off、默认、非法值、UTF8字节拆分、前导think拆分/正文标签保留、结构化+标签去重、密文、思考上限、ID-await销毁、只有思考无正文不扣费。

### 7. Wrong vs Correct

Wrong：`replyChunks.push(reasoning)`。Correct：思考只进`onReasoningDelta`，`content/deltaCount`只统计正文，原`[DONE]+可见正文+stop`计费条件保持。

首字统一口径：开启深度思考时，真实思考文本首字与正文首字等效并完成首字观测；静默思考跨过快速SLA时只记超时事实，不触发fallback或取消。关闭只算正文并保留4秒单次fallback，但6秒同样只观测、不终止。等待提示、thinking标题、密文占位不计；只有思考无有效正文仍不得扣费。

## 2026-10-23 可运营回复风格

展示feature reply-style-options仅从runtime-config读取已发布目录，GET/PATCH严格投影id/name/description。用户pref_reply_styles默认{}，部分map只走service_role invoker RPC原子合并；公开HTTP/SSE、日志与Engine不接收marker/rules。该功能只负责UI目录与用户选择。

## 主动停止原价与权益结算（2026-10-26）

取消请求显式区分user_stop与first_token_timeout。新业务标记user_cancelled在已冻结报价的生成中按原型号原价格/VIP/免费权益一次结算；免费轮消费免费次数，前端不增加扣费通知。系统超时、上游失败、历史cancelled和未报价取消保持免扣；新请求服务端策略位默认生效，取消CAS RPC按截止与已见观测裁决，不以调用方省略原因选价。免费权益先收口再解锁，钱包按原charge_id后台结算，缺generationId也不重发上游；回捞保留新业务原因及同账单幂等。契约/后端/数据库/前端联动，具体执行证据见本任务release-review。
