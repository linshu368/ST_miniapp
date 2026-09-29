# Backend 数据、可靠性、安全与可观测性

## 数据访问边界

- Prisma 只映射 `app_core`、`miniapp_features`、`billing`；schema 变更唯一源是 `packages/shared/migrations/`。
- 其他域通过显式 schema client/RPC/repository。跨域写入用事务/RPC或明确补偿，不在 route 串联多次写后忽略半成功。
- repository 返回领域对象，不泄漏数据库行。列表必须稳定排序、有界分页；批量/导出评估行数、内存、超时，避免 N+1。

## 配置、秘密与鉴权

- `platform/config.ts` 统一解析启动配置并 fail fast；运行时运营配置只走 `runtime-config.ts` 的 TTL/version/降级机制。
- 禁止 secret、token、完整 initData、签名材料、DB URI、消息正文进入源码、Markdown、URL或日志。
- MiniApp 用 `requireTelegramAuth`；CS/Admin/Bot 沿用各自 token/session/webhook secret。鉴权后仍需资源 ownership/角色授权；service role 仅在后端。
- CORS 只允许配置 origin；不得用带凭证的无约束 `*`。

## 故障模型硬规则

| 风险 | REQUIRED                                                                             |
| ---- | ------------------------------------------------------------------------------------ |
| 超时 | 每个 HTTP/LLM/TTS/Telegram/支付/Redis 调用有明确 timeout；整体 deadline 不因重试重置 |
| 重试 | 有限、退避加抖动；仅幂等读或具幂等键写；尊重 429/Retry-After                         |
| 幂等 | 支付、奖励、归因、开轮、语音指定业务键和重复请求结果                                 |
| 并发 | 会话、钱包、结算使用行锁/unique/原子 RPC，不用进程锁替代 DB 一致性                   |
| 事务 | 多表不变量使用事务/RPC；跨外部系统写清提交点、补偿、对账                             |
| 降级 | 配置有安全默认；非核心通知/遥测失败不破坏主交易；关键失败不静默吞掉                  |
| 容量 | SSE、导出、轮询、音频/大 JSON 有大小、并发、时间上限                                 |
| 恢复 | 重启后可重放或由 sync/reconciliation job 收敛，记录停止条件和人工入口                |

高可用不是默认增加队列/缓存/adapter。只有真实故障需要且可验证时才增加组件；优先数据库约束、有限重试、已有 job 和清晰错误。

## 可观测性与发布

- 使用现有 pino、`requestLogger`；原始异常写 `{ err }`。Sentry 先脱敏再附 context。
- 关键流程记录阶段、耗时、状态/计数、安全幂等摘要、provider/request id；job 记录扫描/推进/失败数，禁止逐行高频 info。
- PostHog 支付终态是非核心观测：`POSTHOG_API_KEY`/`POSTHOG_HOST` 经 `platform/config.ts` 读取；`posthog-capture.ts` 用 Node 原生 fetch、短超时、无重试。只在 `complete`/`markFailed` 成功落库后异步发送 `payment_order_settled`/`payment_order_failed`。未配置时不反查用户。失败只记安全摘要，不得回滚或延迟结算。禁止把 token、`pay_url`、initData、错误 body 送往 PostHog。Production key 留空即关闭。
- 发布顺序：兼容 migration → backend producer → consumers → 清理旧字段。说明旧数据、灰度/停止条件、rollback 或 forward-fix。生产 migration 手动逐文件，先 test 验证 shape、RLS/权限、读写、锁/容量和回滚。

## Scenario: 文字回复取消与残留恢复

### 1. Scope / Trigger

文字回复无首字、断流或异常后不能永久占住会话。显式取消与离页断网分别处理。

### 2. Signatures

`POST /api/v1/conversations/:id/cancel`；详情 `GET /api/v1/conversations/:id` 和发送/重生成开轮前负责过期恢复。复用 `experience.chat_history`，不新增数据库对象。

### 3. Contracts

请求 `{ assistant_message_id: string }`（UUID），返回 envelope 内 `{ message: ChatMessage }`，是该条实际服务端终态。ownership 必须先于取消/恢复操作。取消标记 `streaming.llm_finish_reason=cancelled`；取消终态 `stream_interrupted`。成功抢占必须仅匹配 streaming 且无取消标记。免费预留释放先于取消终态，统计/回捞不能覆盖取消标记恢复计费。send/regenerate 允许可选 request_id UUID；它仅关联取消，装饰 history JSON 首条记录的落库副本并由 ChatMessage.request_id 公开，不得污染上游 prompt，不得用作计费幂等键。首字前定位同时匹配 request_id/turn/revision。旧客户端/旧行可选兼容。无新环境变量；producer-first 发布。

### 4. Validation & Error Matrix

- 非法 session/message UUID → 400；未鉴权 → 401；非本人/不存在会话 → session_not_found。
- 非当前回复 ID → 不改当前回复；重复取消返回实际状态。
- 完成先赢 → 返回 complete，保留正常计费；取消先赢 → interrupted，不扣星尘、不消费免费额度。
- 暂未确认取消 → CANCEL_PENDING，保持生成占用并允许重试；不是取消成功。
- 开轮后上下文/上游/落库异常 → 条件终态恢复；详情/开轮前回收超过 120 秒 streaming 并释放预留；开轮 RPC 陈旧阈值传 24 小时，避免历史 guard 在 120 秒临界绕过额度释放。

### 5. Good/Base/Bad Cases

- Good：取消标记锁定结果→停止上游→释放额度→终态→重新生成仍正确使用额度。
- Base：断网只断本地，重进详情恢复真实状态并可取消。
- Bad：仅浏览器 abort 或前端解禁；生成完成后再无条件覆盖 DB；进程 Map 作为跨副本取消事实来源。

### 6. Tests Required

CAS 取消先赢/完成先赢、重复/错误/非本人 ID、取消等待失败、额度释放后再允许重生成、旧 revision 不覆盖、prep 异常/残留恢复、上游挂流/缺 done。真实 TEST/Preview 与 Telegram、钱包/额度人工矩阵见任务 manual-regression.md，单测不替代实况。

### 7. Wrong vs Correct

Wrong：`controller.abort(); setGenerating(false)`，仍留下服务端 streaming。

Correct：绑定具体回复调用服务端取消，只有响应真实终态才清除本地占位；生成在计费前争抢没有取消标记的 streaming，取消先释放预留再收口。
