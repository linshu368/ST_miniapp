# 角色对话图片生成技术设计

> 评审版完整方案见 [`docs/chat-image-generation-review.md`](../../../docs/chat-image-generation-review.md)。本文件固定实施边界与关键决策。

## 1. 组件与职责

```text
Chat UI
  -> shared image contracts
  -> image routes (auth/validation/HTTP mapping)
  -> image feature orchestration
     -> generation/text-json (免费描述)
     -> durable DB job runner
     -> generation/image provider
     -> image storage
     -> atomic billing + ready RPC
  -> session image polling
  -> message-bound image UI
```

- `shared/api/images.ts`：唯一公开 DTO、状态、错误码与输入限制。
- `routes/images.ts`：鉴权、ownership、校验、202/402/409/422/503 映射与 allowlist 日志。
- `features/image/`：描述 prompt、attempt 编排和状态迁移；不自行读取 env、runtime config 或调用钱包。
- `features/generation/`：增加非 SSE 文本 JSON 生成、图片 provider 调用、成功结算入口；保留统一生成/计费边界。
- `ChatMessageImageRepository`：experience 域图片 attempt、领取租约和终态映射。
- `chat-image-storage.ts`：上传、删除、MIME/尺寸/大小检查及稳定路径。
- `chat-image-job.ts`：进程内数据库任务 runner，小批量/有限并发/租约恢复。
- Frontend `lib/api/images.ts`：query key、配置/会话状态/描述/创建 mutation。
- `ChatImageSheet`：局部 reducer 驱动 closed→describing→confirm/edit→submitting→pending/error 状态。
- `ChatMessageImageFooter`：只渲染某 message 当前图/生成状态；`ChatImageViewer` 负责大图 Dialog。

## 2. 权威数据与状态机

`experience.chat_message_images` 一行表示一次用户确认后的出图 attempt，不保存描述预览。建议字段：

- 身份：`id`、`user_id`、`session_id`、`message_id`、`attempt_no`。
- 输入快照：`prompt`（用户确认的原文）、`prompt_source=generated|custom`。
- 配置快照：`provider`、`model`、`width`、`height`、`output_format`、`price_credits`。
- 状态：`pending | leased | generating | storing | ready | failed | failed_unknown`。
- 任务：`lease_owner`、`lease_expires_at`、`next_attempt_at`、`provider_request_id`、`stage`。
- 结果：`storage_path`、`image_url`、`mime_type`、`byte_size`、`error_code`、`latency_ms`。
- 计费：`charge_id`、`credits_charged`；审计时间戳。

`message_id` 绑定具体 revision。保留所有 attempts；会话查询按 `message_id` 返回最新 attempt 及当前 ready 图。新 attempt ready 后才在结算 RPC 内原子替换 current，旧 ready 记录保留但不默认展示。

## 3. API

- `GET /api/v1/image/config`：enabled、price、price_label、max_prompt_chars、width/height、健康向提示。
- `GET /api/v1/conversations/:sessionId/images`：会话内图片聚合状态，供进入/轮询恢复。
- `POST /api/v1/conversations/:sessionId/messages/:messageId/image-description`：生成免费描述；请求不接受模型名。
- `POST /api/v1/conversations/:sessionId/messages/:messageId/images`：body `{ prompt, prompt_source }`，余额预检后原子创建 pending，返回 202。

不增加“确认旧 description id”的服务端状态：描述预览是短生命周期 UI 数据，确认时直接提交最终 prompt 可减少表、过期策略和一次读取。后端仍重新做 ownership、最后完整回复、长度和安全校验。

## 4. 模型、密钥、尺寸与配置

- 自动描述：复用现有 OpenRouter 文本上游，使用独立 runtime config `image_description_model`，要求结构化 JSON `{description}`；不进入用户免费轮次和钱包计费。
- 出图：初版 provider 选 OpenAI Images API，默认模型 `gpt-image-1`，启动 secret `OPENAI_API_KEY`，endpoint/timeout 由 `platform/config.ts` 读取。
- 尺寸：默认竖图 `1024x1536`，输出 WebP（provider 不支持时接收 PNG 后在既有 Node 能力允许范围内保持 PNG；不为转码新增重依赖）。
- 运营 runtime config：`image_generation_enabled`、`image_generation_credits`、`image_price_label`、`image_description_model`、`image_generation_model`、`image_width`、`image_height`、`image_max_prompt_chars`、`image_max_output_bytes`、`image_prompt_policy`。
- secret 不进 runtime_config/admin/前端；前端只拿安全展示配置。

provider 选择是评审默认项；若部署环境实际供应商不同，只替换 `generation/image-provider.ts` 的单一 adapter 与启动配置，不改变公开契约/表/状态机。

## 5. 队列与恢复

采用 PostgreSQL 表即队列，不新增 BullMQ/Redis/独立服务。创建 pending 后返回 202；`app.ts` 启动 job 每 2 秒小批量调用 `claim_chat_image_jobs`，RPC 使用 `FOR UPDATE SKIP LOCKED` 和租约。单实例并发默认 2、批量 5，均为 backend 私有安全配置。

- `pending/leased` 且从未发起 provider：租约过期可安全重领。
- provider 请求发出前写 `generating` 和 dispatch token；请求明确失败可 failed。
- provider 超时/断连导致结果未知：`failed_unknown`，不自动重投、不扣费。
- Storage 上传可在总 deadline 内有限重试；结算 RPC 可无限安全重放但 job 只做有限次数后留待下轮。
- 定期扫描陈旧任务并按 stage 收口；对象清理失败记录告警和路径摘要，由运维脚本/后续清理 job 处理。

## 6. 计费事务

受理前只做余额预检。图片上传成功后调用 `billing.settle_image_generation`（security definer、固定 search_path、仅 service role）：

1. 锁 attempt 与 `billing.user_wallets`；
2. 校验 attempt 可结算、Storage 元数据齐全、金额等于创建时快照；
3. 以 `charge_key=attempt.id` 检查幂等墓碑；
4. 余额不足则返回 `insufficient_balance`，不写 ledger/ready；
5. 扣钱包、写永久 ledger（`type=image_generation`）、写 dedup/charge；
6. 将同 message 旧 current=false、当前 attempt `ready/current=true`；
7. 同一事务提交。

数据库不能与对象存储做分布式事务。顺序固定为“先上传、后 DB 结算”；结算失败删除对象作为补偿。删除失败不会展示图片，记录孤儿对象待清理。

## 7. 兼容、发布与回滚

发布顺序：兼容 migration + bucket/policy → runtime config/secret → backend（功能开关仍关）→ frontend → test 开关灰度 → 验收后生产。旧客户端忽略新 API/数据，不改变 conversation DTO，兼容。

停止条件：5 分钟窗口成功率 <90%、P95 >90 秒、连续计费/图片状态不一致、孤儿对象持续增长、provider 429 >10%。立即关闭 `image_generation_enabled` 停止新受理，runner 继续收口已受理任务；必要时暂停 runner 并执行只读盘点。

回滚优先关开关并回退 frontend/backend；表与账务流水保留审计，不在紧急回滚删除。Schema 清理由后续 migration forward-fix。

## 8. 拒绝的过度设计

- 不引入通用 media framework、provider 插件市场、独立队列服务、事件总线、WebSocket 推送。
- 不把 description 预览持久化为新资源。
- 不扩展 conversation 消息本体承载大字段；图片是独立旁支聚合查询。
- 不自动重试模糊 provider POST；可用性不能以重复成本和重复扣费为代价。
